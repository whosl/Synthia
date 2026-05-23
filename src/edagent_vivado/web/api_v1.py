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
    context_packages_for_run, context_packages_for_session,
    retrieval_audits_for_run, retrieval_audits_for_session,
    retrieval_audit_get, retrieval_audit_items, usage_create,
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

# Tool runs rejected at approval gate (run_id -> True)
_blocked_tool_runs: dict[str, bool] = {}

def event_create(session_id: str, event_type: str, payload: dict, **kwargs) -> dict:  # type: ignore[no-redef]
    """Persist an event and publish it to live SSE subscribers."""
    evt = _store_event_create(session_id, event_type, payload, **kwargs)
    _publish(session_id, evt)
    return evt


async def _flush_pending_file_batch(
    session_id: str,
    task_id: str,
    run: dict,
    t: dict,
) -> str | None:
    """If file ops were queued, create one approval interaction and wait. Returns tool output or None."""
    from edagent_vivado.harness.interaction import (
        take_file_batch,
        create_interaction,
        wait_for_response,
        InteractionType,
    )
    files, title, message = take_file_batch(session_id, task_id)
    if not files:
        return None
    interaction = create_interaction(
        InteractionType.APPROVAL,
        session_id,
        task_id,
        title=title,
        message=message,
        files=files,
    )
    event_create(
        session_id,
        "interaction.requested",
        interaction.to_dict(),
        task_id=task_id,
        run_id=run["id"],
    )
    responded = await wait_for_response(interaction.id)
    if not responded:
        return "TIMEOUT: No user response"
    if responded.interaction_type != InteractionType.APPROVAL:
        return json.dumps(responded.response, ensure_ascii=False)
    if responded.status.value != "approved":
        from edagent_vivado.harness.approval_outcomes import SCOPE_FILE_CHANGES, format_user_rejection
        return format_user_rejection(SCOPE_FILE_CHANGES)
    from edagent_vivado.harness.approval_apply import apply_approved_files, format_approval_tool_output
    approved_paths = responded.response.get("approved_files") or [fi.path for fi in files]
    applied, skipped = apply_approved_files(files, approved_paths)
    return format_approval_tool_output(applied, skipped)


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
            from edagent_vivado.harness.run_context import set_agent_run_context
            set_agent_run_context(session_id, t["id"])
            full_response = ""
            continuation_msg: HumanMessage | None = None
            approval_round = 0
            max_approval_rounds = 6

            while approval_round < max_approval_rounds:
                inline_approval_results: list[str] = []
                tool_ids: dict[str, str] = {}
                agent_input = (
                    HumanMessage(content=ctx.prompt)
                    if approval_round == 0
                    else continuation_msg  # type: ignore[assignment]
                )
                async for evt in agent.astream_events(
                    {"messages": [agent_input]}, config=config, version="v2",
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
                        tool_name_start = evt.get("name", "")
                        tool_input = evt.get("data", {}).get("input", {})
                        # Flush batched file ops before any non-file tool; gate Vivado runs per invocation
                        if not is_patch_approved():
                            if tool_name_start not in ("create_file_tool", "propose_patch_tool"):
                                pre_flush = await _flush_pending_file_batch(session_id, t["id"], run, t)
                                if pre_flush:
                                    inline_approval_results.append(pre_flush)
                            if tool_name_start == "run_vivado_synth_tool":
                                from edagent_vivado.harness.interaction import (
                                    create_interaction,
                                    wait_for_response,
                                    InteractionType,
                                )
                                from edagent_vivado.harness.vivado_run_gate import (
                                    begin_vivado_run_gate,
                                    resolve_vivado_run_gate,
                                )
                                begin_vivado_run_gate(t["id"])
                                manifest = tool_input.get("manifest_path", "")
                                interaction = create_interaction(
                                    InteractionType.APPROVAL,
                                    session_id,
                                    t["id"],
                                    title="Run Vivado Synthesis",
                                    message=f"Allow running Vivado synthesis?\nManifest: {manifest}",
                                    files=[],
                                )
                                event_create(
                                    session_id,
                                    "interaction.requested",
                                    interaction.to_dict(),
                                    task_id=t["id"],
                                    run_id=run["id"],
                                )
                                responded = await wait_for_response(interaction.id)
                                approved = bool(
                                    responded and responded.status.value == "approved"
                                )
                                resolve_vivado_run_gate(t["id"], approved)
                                run_key = str(evt.get("run_id", ""))
                                if not approved and run_key:
                                    _blocked_tool_runs[run_key] = True
                        args_str = json.dumps(tool_input, ensure_ascii=False, default=str)[:1500]
                        tc = toolcall_create(run_id=run["id"], tool_name=evt["name"], session_id=session_id, task_id=t["id"],
                                             input_summary=args_str)
                        tool_ids[evt.get("run_id", tc["id"])] = tc["id"]
                        event_create(session_id, "tool.started", {"tool_name": evt["name"], "toolcall_id": tc["id"], "args": args_str},
                                     task_id=t["id"], run_id=run["id"])
                    elif kind == "on_tool_end":
                        output = str(evt.get("data", {}).get("output", ""))[:2500]
                        tcid = tool_ids.get(evt.get("run_id", ""), "")
                        tool_name = evt.get("name", "")
                        run_key = str(evt.get("run_id", ""))
                        if _blocked_tool_runs.pop(run_key, False):
                            from edagent_vivado.harness.approval_outcomes import (
                                SCOPE_VIVADO_SYNTH,
                                format_user_rejection,
                            )
                            output = format_user_rejection(
                                SCOPE_VIVADO_SYNTH, tool_name=tool_name
                            )
                        # Intercept interaction tools — create interaction and wait for user
                        elif tool_name in ("request_approval", "request_user_input", "create_file_tool", "propose_patch_tool") and not is_patch_approved():
                            from edagent_vivado.harness.interaction import (
                                create_interaction, wait_for_response, InteractionType, FileItem, InputField,
                                append_file_to_batch, take_file_batch,
                            )
                            tool_input = evt.get("data", {}).get("input", {})
                            if tool_name in ("create_file_tool", "propose_patch_tool"):
                                if tool_name == "create_file_tool":
                                    fi = FileItem(
                                        path=tool_input.get("file_path", ""),
                                        content=tool_input.get("content", ""),
                                        description=tool_input.get("description", ""),
                                        action="create",
                                    )
                                    title = "Create File"
                                    message = tool_input.get("description", f"Create {tool_input.get('file_path', '')}")
                                else:
                                    fi = FileItem(
                                        path=tool_input.get("file_path", ""),
                                        content=(
                                            f"--- OLD ---\n{tool_input.get('old_text', '')}\n"
                                            f"--- NEW ---\n{tool_input.get('new_text', '')}"
                                        ),
                                        description=tool_input.get("description", ""),
                                        action="modify",
                                    )
                                    title = "Modify File"
                                    message = tool_input.get("description", f"Modify {tool_input.get('file_path', '')}")
                                n = append_file_to_batch(session_id, t["id"], fi, title=title, message=message)
                                output = f"QUEUED_FOR_APPROVAL ({n} file(s) in batch)"
                            elif tool_name == "request_approval":
                                batched, batch_title, batch_msg = take_file_batch(session_id, t["id"])
                                extra = [
                                    FileItem(
                                        path=f.get("path", ""),
                                        content=f.get("content", ""),
                                        description=f.get("description", ""),
                                        action=f.get("action", "create"),
                                    )
                                    for f in (tool_input.get("files") or [])
                                ]
                                files = batched + extra
                                interaction = create_interaction(
                                    InteractionType.APPROVAL, session_id, t["id"],
                                    title=tool_input.get("title", batch_title or "File Approval Required"),
                                    message=tool_input.get("message", batch_msg),
                                    files=files,
                                )
                                event_create(session_id, "interaction.requested", interaction.to_dict(),
                                             task_id=t["id"], run_id=run["id"])
                                responded = await wait_for_response(interaction.id)
                                if responded:
                                    if responded.interaction_type == InteractionType.APPROVAL:
                                        if responded.status.value == "approved":
                                            from edagent_vivado.harness.approval_apply import (
                                                apply_approved_files,
                                                format_approval_tool_output,
                                            )
                                            approved_paths = responded.response.get("approved_files") or [fi.path for fi in files]
                                            applied, skipped = apply_approved_files(files, approved_paths)
                                            output = format_approval_tool_output(applied, skipped)
                                        else:
                                            from edagent_vivado.harness.approval_outcomes import (
                                                SCOPE_FILE_CHANGES,
                                                format_user_rejection,
                                            )
                                            output = format_user_rejection(SCOPE_FILE_CHANGES)
                                    else:
                                        from edagent_vivado.harness.interaction import InteractionStatus
                                        from edagent_vivado.harness.approval_outcomes import (
                                            OUTCOME_APPROVED,
                                            SCOPE_INPUT_REQUEST,
                                            format_tool_outcome,
                                            format_user_rejection,
                                        )
                                        if responded.status == InteractionStatus.REJECTED:
                                            output = format_user_rejection(SCOPE_INPUT_REQUEST)
                                        else:
                                            resp = responded.response if isinstance(responded.response, dict) else {}
                                            output = format_tool_outcome(
                                                OUTCOME_APPROVED,
                                                "User submitted the requested information.",
                                                scope=SCOPE_INPUT_REQUEST,
                                                ran=False,
                                                success=True,
                                                extra=resp,
                                            )
                                else:
                                    output = "TIMEOUT: No user response"
                            else:
                                await _flush_pending_file_batch(session_id, t["id"], run, t)
                                fields = [InputField(id=f.get("id",""), label=f.get("label",""),
                                                    field_type=f.get("field_type","text"),
                                                    options=f.get("options"), placeholder=f.get("placeholder",""),
                                                    recommendations=f.get("recommendations"), required=f.get("required",True))
                                          for f in (tool_input.get("fields") or [])]
                                interaction = create_interaction(
                                    InteractionType.INPUT_REQUEST, session_id, t["id"],
                                    title=tool_input.get("title", "Information Required"),
                                    message=tool_input.get("message", ""),
                                    fields=fields,
                                )
                                event_create(session_id, "interaction.requested", interaction.to_dict(),
                                             task_id=t["id"], run_id=run["id"])
                                responded = await wait_for_response(interaction.id)
                                if responded:
                                    output = json.dumps(responded.response, ensure_ascii=False)
                                else:
                                    output = "TIMEOUT: No user response"
                        if tcid:
                            from edagent_vivado.harness.approval_outcomes import tool_ui_state_from_output
                            ui_state = tool_ui_state_from_output(output)
                            toolcall_update(
                                tcid,
                                state="completed" if ui_state != "error" else "error",
                                finished_at=int(time.time()),
                                output_summary=output[:500],
                            )
                            event_create(
                                session_id,
                                "tool.completed",
                                {
                                    "tool_name": tool_name,
                                    "toolcall_id": tcid,
                                    "result": output[:500],
                                    "state": ui_state,
                                },
                                task_id=t["id"],
                                run_id=run["id"],
                            )
                            if output and ui_state in ("completed", "error", "rejected"):
                                from edagent_vivado.harness.problem_collector import (
                                    collect_from_tool_output,
                                    record_problems,
                                )

                                probs = collect_from_tool_output(tool_name, output)
                                if probs:
                                    record_problems(
                                        session_id,
                                        probs,
                                        task_id=t["id"],
                                        run_id=run["id"] if run else "",
                                        event_sink=lambda et, pl: event_create(
                                            session_id, et, pl, task_id=t["id"], run_id=run["id"] if run else ""
                                        ),
                                    )
                        if (
                            tool_name in ("request_approval", "request_user_input", "create_file_tool", "propose_patch_tool")
                            and output
                            and not is_patch_approved()
                        ):
                            from edagent_vivado.harness.approval_apply import should_continue_after_approval
                            if should_continue_after_approval(output) or output.startswith("{"):
                                inline_approval_results.append(output)
                    elif kind in ("on_chat_model_end", "on_llm_end"):
                        usage_meta = {}
                        data = evt.get("data") or {}
                        output = data.get("output")
                        if output is not None:
                            usage_meta = getattr(output, "usage_metadata", None) or {}
                            if not usage_meta and hasattr(output, "response_metadata"):
                                usage_meta = (output.response_metadata or {}).get("usage") or {}
                        if not usage_meta:
                            usage_meta = data.get("usage_metadata") or data.get("usage") or {}
                        inp = int(usage_meta.get("input_tokens") or usage_meta.get("prompt_tokens") or 0)
                        out_tok = int(usage_meta.get("output_tokens") or usage_meta.get("completion_tokens") or 0)
                        if (inp or out_tok) and run:
                            model_name = _os.environ.get("EDAGENT_MODEL", "unknown")
                            usage_create(
                                run_id=run["id"],
                                model=model_name,
                                session_id=session_id,
                                task_id=t["id"],
                                provider="anthropic_compatible",
                                model_role="primary",
                                input_tokens=inp,
                                output_tokens=out_tok,
                                total_tokens=inp + out_tok,
                                usage_source="provider" if inp else "estimated",
                            )
                            event_create(
                                session_id,
                                "llm.usage",
                                {"input_tokens": inp, "output_tokens": out_tok, "model": model_name},
                                task_id=t["id"],
                                run_id=run["id"],
                            )
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

                # End of one agent round — flush any queued file approvals
                flush_output = None
                if not is_patch_approved():
                    flush_output = await _flush_pending_file_batch(session_id, t["id"], run, t)

                from edagent_vivado.harness.approval_apply import (
                    should_continue_after_approval,
                    continuation_prompt,
                )
                follow_up = flush_output or (inline_approval_results[-1] if inline_approval_results else "")
                if follow_up and should_continue_after_approval(follow_up) and approval_round < max_approval_rounds - 1:
                    continuation_msg = HumanMessage(content=continuation_prompt(follow_up))
                    approval_round += 1
                    event_create(
                        session_id,
                        "agent.continuation",
                        {"reason": "approval_completed", "approval_output": follow_up[:500]},
                        task_id=t["id"],
                        run_id=run["id"],
                    )
                    continue
                break

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

@router.get("/sessions/{session_id}/context")
async def api_session_context(session_id: str, task_id: str = ""):
    """Latest context packages and retrieval audits for Terminal debug / Monitor."""
    tid = task_id.strip()
    if not tid:
        active = task_active_for_session(session_id)
        if active:
            tid = active.get("id") or ""
    packages = context_packages_for_session(session_id, task_id=tid, limit=3)
    audits = retrieval_audits_for_session(session_id, task_id=tid, limit=3)
    enriched = [{"package": p, "items": context_package_items(p["id"])} for p in packages]
    enriched_audits = [{"audit": a, "items": retrieval_audit_items(a["id"])} for a in audits]
    return {"contexts": enriched, "retrieval_audits": enriched_audits, "task_id": tid or None}

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

# ── Interaction API (Human-in-the-loop) ────────────────────

@router.get("/sessions/{session_id}/interactions")
async def api_interactions(session_id: str):
    from edagent_vivado.harness.interaction import get_pending_for_session, rehydrate_session_interactions
    rehydrate_session_interactions(session_id)
    pending = get_pending_for_session(session_id)
    return {"interactions": [i.to_dict() for i in pending]}

@router.get("/interactions/{interaction_id}")
async def api_interaction_detail(interaction_id: str):
    from edagent_vivado.harness.interaction import get_interaction
    interaction = get_interaction(interaction_id)  # rehydrates from events if needed
    if not interaction:
        raise HTTPException(404, "Interaction not found")
    return interaction.to_dict()

@router.post("/interactions/{interaction_id}/respond")
async def api_interaction_respond(interaction_id: str, request: Request):
    from edagent_vivado.harness.interaction import get_interaction, respond_interaction
    body = await request.json()
    interaction = get_interaction(interaction_id)
    if not interaction:
        raise HTTPException(404, "Interaction not found")
    result = respond_interaction(interaction_id, body, session_id=interaction.session_id)
    if not result:
        raise HTTPException(500, "Failed to process response")
    # Emit event
    event_type = "interaction.approved" if result.status.value == "approved" else (
        "interaction.rejected" if result.status.value == "rejected" else "interaction.responded"
    )
    event_create(interaction.session_id, event_type, {
        **result.to_dict(),
        "interaction_id": interaction_id,
        "response": body,
    }, task_id=interaction.task_id)
    return {"ok": True, "interaction": result.to_dict()}

# ── Vivado Health API ────────────────────────────────────────

@router.get("/health/vivado")
async def api_vivado_health():
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter

    hc = VivadoRuntimeAdapter().health_check()
    return {
        "target": hc.get("target_id", "default-remote"),
        "host": hc.get("host", ""),
        "reachable": hc.get("reachable", False),
        "vivado_path": hc.get("vivado_path", ""),
        "version": hc.get("version"),
        "error": hc.get("error"),
    }

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
    return {"commands": []}

@router.post("/knowledge/reindex")
async def api_knowledge_reindex():
    from edagent_vivado.knowledge.semantic_kb import reindex_global

    return reindex_global()

@router.post("/knowledge/search")
async def api_knowledge_search(request: Request):
    body = await request.json()
    query = str(body.get("query", ""))
    top_k = int(body.get("top_k", 12))
    from edagent_vivado.knowledge.semantic_kb import search_semantic_kb

    text, hits = search_semantic_kb(query, top_k=top_k)
    return {"query": query, "results": hits, "formatted": text}

@router.get("/vivado/devices")
async def api_vivado_devices():
    """Query available FPGA devices from connected Vivado instance."""
    import subprocess, os
    host = _os.environ.get("VIVADO_REMOTE_HOST", "")
    key = _os.environ.get("VIVADO_REMOTE_KEY", "")
    port = _os.environ.get("VIVADO_REMOTE_PORT", "")
    env_script = _os.environ.get("VIVADO_REMOTE_ENV", "")
    vivado_path = _os.environ.get("VIVADO_REMOTE_PATH", "vivado")

    tcl_cmd = "foreach p [get_parts] { puts $p }; exit"
    if host:
        ssh = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"]
        if key: ssh += ["-i", key]
        if port: ssh += ["-p", str(port)]
        ssh.append(host)
        env_prefix = f"source {env_script} 2>/dev/null && " if env_script else ""
        cmd = f'{env_prefix}{vivado_path} -mode batch -nojournal -nolog -tclargs <<< "{tcl_cmd}"'
        try:
            p = subprocess.run(ssh + [cmd], capture_output=True, text=True, timeout=30)
            parts = [line.strip() for line in p.stdout.splitlines()
                     if line.strip() and not line.startswith("***") and not line.startswith("INFO")
                     and not line.startswith("Vivado") and "Copyright" not in line]
            return {"devices": [{"value": part, "label": part} for part in sorted(parts) if part]}
        except Exception as e:
            return {"devices": [], "error": str(e)}
    return {"devices": [], "error": "No Vivado target configured"}

@router.post("/vivado/commands/tcl")
async def api_vivado_run_tcl(request: Request):
    body = await request.json()
    command = body.get("command", "")
    target_id = body.get("target_id")
    auto_approved = body.get("auto_approved", False)
    if not command:
        raise HTTPException(400, "command is required")
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter, get_target
    target = get_target(target_id)
    adapter = VivadoRuntimeAdapter(target)
    policy = adapter.check_policy(command, auto_approved=auto_approved)
    if not policy.allowed:
        return JSONResponse({"ok": False, "error": f"Denied: {policy.reason}", "policy": {"allowed": False, "reason": policy.reason}}, status_code=403)
    if policy.requires_approval:
        return JSONResponse({"ok": False, "requires_approval": True, "reason": policy.reason, "matched_rules": policy.matched_rules}, status_code=403)
    result = adapter.run_tcl(command, auto_approved=True)
    return {"ok": result.success, "exit_code": result.exit_code, "stdout": result.stdout[:5000],
            "stderr": result.stderr[:2000], "elapsed_sec": result.elapsed_sec, "error": result.error}

@router.post("/vivado/commands/script")
async def api_vivado_run_script(request: Request):
    body = await request.json()
    script = body.get("script", "")
    target_id = body.get("target_id")
    auto_approved = body.get("auto_approved", False)
    if not script:
        raise HTTPException(400, "script is required")
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter, get_target
    target = get_target(target_id)
    adapter = VivadoRuntimeAdapter(target)
    policy = adapter.check_script_policy(script, auto_approved=auto_approved)
    if not policy.allowed:
        return JSONResponse({"ok": False, "error": f"Denied: {policy.reason}", "policy": {"allowed": False, "reason": policy.reason}}, status_code=403)
    if policy.requires_approval:
        return JSONResponse({"ok": False, "requires_approval": True, "reason": policy.reason, "matched_rules": policy.matched_rules}, status_code=403)
    result = adapter.run_script(script, auto_approved=True)
    return {"ok": result.success, "exit_code": result.exit_code, "stdout": result.stdout[:5000],
            "stderr": result.stderr[:2000], "elapsed_sec": result.elapsed_sec, "error": result.error}
