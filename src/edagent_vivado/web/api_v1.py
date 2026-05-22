"""Phase 1 REST API — sessions, tasks, messages, events, stream, monitor, vivado health."""

from __future__ import annotations
import json, asyncio, time, os as _os
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

from edagent_vivado.repository.store import (
    session_list, session_get, session_create, session_update, session_delete,
    message_list, message_create,
    task_create, task_get, task_update, task_active_for_session,
    event_create, event_list,
    run_create, run_update, run_list, run_get,
    toolcall_create, toolcall_update, toolcall_list, usage_list,
    event_list_for_run, artifact_list, problem_list,
    memory_latest, memory_list, context_package_get, context_package_items,
    context_packages_for_run, retrieval_audits_for_run, retrieval_audit_get,
    retrieval_audit_items,
)
from edagent_vivado.repository.db import get_db
from edagent_vivado.tools.patch_tools import set_patch_approval, is_patch_approved

router = APIRouter(prefix="/api/v1")

# ── In-memory SSE queues ─────────────────────────────────────

_stream_queues: dict[str, list[asyncio.Queue]] = {}

def _publish(session_id: str, event: dict) -> None:
    """Push event to all active SSE subscribers for a session."""
    payload = json.dumps(event, ensure_ascii=False)
    data = f"id: {session_id}:{event.get('seq',0)}\nevent: {event['event_type']}\ndata: {payload}\n\n"
    for q in _stream_queues.get(session_id, []):
        try: q.put_nowait(data)
        except asyncio.QueueFull: pass

_store_event_create = event_create

def event_create(session_id: str, event_type: str, payload: dict, **kwargs) -> dict:  # type: ignore[no-redef]
    """Persist an event and publish it to live SSE subscribers."""
    evt = _store_event_create(session_id, event_type, payload, **kwargs)
    _publish(session_id, evt)
    return evt

# ── Session API ──────────────────────────────────────────────

class CreateSessionReq(BaseModel):
    name: str = ""
    manifest_path: str = ""
    metadata: dict | None = None

@router.get("/sessions")
async def api_sessions(status: str | None = None, limit: int = 50):
    return {"sessions": session_list(status=status, limit=limit)}

@router.post("/sessions")
async def api_sessions_create(req: CreateSessionReq):
    s = session_create(name=req.name, manifest_path=req.manifest_path, metadata=req.metadata)
    event_create(s["id"], "session.created", {"name": s["name"]})
    return {"session": s}

@router.get("/sessions/{session_id}")
async def api_session_get(session_id: str):
    s = session_get(session_id)
    if not s: raise HTTPException(404, "session not found")
    return {"session": s}

@router.patch("/sessions/{session_id}")
async def api_session_update(session_id: str, body: dict):
    allowed = {"name", "status", "metadata_json"}
    updates = {k: v for k, v in body.items() if k in allowed}
    s = session_update(session_id, **updates)
    if not s: raise HTTPException(404)
    event_create(session_id, "session.updated", updates)
    return {"session": s}

@router.delete("/sessions/{session_id}")
async def api_session_delete(session_id: str, hard: bool = False):
    session_delete(session_id, hard=hard)
    event_type = "session.archived" if not hard else "session.deleted"
    try: event_create(session_id, event_type, {"hard": hard})
    except: pass
    return {"ok": True}

# ── Message API ──────────────────────────────────────────────

@router.get("/sessions/{session_id}/messages")
async def api_messages(session_id: str, before: int | None = None, limit: int = 100):
    return {"messages": message_list(session_id, before=before, limit=limit)}

# ── Task API ─────────────────────────────────────────────────

class StartTaskReq(BaseModel):
    question: str
    manifest_path: str = ""
    agent_mode: str = "single"
    metadata: dict | None = None

@router.post("/sessions/{session_id}/tasks")
async def api_task_start(session_id: str, req: StartTaskReq):
    active = task_active_for_session(session_id)
    if active:
        return JSONResponse({
            "error": "session_task_running", "session_id": session_id,
            "task_id": active["id"], "state": active["state"],
        }, status_code=409)
    # Save user message
    msg = message_create(session_id, "user", req.question)
    event_create(session_id, "message.user.created", {"message_id": msg["id"], "text": req.question})
    # Create task
    t = task_create(session_id, msg["id"])
    task_update(t["id"], state="running", updated_at=int(time.time()))
    session_update(session_id, status="running")
    event_create(session_id, "task.created", {"task_id": t["id"]}, task_id=t["id"])
    event_create(session_id, "task.started", {"task_id": t["id"]}, task_id=t["id"])

    # Start agent in background
    from edagent_vivado.agent.graph import create_agent
    from langchain_core.messages import HumanMessage

    async def _run_agent():
        run = None
        try:
            run = run_create("task", f"task:{t['id']}", session_id=session_id, task_id=t["id"])
            event_create(session_id, "run.started", {"run_id": run["id"], "run_type": "task"},
                         task_id=t["id"], run_id=run["id"])
            from edagent_vivado.agent.context import build_agent_context
            ctx = build_agent_context(
                session_id=session_id,
                task_id=t["id"],
                run_id=run["id"],
                question=req.question,
                manifest_path=req.manifest_path,
            )
            event_create(session_id, "context.package.created", {
                "context_package_id": ctx.context_package["id"],
                "retrieval_audit_id": ctx.retrieval_audit["id"] if ctx.retrieval_audit else None,
                "token_counts": ctx.token_counts,
            }, task_id=t["id"], run_id=run["id"])
            agent = create_agent()
            config = {"configurable": {"thread_id": f"session:{session_id}"}, "recursion_limit": 1000}
            full_response = ""
            tool_ids: dict[str, str] = {}
            async for evt in agent.astream_events(
                {"messages": [HumanMessage(content=ctx.prompt)]}, config=config, version="v2",
            ):
                latest_task = task_get(t["id"])
                if latest_task and latest_task.get("stop_requested"):
                    if full_response:
                        message_create(session_id, "assistant", full_response, task_id=t["id"], stopped=True, partial=True)
                    task_update(t["id"], state="stopped", finished_at=int(time.time()))
                    session_update(session_id, status="idle")
                    if run: run_update(run["id"], state="stopped", finished_at=int(time.time()),
                                      elapsed_ms=int((time.time() - run["started_at"]) * 1000))
                    event_create(session_id, "message.assistant.stopped", {"text": full_response[-200:]},
                                 task_id=t["id"], run_id=run["id"])
                    event_create(session_id, "task.stopped", {"task_id": t["id"]}, task_id=t["id"], run_id=run["id"])
                    return
                kind = evt["event"]
                if kind == "on_tool_start":
                    tool_input = evt.get("data", {}).get("input", {})
                    args_str = json.dumps(tool_input, ensure_ascii=False, default=str)[:1500]
                    tc = toolcall_create(run_id=run["id"], tool_name=evt["name"], session_id=session_id, task_id=t["id"],
                                         input_summary=args_str)
                    tool_ids[evt.get("run_id", tc["id"])] = tc["id"]
                    event_create(session_id, "tool.started", {"tool_name": evt["name"], "toolcall_id": tc["id"], "args": args_str},
                                 task_id=t["id"], run_id=run["id"])
                elif kind == "on_tool_end":
                    output = str(evt.get("data", {}).get("output", ""))[:2500]
                    tcid = tool_ids.get(evt.get("run_id", ""), "")
                    if tcid:
                        toolcall_update(tcid, state="completed", finished_at=int(time.time()), output_summary=output)
                    event_create(session_id, "tool.completed", {"tool_name": evt["name"], "toolcall_id": tcid, "result": output},
                                 task_id=t["id"], run_id=run["id"])
                elif kind == "on_chat_model_stream":
                    chunk = evt["data"].get("chunk", {})
                    reasoning = ""
                    if hasattr(chunk, "additional_kwargs") and chunk.additional_kwargs:
                        reasoning = chunk.additional_kwargs.get("reasoning_content") or ""
                    if reasoning:
                        event_create(session_id, "reasoning.delta", {"text": reasoning},
                                     task_id=t["id"], run_id=run["id"])
                        continue
                    if hasattr(chunk, "content") and chunk.content:
                        c = chunk.content
                        text = ""
                        if isinstance(c, str): text = c
                        elif isinstance(c, list):
                            text = "".join(b.get("text","") for b in c if isinstance(b, dict) and b.get("type")=="text")
                        if text:
                            full_response += text
                            event_create(session_id, "message.assistant.delta", {"text": text},
                                         task_id=t["id"], run_id=run["id"])
            # Save assistant message
            if full_response:
                message_create(session_id, "assistant", full_response, task_id=t["id"])
                event_create(session_id, "message.assistant.completed", {"text": full_response[:200]},
                             task_id=t["id"], run_id=run["id"])
                from edagent_vivado.agent.summary import get_summary_model
                previous = memory_latest(session_id)
                recent = message_list(session_id, limit=20)
                summary = await get_summary_model().summarize_session(
                    previous.get("summary", "") if previous else "",
                    recent,
                    [tc.get("output_summary") or tc.get("input_summary") or tc.get("tool_name") for tc in toolcall_list(run_id=run["id"])],
                )
                from edagent_vivado.repository.store import memory_create
                latest_event_seq = event_list(session_id, after_seq=0, limit=1_000_000)[-1]["seq"]
                mem = memory_create(session_id, summary.summary, task_id=t["id"], summary_model=summary.model,
                                    source_message_until=recent[-1]["id"] if recent else "",
                                    source_event_until_seq=latest_event_seq)
                event_create(session_id, "memory.updated", {"memory_id": mem["id"], "summary": summary.summary[:240]},
                             task_id=t["id"], run_id=run["id"])
            # Complete
            task_update(t["id"], state="done", finished_at=int(time.time()))
            session_update(session_id, status="idle")
            if run: run_update(run["id"], state="done", finished_at=int(time.time()),
                              elapsed_ms=int((time.time() - run["started_at"]) * 1000))
            event_create(session_id, "run.completed", {"run_id": run["id"] if run else None},
                         task_id=t["id"], run_id=run["id"] if run else "")
            event_create(session_id, "task.done", {"task_id": t["id"]}, task_id=t["id"])
        except Exception as e:
            task_update(t["id"], state="error", error=str(e), finished_at=int(time.time()))
            session_update(session_id, status="error")
            if run: run_update(run["id"], state="error", error=str(e), finished_at=int(time.time()))
            if run:
                event_create(session_id, "run.error", {"run_id": run["id"], "error": str(e)}, task_id=t["id"], run_id=run["id"])
            event_create(session_id, "task.error", {"task_id": t["id"], "error": str(e)}, task_id=t["id"])

    asyncio.create_task(_run_agent())
    event_type = "task.started"  # noqa: F841

    return {"task_id": t["id"], "session_id": session_id, "state": "running",
            "stream_url": f"/api/v1/sessions/{session_id}/stream"}

@router.get("/tasks/{task_id}")
async def api_task_get(task_id: str):
    t = task_get(task_id)
    if not t: raise HTTPException(404)
    return {"task": t}

@router.get("/sessions/{session_id}/active-task")
async def api_active_task(session_id: str):
    t = task_active_for_session(session_id)
    return {"task": t}

@router.post("/tasks/{task_id}/stop")
@router.post("/sessions/{session_id}/stop")
async def api_task_stop(task_id: str = "", session_id: str = ""):
    if session_id and not task_id:
        t = task_active_for_session(session_id)
        if not t: raise HTTPException(404, "no active task")
        task_id = t["id"]
    task_update(task_id, stop_requested=1, state="stopping")
    event_create(session_id or task_get(task_id)["session_id"],
                 "task.stopping", {"task_id": task_id}, task_id=task_id)
    return {"ok": True, "task_id": task_id, "state": "stopping"}

# ── Event / Stream API ───────────────────────────────────────

@router.get("/sessions/{session_id}/events")
async def api_events(session_id: str, after_seq: int = 0, limit: int = 500):
    return {"events": event_list(session_id, after_seq=after_seq, limit=limit)}

@router.get("/sessions/{session_id}/stream")
async def api_stream(session_id: str, after_seq: int = 0):
    # Replay missed events first
    missed = event_list(session_id, after_seq=after_seq, limit=200)
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    _stream_queues.setdefault(session_id, []).append(queue)

    async def _stream():
        try:
            # Send missed events
            for evt in missed:
                p = json.dumps(evt, ensure_ascii=False, default=str)
                yield f"id: {session_id}:{evt['seq']}\nevent: {evt['event_type']}\ndata: {p}\n\n"
            # Stream live events
            while True:
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield data
                except asyncio.TimeoutError:
                    yield f": heartbeat\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            _stream_queues.get(session_id, []).remove(queue) if queue in _stream_queues.get(session_id, []) else None

    return StreamingResponse(_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

# ── Monitor API ──────────────────────────────────────────────

@router.get("/monitor/runs")
async def api_monitor_runs(session_id: str = "", limit: int = 50):
    return {"runs": run_list(session_id=session_id, limit=limit)}

@router.get("/monitor/runs/{run_id}")
async def api_monitor_run(run_id: str):
    r = run_get(run_id)
    if not r: raise HTTPException(404)
    return {"run": r, "toolcalls": toolcall_list(run_id=run_id), "usage": usage_list(run_id=run_id)}

@router.get("/monitor/runs/{run_id}/toolcalls")
async def api_monitor_toolcalls(run_id: str):
    return {"toolcalls": toolcall_list(run_id=run_id)}

@router.get("/monitor/runs/{run_id}/usage")
async def api_monitor_usage(run_id: str):
    return {"usage": usage_list(run_id=run_id)}

@router.get("/monitor/runs/{run_id}/events")
async def api_monitor_events(run_id: str, limit: int = 500):
    return {"events": event_list_for_run(run_id, limit=limit)}

@router.get("/monitor/runs/{run_id}/artifacts")
async def api_monitor_artifacts(run_id: str, limit: int = 100):
    return {"artifacts": artifact_list(run_id=run_id, limit=limit)}

@router.get("/monitor/runs/{run_id}/problems")
async def api_monitor_problems(run_id: str, limit: int = 100):
    return {"problems": problem_list(run_id=run_id, limit=limit)}

@router.get("/monitor/runs/{run_id}/context")
async def api_monitor_context(run_id: str):
    packages = context_packages_for_run(run_id)
    audits = retrieval_audits_for_run(run_id)
    enriched = []
    for pkg in packages:
        enriched.append({"package": pkg, "items": context_package_items(pkg["id"])})
    enriched_audits = []
    for audit in audits:
        enriched_audits.append({"audit": audit, "items": retrieval_audit_items(audit["id"])})
    return {"contexts": enriched, "retrieval_audits": enriched_audits}

@router.get("/monitor/sessions/{session_id}/runs")
async def api_monitor_session_runs(session_id: str, limit: int = 50):
    return {"runs": run_list(session_id=session_id, limit=limit)}

@router.get("/sessions/{session_id}/memory")
async def api_session_memory(session_id: str, limit: int = 20):
    return {"latest": memory_latest(session_id), "snapshots": memory_list(session_id, limit=limit)}

@router.get("/context-packages/{context_package_id}")
async def api_context_package(context_package_id: str):
    pkg = context_package_get(context_package_id)
    if not pkg: raise HTTPException(404)
    return {"package": pkg, "items": context_package_items(context_package_id)}

@router.get("/retrieval-audits/{audit_id}")
async def api_retrieval_audit(audit_id: str):
    audit = retrieval_audit_get(audit_id)
    if not audit: raise HTTPException(404)
    return {"audit": audit, "items": retrieval_audit_items(audit_id)}

# ── Approval API ─────────────────────────────────────────────

@router.get("/settings/patch-approval")
async def api_approval_get():
    return {"approved": is_patch_approved()}

@router.post("/settings/patch-approval")
async def api_approval_set(body: dict):
    approved = body.get("approved", not is_patch_approved())
    set_patch_approval(approved)
    return {"approved": approved}

# ── KB API ───────────────────────────────────────────────────

@router.get("/kb/cases")
async def api_kb_cases():
    from edagent_vivado.kb.error_case_loader import load_cases
    return {"cases": [
        {"id": f"builtin-{i}", "pattern": c.pattern, "category": c.category,
         "likely_causes": c.likely_causes, "suggested_actions": c.suggested_actions,
         "source": "builtin"}
        for i, c in enumerate(load_cases())
    ]}

@router.get("/kb/candidates")
async def api_kb_candidates(limit: int = 50):
    problems = problem_list(limit=limit)
    return {"candidates": [
        {"id": f"candidate-{p['id']}", "source_problem_id": p["id"], "source_run_id": p.get("run_id"),
         "source_session_id": p.get("session_id"),
         "pattern": p.get("signature") or p.get("normalized_signature") or p["message"][:80],
         "category": p.get("category") or "unclassified", "title": p["message"][:120],
         "confidence": 0.55, "status": "pending", "created_by": p.get("source") or "harness",
         "created_at": p.get("detected_at")}
        for p in problems
    ]}

@router.post("/kb/candidates/{candidate_id}/approve")
async def api_kb_candidate_approve(candidate_id: str):
    return {"ok": True, "candidate_id": candidate_id, "status": "approved"}

@router.post("/kb/candidates/{candidate_id}/reject")
async def api_kb_candidate_reject(candidate_id: str):
    return {"ok": True, "candidate_id": candidate_id, "status": "rejected"}

@router.post("/kb/candidates/{candidate_id}/merge")
async def api_kb_candidate_merge(candidate_id: str):
    return {"ok": True, "candidate_id": candidate_id, "status": "merged"}

# ── Vivado Health API ────────────────────────────────────────

@router.get("/health/vivado")
async def api_vivado_health():
    host = _os.environ.get("VIVADO_REMOTE_HOST", "")
    key = _os.environ.get("VIVADO_REMOTE_KEY", "")
    path = _os.environ.get("VIVADO_REMOTE_PATH", "vivado")
    env_script = _os.environ.get("VIVADO_REMOTE_ENV", "")

    result = {"target": "default-remote", "host": host, "reachable": False, "vivado_path": path, "version": None}

    if not host:
        result["error"] = "VIVADO_REMOTE_HOST not configured"
        return result

    import subprocess
    ssh = ["ssh", "-i", key, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", host]
    # Test SSH
    try:
        p = subprocess.run(ssh + ["echo OK"], capture_output=True, text=True, timeout=15)
        result["reachable"] = "OK" in p.stdout
    except: pass
    # Test Vivado version
    if result["reachable"] and env_script:
        try:
            cmd = f"source {env_script} 2>/dev/null && {path} -version 2>&1"
            p = subprocess.run(ssh + [cmd], capture_output=True, text=True, timeout=20)
            for line in p.stdout.split("\n"):
                if "Vivado v" in line:
                    result["version"] = line.strip()
                    break
        except: pass

    return result

@router.get("/vivado/targets")
async def api_vivado_targets():
    return {"targets": [{
        "id": "default-remote",
        "name": "default-remote",
        "target_type": "remote_ssh",
        "host": _os.environ.get("VIVADO_REMOTE_HOST", ""),
        "ssh_key_path": _os.environ.get("VIVADO_REMOTE_KEY", ""),
        "vivado_path": _os.environ.get("VIVADO_REMOTE_PATH", "vivado"),
        "settings_path": _os.environ.get("VIVADO_REMOTE_ENV", ""),
        "remote_work_root": _os.environ.get("VIVADO_REMOTE_WORK", "/tmp/edagent_remote"),
        "is_default": True,
        "enabled": True,
    }]}

@router.get("/vivado/commands")
async def api_vivado_commands(limit: int = 50):
    # Real command persistence lands in Phase 3A; expose compatible shape now.
    return {"commands": []}
