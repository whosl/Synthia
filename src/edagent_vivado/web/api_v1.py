"""Phase 1 REST API — sessions, tasks, messages, events, stream, monitor, vivado health."""

from __future__ import annotations
import json, asyncio, time, os as _os
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

from edagent_vivado.projects.validate import ProjectValidationError, validate_project_paths
from edagent_vivado.projects.snapshot import snapshot_manifest_path
from edagent_vivado.repository.store import (
    project_list, project_get, project_create, project_update, project_delete,
    project_is_archived,
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
    retrieval_audit_get, retrieval_audit_items, usage_create, usage_totals_for_session,
    monitor_overview, monitor_retention_cleanup,
    kb_candidate_list, kb_candidate_get, kb_candidate_approve, kb_candidate_reject, kb_candidate_merge,
    vivado_command_list, knowledge_source_list,
)
from edagent_vivado.repository.db import get_db
from edagent_vivado.tools.patch_tools import set_patch_approval, is_patch_approved
from edagent_vivado.harness.execution_approval import (
    set_vivado_execution_approval,
    is_vivado_execution_approved,
)
from edagent_vivado.harness.file_patch_policy import (
    is_file_patch_tool,
    is_file_tool_queued_for_approval,
    is_interaction_tool,
)
from edagent_vivado.events.envelope import enrich_wire_event
from edagent_vivado.events.catalog import ALL_WIRE_EVENT_TYPES, PROTOCOL_VERSION

router = APIRouter(prefix="/api/v1")

# ── In-memory SSE queues ─────────────────────────────────────

_stream_queues: dict[str, list[asyncio.Queue]] = {}

def _publish(session_id: str, event: dict) -> None:
    """Push event to all active SSE subscribers for a session."""
    wire = enrich_wire_event(event)
    payload = json.dumps(wire, ensure_ascii=False, default=str)
    data = f"id: {session_id}:{wire.get('seq',0)}\nevent: {wire['event_type']}\ndata: {payload}\n\n"
    for q in _stream_queues.get(session_id, []):
        try: q.put_nowait(data)
        except asyncio.QueueFull: pass

_store_event_create = event_create

# Tool runs rejected at Vivado approval gate (langgraph run_id -> outcome scope)
_blocked_tool_runs: dict[str, str] = {}
# Vivado approval rejected before/during langgraph tool invocation
_early_blocked_tool_runs: set[str] = set()
_early_completed_toolcall_ids: set[str] = set()
_vivado_reject_run_keys: set[str] = set()


def _langgraph_tool_run_key(evt: dict) -> str:
    return str(evt.get("run_id") or (evt.get("data") or {}).get("run_id") or "")

def event_create(session_id: str, event_type: str, payload: dict, **kwargs) -> dict:  # type: ignore[no-redef]
    """Persist an event and publish it to live SSE subscribers."""
    evt = enrich_wire_event(_store_event_create(session_id, event_type, payload, **kwargs))
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
    from edagent_vivado.harness.approval_payload import (
        build_file_approval_payload,
        payload_to_reason_json,
    )
    payload = build_file_approval_payload(
        title,
        message,
        [{"path": f.path, "description": f.description, "action": f.action} for f in files],
    )
    interaction = create_interaction(
        InteractionType.APPROVAL,
        session_id,
        task_id,
        title=title,
        message="",
        reason=payload_to_reason_json(payload),
        files=files,
    )
    event_create(
        session_id,
        "interaction.requested",
        interaction.to_dict(),
        task_id=task_id,
        run_id=run["id"],
    )
    responded = await wait_for_response(interaction.id, task_id=task_id)
    if not responded:
        from edagent_vivado.repository.store import task_get

        stopped = task_get(task_id)
        if stopped and stopped.get("stop_requested"):
            from edagent_vivado.harness.approval_outcomes import SCOPE_FILE_CHANGES, format_user_rejection

            return format_user_rejection(SCOPE_FILE_CHANGES, detail="Task stopped by user.")
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


# ── Project API ──────────────────────────────────────────────

class CreateProjectReq(BaseModel):
    name: str
    root_path: str
    manifest_path: str
    xpr_path: str = ""
    part: str | None = None
    board_part: str | None = None
    top_module: str | None = None
    target_language: str | None = None
    simulator: str | None = None
    source_globs: list[str] | None = None
    constraint_globs: list[str] | None = None
    tcl_globs: list[str] | None = None
    default_vivado_target_id: str | None = None
    metadata: dict | None = None


class CreateSessionReq(BaseModel):
    name: str = ""
    project_id: str = ""
    manifest_path: str = ""
    metadata: dict | None = None


@router.get("/projects")
async def api_projects(status: str | None = None, limit: int = 100, include_archived: bool = False):
    return {"projects": project_list(status=status, limit=limit, include_archived=include_archived)}


@router.post("/projects")
async def api_projects_create(req: CreateProjectReq):
    try:
        validated = validate_project_paths(
            root_path=req.root_path,
            manifest_path=req.manifest_path,
            xpr_path=req.xpr_path,
            part=req.part,
            board_part=req.board_part,
        )
    except ProjectValidationError as exc:
        raise HTTPException(400, str(exc)) from exc
    top = (req.top_module or "").strip() or validated.get("top_module")
    fields = {
        "name": req.name.strip() or Path(req.root_path).name,
        "root_path": validated["root_path"],
        "manifest_path": validated["manifest_path"],
        "xpr_path": validated["xpr_path"],
        "part": validated.get("part"),
        "board_part": validated.get("board_part"),
        "top_module": top,
        "target_language": req.target_language,
        "simulator": req.simulator,
        "source_globs": req.source_globs,
        "constraint_globs": req.constraint_globs,
        "tcl_globs": req.tcl_globs,
        "default_vivado_target_id": req.default_vivado_target_id,
        "metadata": {**(req.metadata or {}), "flow": validated.get("flow")},
    }
    p = project_create(fields)
    kb_index = None
    try:
        from edagent_vivado.knowledge.semantic_kb import reindex_project_record

        kb_index = reindex_project_record(p)
    except Exception as exc:
        kb_index = {"error": str(exc)}
    return {"project": p, "kb_index": kb_index}


@router.get("/projects/{project_id}")
async def api_project_get(project_id: str):
    p = project_get(project_id)
    if not p:
        raise HTTPException(404, "project not found")
    return {"project": p}


class UpdateProjectReq(BaseModel):
    name: str | None = None
    status: str | None = None
    root_path: str | None = None
    manifest_path: str | None = None
    xpr_path: str | None = None
    part: str | None = None
    board_part: str | None = None
    top_module: str | None = None
    target_language: str | None = None
    simulator: str | None = None
    source_globs: list[str] | None = None
    constraint_globs: list[str] | None = None
    tcl_globs: list[str] | None = None
    default_vivado_target_id: str | None = None
    metadata: dict | None = None


@router.patch("/projects/{project_id}")
async def api_project_update(project_id: str, req: UpdateProjectReq):
    existing = project_get(project_id)
    if not existing:
        raise HTTPException(404, "project not found")
    updates = req.model_dump(exclude_unset=True)
    if any(k in updates for k in ("root_path", "manifest_path", "xpr_path", "part", "board_part")):
        try:
            validated = validate_project_paths(
                root_path=updates.get("root_path") or existing["root_path"],
                manifest_path=updates.get("manifest_path") or existing["manifest_path"],
                xpr_path=updates.get("xpr_path", existing.get("xpr_path") or ""),
                part=updates.get("part") or existing.get("part"),
                board_part=updates.get("board_part") or existing.get("board_part"),
            )
        except ProjectValidationError as exc:
            raise HTTPException(400, str(exc)) from exc
        updates["root_path"] = validated["root_path"]
        updates["manifest_path"] = validated["manifest_path"]
        updates["xpr_path"] = validated["xpr_path"]
        updates["part"] = validated.get("part")
        updates["board_part"] = validated.get("board_part")
        if validated.get("top_module") and not updates.get("top_module"):
            updates["top_module"] = validated.get("top_module")
    meta = updates.pop("metadata", None)
    if meta is not None:
        prev = {}
        try:
            prev = json.loads(existing.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            prev = {}
        updates["metadata_json"] = json.dumps({**prev, **meta})
    for glob_key in ("source_globs", "constraint_globs", "tcl_globs"):
        if glob_key in updates:
            updates[f"{glob_key}_json"] = json.dumps(updates.pop(glob_key) or [])
    p = project_update(project_id, **updates)
    if not p:
        raise HTTPException(404, "project not found")
    return {"project": p}


@router.get("/projects/{project_id}/summary")
async def api_project_summary(project_id: str):
    from edagent_vivado.projects.lifecycle import project_summary

    try:
        return project_summary(project_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/projects/{project_id}/reindex")
async def api_project_reindex(project_id: str):
    project = project_get(project_id)
    if not project:
        raise HTTPException(404, "project not found")
    from edagent_vivado.knowledge.semantic_kb import reindex_project_record

    return reindex_project_record(project)


@router.delete("/projects/{project_id}")
async def api_project_delete(project_id: str, hard: bool = False, confirm: str = ""):
    project = project_get(project_id)
    if not project:
        raise HTTPException(404, "project not found")
    if hard:
        expected = str(project.get("name") or project_id)
        if confirm != expected:
            raise HTTPException(
                400,
                f"hard delete requires confirm={expected!r} query parameter",
            )
    project_delete(project_id, hard=hard)
    return {"ok": True, "hard": hard}


@router.get("/projects/{project_id}/sessions")
async def api_project_sessions(
    project_id: str,
    status: str | None = None,
    limit: int = 50,
    include_archived: bool = False,
):
    if not project_get(project_id):
        raise HTTPException(404, "project not found")
    return {
        "sessions": session_list(
            status=status,
            limit=limit,
            project_id=project_id,
            include_archived=include_archived,
        ),
    }


@router.post("/projects/{project_id}/sessions")
async def api_project_sessions_create(project_id: str, req: CreateSessionReq):
    project = project_get(project_id)
    if not project:
        raise HTTPException(404, "project not found")
    if project_is_archived(project):
        raise HTTPException(403, "project is archived; unarchive before creating sessions")
    try:
        s = session_create(name=req.name, project_id=project_id, metadata=req.metadata, manifest_path=req.manifest_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    event_create(s["id"], "session.created", {"name": s["name"], "project_id": project_id})
    return {"session": s}


class ResolveMigrationReq(BaseModel):
    project_id: str


@router.get("/migration/conflicts")
async def api_migration_conflicts(limit: int = 100):
    from edagent_vivado.projects.migrate import list_migration_conflicts

    sessions = list_migration_conflicts(limit=limit)
    return {"sessions": sessions, "count": len(sessions)}


@router.post("/migration/sessions/{session_id}/resolve")
async def api_migration_resolve(session_id: str, req: ResolveMigrationReq):
    from edagent_vivado.projects.migrate import resolve_migration_conflict

    try:
        s = resolve_migration_conflict(session_id, req.project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"session": s}


@router.post("/migration/run")
async def api_migration_run():
    from edagent_vivado.projects.migrate import migrate_sessions_to_projects

    stats = migrate_sessions_to_projects()
    return {"ok": True, "stats": stats}


# ── Session API ──────────────────────────────────────────────

@router.get("/sessions")
async def api_sessions(
    status: str | None = None,
    limit: int = 50,
    project_id: str | None = Query(None),
    include_archived: bool = False,
):
    return {
        "sessions": session_list(
            status=status,
            limit=limit,
            project_id=project_id,
            include_archived=include_archived,
        ),
    }

@router.post("/sessions")
async def api_sessions_create(req: CreateSessionReq):
    if not req.project_id:
        raise HTTPException(400, "project_id is required; use POST /api/v1/projects/{project_id}/sessions")
    project = project_get(req.project_id)
    if not project:
        raise HTTPException(404, "project not found")
    if project_is_archived(project):
        raise HTTPException(403, "project is archived")
    try:
        s = session_create(
            name=req.name,
            project_id=req.project_id,
            manifest_path=req.manifest_path,
            metadata=req.metadata,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    event_create(s["id"], "session.created", {"name": s["name"], "project_id": req.project_id})
    return {"session": s}

@router.get("/sessions/{session_id}")
async def api_session_get(session_id: str):
    s = session_get(session_id)
    if not s: raise HTTPException(404, "session not found")
    return {"session": s}

class UpdateSessionReq(BaseModel):
    name: str | None = None
    status: str | None = None
    metadata: dict | None = None


@router.patch("/sessions/{session_id}")
async def api_session_update(session_id: str, req: UpdateSessionReq):
    existing = session_get(session_id)
    if not existing:
        raise HTTPException(404, "session not found")
    updates: dict = {}
    if req.name is not None:
        updates["name"] = req.name.strip() or existing["name"]
        updates["updated_at"] = int(time.time())
    if req.status is not None:
        updates["status"] = req.status
    if req.metadata is not None:
        prev = {}
        try:
            prev = json.loads(existing.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            prev = {}
        updates["metadata_json"] = json.dumps({**prev, **req.metadata})
    if not updates:
        return {"session": existing}
    s = session_update(session_id, **updates)
    if not s:
        raise HTTPException(404)
    event_create(session_id, "session.updated", {"fields": list(updates.keys())})
    return {"session": s}

@router.delete("/sessions/{session_id}")
async def api_session_delete(session_id: str, hard: bool = False):
    s = session_get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    if s.get("project_id"):
        project = project_get(s["project_id"])
        if project_is_archived(project):
            pass  # allow archive/delete on archived project's sessions
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
    sess = session_get(session_id)
    if not sess:
        raise HTTPException(404, "session not found")
    if sess.get("archived_at"):
        raise HTTPException(403, "session is archived")
    if sess.get("project_id"):
        project = project_get(sess["project_id"])
        if project_is_archived(project):
            raise HTTPException(403, "project is archived")
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
        arm_token = None
        arm_assignments: list[dict] = []
        try:
            run = run_create("task", f"task:{t['id']}", session_id=session_id, task_id=t["id"])
            event_create(session_id, "run.started", {"run_id": run["id"], "run_type": "task"},
                         task_id=t["id"], run_id=run["id"])
            from edagent_vivado.agent.context import build_agent_context
            manifest_path = req.manifest_path or snapshot_manifest_path(sess)
            ctx = build_agent_context(
                session_id=session_id,
                task_id=t["id"],
                run_id=run["id"],
                question=req.question,
                manifest_path=manifest_path,
            )
            event_create(session_id, "context.package.created", {
                "context_package_id": ctx.context_package["id"],
                "retrieval_audit_id": ctx.retrieval_audit["id"] if ctx.retrieval_audit else None,
                "token_counts": ctx.token_counts,
            }, task_id=t["id"], run_id=run["id"])
            # SE-PR5 — assign A/B trial arms for this task BEFORE the agent boots
            # so create_agent / resolvers see the right overlay payloads.
            try:
                from edagent_vivado.evolution import (
                    assign_arms_for_task,
                    set_task_arms,
                    task_arms_summary,
                )

                arms = assign_arms_for_task(
                    project_id=sess.get("project_id") or None,
                    task_id=t["id"],
                )
                if arms:
                    arm_token = set_task_arms(arms)
                    arm_assignments = task_arms_summary(arms)
                    for entry in arm_assignments:
                        event_create(
                            session_id,
                            "evolution.trial.assigned",
                            entry,
                            task_id=t["id"],
                            run_id=run["id"] if run else "",
                        )
                    # Persist on the task so collect_task_metrics can read it back.
                    try:
                        from edagent_vivado.repository.store import task_update as _tu

                        prev_meta_raw = (task_get(t["id"]) or {}).get("metadata_json") or "{}"
                        try:
                            prev_meta = json.loads(prev_meta_raw) or {}
                        except json.JSONDecodeError:
                            prev_meta = {}
                        prev_meta["evolution_arms"] = arm_assignments
                        _tu(t["id"], metadata_json=json.dumps(prev_meta))
                    except Exception:
                        pass
            except Exception:
                pass

            agent = create_agent(project_id=sess.get("project_id") or None)
            config = {"configurable": {"thread_id": f"session:{session_id}"}, "recursion_limit": 1000}
            from edagent_vivado.harness.run_context import set_agent_run_context
            set_agent_run_context(session_id, t["id"], run["id"])
            from edagent_vivado.harness.observed_tool import ObservedToolRunner

            tool_runner = ObservedToolRunner(session_id, t["id"], run["id"], event_create)
            from edagent_vivado.harness.assistant_stream import AssistantStreamManager

            stream_mgr = AssistantStreamManager(t["id"])
            full_response = ""
            continuation_msg: HumanMessage | None = None
            approval_round = 0
            max_approval_rounds = 6

            def _emit_stream_completed(stream_id: str, *, stopped: bool = False) -> None:
                snap = stream_mgr.text_for(stream_id)
                event_create(
                    session_id,
                    "assistant.stream.completed",
                    {"stream_id": stream_id, "stopped": stopped},
                    task_id=t["id"],
                    run_id=run["id"],
                )
                if snap:
                    event_create(
                        session_id,
                        "message.assistant.snapshot",
                        {"stream_id": stream_id, "text": snap},
                        task_id=t["id"],
                        run_id=run["id"],
                    )

            while approval_round < max_approval_rounds:
                if approval_round > 0:
                    closed_stream, _ = stream_mgr.rotate_after_tool()
                    _emit_stream_completed(closed_stream)
                event_create(
                    session_id,
                    "assistant.stream.opened",
                    {
                        "stream_id": stream_mgr.current_stream_id,
                        "segment_index": stream_mgr.segment_index,
                    },
                    task_id=t["id"],
                    run_id=run["id"],
                )
                inline_approval_results: list[str] = []
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
                            _emit_stream_completed(stream_mgr.current_stream_id, stopped=True)
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
                        closed_stream, _new_stream = stream_mgr.rotate_after_tool()
                        _emit_stream_completed(closed_stream)
                        event_create(
                            session_id,
                            "assistant.stream.opened",
                            {
                                "stream_id": stream_mgr.current_stream_id,
                                "segment_index": stream_mgr.segment_index,
                            },
                            task_id=t["id"],
                            run_id=run["id"],
                        )
                        tool_name_start = evt.get("name", "")
                        tool_input = evt.get("data", {}).get("input", {})
                        run_key = _langgraph_tool_run_key(evt)
                        # Flush batched file ops before any non-file tool
                        if not is_patch_approved():
                            if not is_file_patch_tool(tool_name_start):
                                pre_flush = await _flush_pending_file_batch(session_id, t["id"], run, t)
                                if pre_flush:
                                    inline_approval_results.append(pre_flush)
                        from edagent_vivado.harness.vivado_agent_registry import (
                            is_vivado_execution_tool,
                            vivado_tool_spec,
                        )
                        from edagent_vivado.harness.vivado_hitl import request_vivado_tool_approval

                        vivado_blocked_early = False
                        if is_vivado_execution_tool(tool_name_start) and not is_vivado_execution_approved():
                            approved = await request_vivado_tool_approval(
                                tool_name_start,
                                tool_input,
                                session_id=session_id,
                                task_id=t["id"],
                                run_id=run["id"],
                                event_create=event_create,
                            )
                            if not approved:
                                spec = vivado_tool_spec(tool_name_start)
                                from edagent_vivado.harness.approval_outcomes import (
                                    SCOPE_VIVADO_SYNTH,
                                    format_user_rejection,
                                )

                                blocked_scope = spec.scope if spec else SCOPE_VIVADO_SYNTH
                                lg_key = run_key or f"vivado-reject:{t['id']}:{tool_name_start}"
                                from edagent_vivado.harness.run_context import set_tool_thread_context

                                set_tool_thread_context(session_id, t["id"], run["id"])
                                tcid = tool_runner.on_tool_rejected(
                                    lg_key,
                                    tool_name_start,
                                    tool_input,
                                    blocked_scope=blocked_scope,
                                )
                                _early_completed_toolcall_ids.add(tcid)
                                _blocked_tool_runs[lg_key] = blocked_scope
                                if run_key:
                                    _blocked_tool_runs[run_key] = blocked_scope
                                    tool_runner.tool_ids[run_key] = tcid
                                _vivado_reject_run_keys.add(lg_key)
                                if run_key:
                                    _vivado_reject_run_keys.add(run_key)
                                vivado_blocked_early = True
                                inline_approval_results.append(
                                    format_user_rejection(blocked_scope, tool_name=tool_name_start)
                                )
                        if not vivado_blocked_early:
                            from edagent_vivado.harness.run_context import set_tool_thread_context

                            set_tool_thread_context(session_id, t["id"], run["id"])
                            tool_runner.on_tool_start(
                                run_key or str(evt.get("run_id", "")),
                                tool_name_start,
                                tool_input,
                            )
                    elif kind == "on_tool_end":
                        output = str(evt.get("data", {}).get("output", ""))[:2500]
                        run_key = _langgraph_tool_run_key(evt)
                        tool_name = evt.get("name", "")
                        from edagent_vivado.harness.run_context import clear_tool_thread_context
                        from edagent_vivado.harness.vivado_agent_registry import is_vivado_execution_tool

                        tcid_early = tool_runner.tool_ids.get(run_key, "")
                        is_vivado_reject = (
                            run_key in _vivado_reject_run_keys
                            or tcid_early in _early_completed_toolcall_ids
                        )
                        if is_vivado_reject:
                            _vivado_reject_run_keys.discard(run_key)
                            if tcid_early:
                                _early_completed_toolcall_ids.discard(tcid_early)
                            _blocked_tool_runs.pop(run_key, None)
                            clear_tool_thread_context()
                            continue
                        blocked_scope = _blocked_tool_runs.pop(run_key, None)
                        was_blocked = blocked_scope is not None
                        tcid = tool_runner.tool_ids.get(run_key, "")
                        if was_blocked and is_vivado_execution_tool(tool_name):
                            from edagent_vivado.harness.approval_outcomes import format_user_rejection

                            output = format_user_rejection(
                                blocked_scope or "",
                                tool_name=tool_name,
                            )
                        queue_file_patch = (
                            not was_blocked
                            and is_file_patch_tool(tool_name)
                            and is_file_tool_queued_for_approval(tool_name, output)
                            and not is_patch_approved()
                        )
                        handle_interaction_tool = (
                            not was_blocked
                            and is_interaction_tool(tool_name)
                            and not is_patch_approved()
                        )
                        # Intercept interaction tools — create interaction and wait for user
                        if queue_file_patch or handle_interaction_tool:
                            from edagent_vivado.harness.interaction import (
                                create_interaction, wait_for_response, InteractionType, FileItem, InputField,
                                append_file_to_batch, take_file_batch,
                            )
                            tool_input = evt.get("data", {}).get("input", {})
                            if queue_file_patch and tool_name in ("create_file_tool", "propose_patch_tool"):
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
                                from edagent_vivado.harness.approval_payload import (
                                    build_file_approval_payload,
                                    payload_to_reason_json,
                                )
                                approval_title = tool_input.get("title", batch_title or "File Approval Required")
                                approval_msg = tool_input.get("message", batch_msg)
                                file_payload = build_file_approval_payload(
                                    approval_title,
                                    approval_msg,
                                    [{"path": f.path, "description": f.description, "action": f.action} for f in files],
                                )
                                interaction = create_interaction(
                                    InteractionType.APPROVAL, session_id, t["id"],
                                    title=approval_title,
                                    message="",
                                    reason=payload_to_reason_json(file_payload),
                                    files=files,
                                )
                                event_create(session_id, "interaction.requested", interaction.to_dict(),
                                             task_id=t["id"], run_id=run["id"])
                                responded = await wait_for_response(interaction.id, task_id=t["id"])
                                if responded is None:
                                    from edagent_vivado.repository.store import task_get as _task_get

                                    if _task_get(t["id"]) and _task_get(t["id"]).get("stop_requested"):
                                        from edagent_vivado.harness.approval_outcomes import (
                                            SCOPE_FILE_CHANGES,
                                            format_user_rejection,
                                        )
                                        output = format_user_rejection(
                                            SCOPE_FILE_CHANGES, detail="Task stopped by user."
                                        )
                                    else:
                                        output = "TIMEOUT: No user response"
                                elif responded:
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
                            elif handle_interaction_tool and tool_name == "request_user_input":
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
                                responded = await wait_for_response(interaction.id, task_id=t["id"])
                                if responded is None:
                                    from edagent_vivado.repository.store import task_get as _task_get

                                    if _task_get(t["id"]) and _task_get(t["id"]).get("stop_requested"):
                                        from edagent_vivado.harness.approval_outcomes import (
                                            SCOPE_INPUT_REQUEST,
                                            format_user_rejection,
                                        )
                                        output = format_user_rejection(
                                            SCOPE_INPUT_REQUEST, detail="Task stopped by user."
                                        )
                                    else:
                                        output = "TIMEOUT: No user response"
                                elif responded:
                                    output = json.dumps(responded.response, ensure_ascii=False)
                        if tcid:
                            tool_runner.on_tool_end(
                                run_key,
                                tool_name,
                                output,
                                blocked=was_blocked,
                                blocked_scope=blocked_scope,
                            )
                        if (
                            tool_name in ("request_approval", "request_user_input", "create_file_tool", "propose_patch_tool")
                            and output
                            and not is_patch_approved()
                        ):
                            from edagent_vivado.harness.approval_apply import should_continue_after_approval
                            if should_continue_after_approval(output) or output.startswith("{"):
                                inline_approval_results.append(output)
                        clear_tool_thread_context()
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
                                stream_mgr.append_delta(text)
                                event_create(
                                    session_id,
                                    "message.assistant.delta",
                                    {"text": text, "stream_id": stream_mgr.current_stream_id},
                                    task_id=t["id"],
                                    run_id=run["id"],
                                )

                # End of one agent round — flush any queued file approvals
                flush_output = None
                if not is_patch_approved():
                    flush_output = await _flush_pending_file_batch(session_id, t["id"], run, t)

                from edagent_vivado.harness.approval_apply import (
                    should_continue_after_approval,
                    continuation_prompt,
                )
                follow_up = flush_output or (inline_approval_results[-1] if inline_approval_results else "")
                from edagent_vivado.harness.approval_outcomes import parse_tool_outcome, OUTCOME_USER_REJECTED

                follow_parsed = parse_tool_outcome(follow_up) if follow_up else {}
                is_user_reject = follow_parsed.get("edagent_outcome") == OUTCOME_USER_REJECTED
                if (
                    follow_up
                    and should_continue_after_approval(follow_up)
                    and approval_round < max_approval_rounds - 1
                    and not (is_user_reject and full_response.strip())
                ):
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

            latest_task = task_get(t["id"])
            if latest_task and latest_task.get("stop_requested"):
                return

            # Save assistant message (denormalized snapshot for search/export — not used for chat timeline)
            if full_response:
                _emit_stream_completed(stream_mgr.current_stream_id)
                message_create(session_id, "assistant", full_response, task_id=t["id"])
                event_create(
                    session_id,
                    "message.assistant.completed",
                    {"stream_id": stream_mgr.current_stream_id},
                    task_id=t["id"],
                    run_id=run["id"],
                )
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

            # SPEC §22.7 — write a task-scope metric snapshot, then refresh rolling
            # aggregates. Failures must never propagate into the agent loop.
            try:
                from edagent_vivado.evolution import (
                    aggregate_rolling,
                    collect_task_metrics,
                    run_generators,
                )

                project_id_for_metrics: str | None = None
                if sess.get("project_id"):
                    project_id_for_metrics = sess["project_id"]
                collect_task_metrics(
                    session_id=session_id,
                    task_id=t["id"],
                    run_id=run["id"] if run else "",
                    event_sink=event_create,
                )
                if project_id_for_metrics:
                    aggregate_rolling(
                        project_id_for_metrics,
                        "rolling_10",
                        event_sink=event_create,
                        session_id=session_id,
                        task_id=t["id"],
                    )
                    aggregate_rolling(
                        project_id_for_metrics,
                        "rolling_50",
                        event_sink=event_create,
                        session_id=session_id,
                        task_id=t["id"],
                    )
                # SPEC §22.6 — Level-0 candidate generators (always pending, never auto-apply).
                run_generators(
                    project_id=project_id_for_metrics,
                    session_id=session_id,
                    task_id=t["id"],
                    event_sink=event_create,
                )

                # SE-PR5 — give every trial this task contributed to a chance to decide.
                if arm_assignments:
                    from edagent_vivado.evolution import maybe_decide_trial

                    seen_trials = {a.get("trial_id") for a in arm_assignments if a.get("trial_id")}
                    for tid in seen_trials:
                        try:
                            maybe_decide_trial(tid, event_sink=event_create)
                        except Exception:
                            pass
            except Exception:
                pass
            finally:
                # Always clear the per-task arm assignment so a follow-up
                # task in the same process starts from a clean slate.
                try:
                    if arm_token is not None:
                        from edagent_vivado.evolution import reset_task_arms

                        reset_task_arms(arm_token)
                except Exception:
                    pass
        except Exception as e:
            task_update(t["id"], state="error", error=str(e), finished_at=int(time.time()))
            session_update(session_id, status="error")
            if run: run_update(run["id"], state="error", error=str(e), finished_at=int(time.time()))
            if run:
                event_create(session_id, "run.error", {"run_id": run["id"], "error": str(e)}, task_id=t["id"], run_id=run["id"])
            event_create(session_id, "task.error", {"task_id": t["id"], "error": str(e)}, task_id=t["id"])
            # SE-PR5 — drop arm assignment on the error path too.
            try:
                if arm_token is not None:
                    from edagent_vivado.evolution import reset_task_arms

                    reset_task_arms(arm_token)
            except Exception:
                pass

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
    sid = session_id or task_get(task_id)["session_id"]
    from edagent_vivado.harness.task_cancel import cancel_task_execution
    from edagent_vivado.harness.task_stop_helpers import finalize_task_stop

    cancel_stats = cancel_task_execution(task_id)
    event_create(
        sid,
        "task.stopping",
        {"task_id": task_id, **cancel_stats},
        task_id=task_id,
    )
    final = finalize_task_stop(task_id, sid, event_create)
    return {
        "ok": True,
        "task_id": task_id,
        "state": final.get("state", "stopped"),
        "cancel": cancel_stats,
        **final,
    }

# ── Event / Stream API ───────────────────────────────────────

@router.get("/events/protocol")
async def api_events_protocol():
    """Wire protocol catalog for SSE subscribers and timeline handlers."""
    return {
        "protocol_version": PROTOCOL_VERSION,
        "wire_event_types": list(ALL_WIRE_EVENT_TYPES),
    }


@router.get("/sessions/{session_id}/events")
async def api_events(session_id: str, after_seq: int = 0, limit: int = 500, recent: bool = False):
    from edagent_vivado.repository.store import event_list_recent
    if recent:
        rows = event_list_recent(session_id, limit=limit)
    else:
        rows = event_list(session_id, after_seq=after_seq, limit=limit)
    return {"events": [enrich_wire_event(e) for e in rows]}

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
                wire = enrich_wire_event(evt)
                p = json.dumps(wire, ensure_ascii=False, default=str)
                yield f"id: {session_id}:{wire['seq']}\nevent: {wire['event_type']}\ndata: {p}\n\n"
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

@router.get("/monitor/sessions/{session_id}/usage")
async def api_monitor_session_usage(session_id: str):
    return usage_totals_for_session(session_id)

@router.get("/monitor/overview")
async def api_monitor_overview(days: int = Query(14, ge=1, le=90)):
    return monitor_overview(days=days)

class MonitorCleanupBody(BaseModel):
    retention_days: int = 90
    dry_run: bool = True

@router.post("/monitor/cleanup")
async def api_monitor_cleanup(body: MonitorCleanupBody):
    return monitor_retention_cleanup(
        retention_days=body.retention_days,
        dry_run=body.dry_run,
    )

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

@router.get("/settings/approvals")
async def api_approvals_get():
    return {
        "patch_approved": is_patch_approved(),
        "vivado_execution_approved": is_vivado_execution_approved(),
    }


@router.get("/settings/patch-approval")
async def api_approval_get():
    return {"approved": is_patch_approved()}


@router.post("/settings/patch-approval")
async def api_approval_set(body: dict):
    approved = bool(body.get("approved", not is_patch_approved()))
    set_patch_approval(approved)
    return {"approved": is_patch_approved()}


@router.get("/settings/vivado-approval")
async def api_vivado_approval_get():
    return {"approved": is_vivado_execution_approved()}


@router.post("/settings/vivado-approval")
async def api_vivado_approval_set(body: dict):
    approved = bool(body.get("approved", not is_vivado_execution_approved()))
    set_vivado_execution_approval(approved)
    return {"approved": is_vivado_execution_approved()}

# ── Feedback API (SPEC §22.6) ─────────────────────────────────

class FeedbackReq(BaseModel):
    session_id: str
    task_id: str | None = None
    message_id: str | None = None
    user_thumb: int | None = None
    comment: str | None = None
    tags: list[str] | None = None
    metadata: dict | None = None


@router.post("/feedback")
async def api_feedback_create(req: FeedbackReq):
    if req.user_thumb is not None and req.user_thumb not in (-1, 0, 1):
        raise HTTPException(400, "user_thumb must be -1, 0, or 1")
    sess = session_get(req.session_id)
    if not sess:
        raise HTTPException(404, "session not found")
    from edagent_vivado.evolution import feedback_create

    try:
        row = feedback_create(
            session_id=req.session_id,
            task_id=req.task_id,
            message_id=req.message_id,
            user_thumb=req.user_thumb,
            comment=(req.comment or None),
            tags=req.tags,
            metadata=req.metadata,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    event_create(
        req.session_id,
        "evolution.feedback.created",
        {
            "feedback_id": row["id"],
            "user_thumb": row.get("user_thumb"),
            "task_id": req.task_id,
            "message_id": req.message_id,
        },
        task_id=req.task_id or "",
    )
    return {"feedback": row}


@router.get("/sessions/{session_id}/feedback")
async def api_feedback_list(session_id: str, limit: int = 200):
    from edagent_vivado.evolution import feedback_list_for_session

    return {"feedback": feedback_list_for_session(session_id, limit=limit)}

# ── Metrics API (SPEC §22.9) ──────────────────────────────────

@router.get("/metrics/summary")
async def api_metrics_summary(
    project_id: str = "",
    window: str = "rolling_10",
):
    from edagent_vivado.evolution import latest_snapshot

    scope = "project" if project_id else "global"
    snap = latest_snapshot(project_id=project_id or None, scope=scope, window=window)
    if not snap:
        return {"snapshot": None, "project_id": project_id or None, "scope": scope, "window": window}
    return {"snapshot": snap, "project_id": project_id or None, "scope": scope, "window": window}


@router.get("/metrics/series")
async def api_metrics_series(
    project_id: str = "",
    scope: str = "task",
    window: str = "single",
    limit: int = Query(50, ge=1, le=500),
):
    from edagent_vivado.evolution import snapshot_series

    series = snapshot_series(
        project_id=project_id or None,
        scope=scope,
        window=window,
        limit=limit,
    )
    return {
        "series": series,
        "project_id": project_id or None,
        "scope": scope,
        "window": window,
        "count": len(series),
    }

# ── Evolution Candidates API (SPEC §22.9 — SE-PR3 read-only) ───

def _candidate_dto(row: dict) -> dict:
    """Decode JSON fields so the frontend can use them directly."""
    try:
        signal = json.loads(row.get("signal_source_json") or "{}")
    except json.JSONDecodeError:
        signal = {}
    try:
        meta = json.loads(row.get("metadata_json") or "{}")
    except json.JSONDecodeError:
        meta = {}
    out = dict(row)
    out["signal_source"] = signal
    out["metadata"] = meta
    return out


@router.get("/evolution/candidates")
async def api_evolution_candidates_list(
    status: str = "pending",
    surface: str = "",
    project_id: str = "",
    limit: int = Query(100, ge=1, le=500),
):
    from edagent_vivado.evolution import candidate_list

    rows = candidate_list(
        status=status or None,
        surface=surface or None,
        project_id=project_id or None,
        limit=limit,
    )
    return {
        "candidates": [_candidate_dto(r) for r in rows],
        "filters": {
            "status": status or None,
            "surface": surface or None,
            "project_id": project_id or None,
        },
        "count": len(rows),
    }


@router.get("/evolution/candidates/{candidate_id}")
async def api_evolution_candidate_get(candidate_id: str):
    from edagent_vivado.evolution import candidate_get

    row = candidate_get(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {"candidate": _candidate_dto(row)}


class CandidateApproveReq(BaseModel):
    reviewed_by: str = "user"
    payload: dict | None = None


@router.post("/evolution/candidates/{candidate_id}/approve")
async def api_evolution_candidate_approve(candidate_id: str, body: CandidateApproveReq):
    from edagent_vivado.evolution import approve_candidate, candidate_get

    try:
        updated = approve_candidate(
            candidate_id,
            reviewed_by=body.reviewed_by or "user",
            payload_override=body.payload,
            event_sink=event_create,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    cand = candidate_get(candidate_id)
    return {
        "candidate": _candidate_dto(updated or cand or {"id": candidate_id}),
        "overlay_id": (updated or {}).get("applied_overlay_id"),
    }


class CandidateRejectReq(BaseModel):
    reviewed_by: str = "user"
    suppress_days: int = 0
    reason: str | None = None


@router.post("/evolution/candidates/{candidate_id}/reject")
async def api_evolution_candidate_reject(candidate_id: str, body: CandidateRejectReq):
    from edagent_vivado.evolution import reject_candidate

    if body.suppress_days < 0 or body.suppress_days > 365:
        raise HTTPException(400, "suppress_days must be between 0 and 365")
    try:
        updated = reject_candidate(
            candidate_id,
            reviewed_by=body.reviewed_by or "user",
            suppress_days=body.suppress_days,
            reason=body.reason,
            event_sink=event_create,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"candidate": _candidate_dto(updated or {})}


class CandidateMergeReq(BaseModel):
    reviewed_by: str = "user"


@router.post("/evolution/candidates/{candidate_id}/merge")
async def api_evolution_candidate_merge(candidate_id: str, body: CandidateMergeReq):
    from edagent_vivado.evolution import merge_candidate

    try:
        updated = merge_candidate(
            candidate_id,
            reviewed_by=body.reviewed_by or "user",
            event_sink=event_create,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"candidate": _candidate_dto(updated or {})}


class CandidateRollbackReq(BaseModel):
    reviewed_by: str = "user"
    reason: str | None = None


@router.post("/evolution/candidates/{candidate_id}/rollback")
async def api_evolution_candidate_rollback(candidate_id: str, body: CandidateRollbackReq):
    from edagent_vivado.evolution import rollback_candidate

    try:
        updated = rollback_candidate(
            candidate_id,
            reviewed_by=body.reviewed_by or "user",
            reason=body.reason,
            event_sink=event_create,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"candidate": _candidate_dto(updated or {})}


def _overlay_dto(row: dict) -> dict:
    """Serialise an overlay row with decoded payload + metadata."""
    out = dict(row)
    if "payload" not in out:
        try:
            out["payload"] = json.loads(out.get("payload_json") or "{}")
        except json.JSONDecodeError:
            out["payload"] = {}
    if "metadata" not in out:
        try:
            out["metadata"] = json.loads(out.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            out["metadata"] = {}
    return out


@router.get("/evolution/overlays")
async def api_evolution_overlays_list(
    project_id: str = "",
    surface: str = "",
    state: str = "",
    scope: str = "",
    limit: int = Query(200, ge=1, le=500),
):
    from edagent_vivado.evolution import overlay_list

    rows = overlay_list(
        project_id=project_id or None,
        surface=surface or None,
        state=state or None,
        scope=scope or None,
        limit=limit,
    )
    return {
        "overlays": [_overlay_dto(r) for r in rows],
        "filters": {
            "project_id": project_id or None,
            "surface": surface or None,
            "state": state or None,
            "scope": scope or None,
        },
        "count": len(rows),
    }


@router.get("/evolution/overlays/{overlay_id}")
async def api_evolution_overlay_get(overlay_id: str):
    from edagent_vivado.evolution import overlay_get

    row = overlay_get(overlay_id)
    if not row:
        raise HTTPException(404, "overlay not found")
    return {"overlay": _overlay_dto(row)}


@router.post("/evolution/overlays/{overlay_id}/retire")
async def api_evolution_overlay_retire(overlay_id: str):
    from edagent_vivado.evolution import retire_overlay

    try:
        out = retire_overlay(overlay_id, event_sink=event_create)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"overlay": _overlay_dto(out)}


# ── Trial config (SPEC §22 SE-PR5) ────────────────────────────


@router.get("/evolution/config")
async def api_evolution_config(project_id: str = ""):
    from edagent_vivado.evolution import (
        DECISION_MARGIN,
        MIN_SAMPLES_PER_ARM,
        TRIAL_FORBIDDEN_SURFACES,
        project_trial_config,
    )

    if not project_id:
        return {
            "project_id": None,
            "trials": {},
            "forbidden_surfaces": sorted(TRIAL_FORBIDDEN_SURFACES),
            "min_samples_per_arm": MIN_SAMPLES_PER_ARM,
            "decision_margin": DECISION_MARGIN,
        }
    if not project_get(project_id):
        raise HTTPException(404, "project not found")
    return {
        "project_id": project_id,
        "trials": project_trial_config(project_id),
        "forbidden_surfaces": sorted(TRIAL_FORBIDDEN_SURFACES),
        "min_samples_per_arm": MIN_SAMPLES_PER_ARM,
        "decision_margin": DECISION_MARGIN,
    }


class TrialConfigSetReq(BaseModel):
    project_id: str
    surface: str
    enabled: bool


@router.post("/evolution/config")
async def api_evolution_config_set(body: TrialConfigSetReq):
    from edagent_vivado.evolution import set_trial_enabled

    if not project_get(body.project_id):
        raise HTTPException(404, "project not found")
    try:
        out = set_trial_enabled(body.project_id, body.surface, body.enabled)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "project_id": body.project_id,
        "surface": body.surface,
        "enabled": out,
    }


# ── Trials (SPEC §22 SE-PR5) ─────────────────────────────────


def _trial_dto(row: dict) -> dict:
    """Serialise a trial row with decoded payload + per-arm score buckets."""
    out = dict(row)
    for col_json, col_decoded in (
        ("metric_baseline_json", "metric_baseline"),
        ("metric_variant_json", "metric_variant"),
        ("metadata_json", "metadata"),
    ):
        if col_decoded in out:
            continue
        raw = out.get(col_json)
        if isinstance(raw, str) and raw:
            try:
                out[col_decoded] = json.loads(raw)
            except json.JSONDecodeError:
                out[col_decoded] = {}
        else:
            out[col_decoded] = {}
    return out


@router.get("/evolution/trials")
async def api_evolution_trials_list(
    project_id: str = "",
    state: str = "",
    surface: str = "",
    limit: int = Query(200, ge=1, le=500),
):
    from edagent_vivado.evolution import trial_list

    rows = trial_list(
        project_id=project_id or None,
        state=state or None,
        surface=surface or None,
        limit=limit,
    )
    return {
        "trials": [_trial_dto(r) for r in rows],
        "filters": {
            "project_id": project_id or None,
            "state": state or None,
            "surface": surface or None,
        },
        "count": len(rows),
    }


@router.get("/evolution/trials/{trial_id}")
async def api_evolution_trial_get(trial_id: str):
    from edagent_vivado.evolution import trial_get

    row = trial_get(trial_id)
    if not row:
        raise HTTPException(404, "trial not found")
    return {"trial": _trial_dto(row)}


class TrialDecideReq(BaseModel):
    decision: str
    reviewed_by: str = "user"


@router.post("/evolution/trials/{trial_id}/decide")
async def api_evolution_trial_decide(trial_id: str, body: TrialDecideReq):
    """Operator override that decides a trial regardless of sample count."""
    from edagent_vivado.evolution import force_decision

    try:
        out = force_decision(
            trial_id,
            body.decision,
            reviewed_by=body.reviewed_by or "user",
            event_sink=event_create,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not out:
        raise HTTPException(404, "trial not found")
    return {"trial": _trial_dto(out)}


class TrialAbortReq(BaseModel):
    reason: str = "manual_abort"


@router.post("/evolution/trials/{trial_id}/abort")
async def api_evolution_trial_abort(trial_id: str, body: TrialAbortReq):
    from edagent_vivado.evolution import abort_trial

    out = abort_trial(trial_id, reason=body.reason or "manual_abort", event_sink=event_create)
    if not out:
        raise HTTPException(404, "trial not found")
    return {"trial": _trial_dto(out)}


class GeneratorRunReq(BaseModel):
    project_id: str | None = None
    session_id: str = ""
    task_id: str = ""
    only: list[str] | None = None


@router.post("/evolution/generators/run")
async def api_evolution_generators_run(body: GeneratorRunReq):
    """On-demand trigger for the SE-PR3 generators.

    Mainly for debugging / catching up after a backfill; the live system
    runs the same dispatcher automatically after every ``task.done``.
    """
    from edagent_vivado.evolution import run_generators

    if body.project_id and not project_get(body.project_id):
        raise HTTPException(404, "project not found")
    sink = event_create if body.session_id else None
    result = run_generators(
        project_id=body.project_id,
        session_id=body.session_id or "",
        task_id=body.task_id or "",
        event_sink=sink,
        only=body.only,
    )
    return {
        "project_id": body.project_id,
        "created": result.get("created", []),
        "errors": result.get("errors", {}),
    }

# ── KB API ───────────────────────────────────────────────────

@router.get("/kb/cases")
async def api_kb_cases():
    import json

    from edagent_vivado.kb.error_case_loader import load_cases, load_effective_cases
    from edagent_vivado.repository.store import kb_case_list

    rows: list[dict] = []
    for i, c in enumerate(load_cases()):
        rows.append({
            "id": f"builtin-{i}",
            "pattern": c.pattern,
            "category": c.category,
            "likely_causes": c.likely_causes,
            "suggested_actions": c.suggested_actions,
            "source": "builtin",
        })
    builtin_patterns = {c.pattern for c in load_cases()}
    for row in kb_case_list(limit=500):
        try:
            likely = json.loads(row.get("likely_causes_json") or "[]")
        except json.JSONDecodeError:
            likely = []
        try:
            actions = json.loads(row.get("suggested_actions_json") or "[]")
        except json.JSONDecodeError:
            actions = []
        pat = row.get("pattern") or ""
        if pat in builtin_patterns:
            continue
        rows.append({
            "id": row["id"],
            "pattern": pat,
            "category": row.get("category") or "unknown",
            "likely_causes": likely,
            "suggested_actions": actions,
            "source": "db",
        })
    effective_count = len(load_effective_cases())
    return {"cases": rows, "effective_count": effective_count}

def _kb_candidate_row(row: dict) -> dict:
    likely = row.get("likely_causes_json")
    actions = row.get("suggested_actions_json")
    if isinstance(likely, str):
        try:
            likely = json.loads(likely)
        except json.JSONDecodeError:
            likely = []
    if isinstance(actions, str):
        try:
            actions = json.loads(actions)
        except json.JSONDecodeError:
            actions = []
    return {
        "id": row["id"],
        "source_problem_id": row.get("source_problem_id"),
        "source_run_id": row.get("source_run_id"),
        "source_session_id": row.get("source_session_id"),
        "pattern": row.get("pattern"),
        "category": row.get("category") or "unclassified",
        "title": (row.get("pattern") or "")[:120],
        "likely_causes": likely or [],
        "suggested_actions": actions or [],
        "confidence": row.get("confidence") or 0.5,
        "status": row.get("status") or "pending",
        "created_by": row.get("created_by") or "harness",
        "created_at": row.get("created_at"),
        "merged_into_case_id": row.get("merged_into_case_id"),
    }

@router.get("/kb/candidates")
async def api_kb_candidates(status: str = "pending", limit: int = 50):
    rows = kb_candidate_list(status=status, limit=limit)
    return {"candidates": [_kb_candidate_row(r) for r in rows]}

@router.get("/kb/candidates/{candidate_id}")
async def api_kb_candidate_get(candidate_id: str):
    row = kb_candidate_get(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {"candidate": _kb_candidate_row(row)}

@router.post("/kb/candidates/{candidate_id}/approve")
async def api_kb_candidate_approve(candidate_id: str):
    row = kb_candidate_approve(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {
        "ok": True,
        "candidate": _kb_candidate_row(row),
        "merged_into_case_id": row.get("merged_into_case_id"),
    }

@router.post("/kb/candidates/{candidate_id}/reject")
async def api_kb_candidate_reject(candidate_id: str):
    row = kb_candidate_reject(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {"ok": True, "candidate": _kb_candidate_row(row)}

@router.post("/kb/candidates/{candidate_id}/merge")
async def api_kb_candidate_merge(candidate_id: str):
    row = kb_candidate_merge(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {"ok": True, "candidate": _kb_candidate_row(row), "merged_into_case_id": row.get("merged_into_case_id")}

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
async def api_vivado_commands(session_id: str = "", limit: int = 50):
    rows = vivado_command_list(session_id=session_id, limit=limit)
    commands = []
    for r in rows:
        commands.append({
            "id": r["id"],
            "command": r.get("command_text"),
            "command_type": r.get("command_type"),
            "status": r.get("state"),
            "started_at": r.get("started_at"),
            "finished_at": r.get("finished_at"),
            "elapsed_ms": r.get("elapsed_ms"),
            "exit_code": r.get("exit_code"),
            "session_id": r.get("session_id"),
            "target_id": r.get("target_id"),
            "error": r.get("error"),
        })
    return {"commands": commands}

@router.post("/knowledge/reindex")
async def api_knowledge_reindex(request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    project_id = str(body.get("project_id") or "")
    from edagent_vivado.knowledge.semantic_kb import reindex_all, reindex_global, reindex_project_record

    if project_id:
        project = project_get(project_id)
        if project:
            return {"project": reindex_project_record(project), "global": reindex_global()}
    return reindex_all(project_id=project_id or "uart_demo")

@router.get("/knowledge/sources")
async def api_knowledge_sources(scope: str = "", project_id: str = "", limit: int = 100):
    return {"sources": knowledge_source_list(scope=scope, project_id=project_id, limit=limit)}

@router.post("/knowledge/search")
async def api_knowledge_search(request: Request):
    body = await request.json()
    query = str(body.get("query", ""))
    top_k = int(body.get("top_k", 12))
    scope = str(body.get("scope") or "both")
    project_id = str(body.get("project_id") or "uart_demo")
    session_id = str(body.get("session_id") or "")
    from edagent_vivado.knowledge.semantic_kb import search_semantic_kb

    text, hits = search_semantic_kb(
        query, top_k=top_k, scope=scope, project_id=project_id, session_id=session_id,
    )
    return {"query": query, "results": hits, "formatted": text}

@router.post("/knowledge/context-preview")
async def api_knowledge_context_preview(request: Request):
    body = await request.json()
    question = str(body.get("question") or body.get("query") or "")
    manifest_path = str(body.get("manifest_path") or "")
    session_id = str(body.get("session_id") or "")
    if session_id and not manifest_path:
        sess = session_get(session_id)
        if sess:
            manifest_path = snapshot_manifest_path(sess)
    from edagent_vivado.agent.context import AgentContextBuilder

    ctx = AgentContextBuilder().build(
        session_id=session_id or "preview",
        task_id="preview",
        run_id="preview",
        question=question,
        manifest_path=manifest_path,
        persist=False,
    )
    return {
        "prompt_preview": ctx.prompt[:8000],
        "token_counts": ctx.token_counts,
        "context_package_id": ctx.context_package.get("id"),
        "retrieval_audit_id": ctx.retrieval_audit.get("id") if ctx.retrieval_audit else None,
        "persisted": False,
        "items": [
            {"type": i.item_type, "title": i.title, "included": i.included, "tokens": i.token_count}
            for i in ctx.items
        ],
    }

@router.post("/vivado/commands/flow")
async def api_vivado_run_flow(request: Request):
    """Run synth+impl from manifest (observed when session/run ids provided)."""
    body = await request.json()
    manifest_path = str(body.get("manifest_path") or "")
    sid = str(body.get("session_id") or "")
    if not manifest_path and sid:
        sess = session_get(sid)
        if sess:
            manifest_path = snapshot_manifest_path(sess)
    if not manifest_path:
        raise HTTPException(400, "manifest_path is required (or provide session_id with project snapshot)")
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter

    sid = str(body.get("session_id") or "")
    tid = str(body.get("task_id") or "")
    rid = str(body.get("run_id") or "")
    adapter = VivadoRuntimeAdapter()
    result = adapter.run_implementation(
        manifest_path,
        session_id=sid,
        task_id=tid,
        run_id=rid,
    )
    from edagent_vivado.harness.approval_outcomes import SCOPE_VIVADO_FLOW, tag_execution_result
    from edagent_vivado.harness.vivado_observed import observe_vivado_command

    tagged = tag_execution_result(result, SCOPE_VIVADO_FLOW)
    if sid and rid:
        observe_vivado_command(
            session_id=sid,
            task_id=tid,
            run_id=rid,
            tool_name="run_vivado_flow_tool",
            input_payload={"manifest_path": manifest_path},
            output=tagged,
            event_create=event_create,
        )
    return {"ok": bool(result.get("success")), "result": result, "tool_output": tagged}


@router.get("/vivado/devices")
async def api_vivado_devices():
    """Query available FPGA devices via VivadoRuntimeAdapter."""
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter

    adapter = VivadoRuntimeAdapter()
    return adapter.list_devices(persist=True)

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
    sid = str(body.get("session_id") or "")
    tid = str(body.get("task_id") or "")
    rid = str(body.get("run_id") or "")
    result = adapter.run_tcl(
        command,
        auto_approved=True,
        session_id=sid,
        task_id=tid,
        run_id=rid,
    )
    from edagent_vivado.harness.approval_outcomes import SCOPE_VIVADO_TCL, tag_vivado_adapter_result
    from edagent_vivado.harness.vivado_observed import observe_vivado_command

    tagged = tag_vivado_adapter_result(result, SCOPE_VIVADO_TCL)
    if sid and rid:
        observe_vivado_command(
            session_id=sid,
            task_id=tid,
            run_id=rid,
            tool_name="run_vivado_tcl_tool",
            input_payload={"command": command, "target_id": target_id},
            output=tagged,
            event_create=event_create,
        )
    return {"ok": result.success, "exit_code": result.exit_code, "stdout": result.stdout[:5000],
            "stderr": result.stderr[:2000], "elapsed_sec": result.elapsed_sec, "error": result.error,
            "tool_output": tagged}

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
    sid = str(body.get("session_id") or "")
    tid = str(body.get("task_id") or "")
    rid = str(body.get("run_id") or "")
    result = adapter.run_script(
        script,
        auto_approved=True,
        session_id=sid,
        task_id=tid,
        run_id=rid,
    )
    from edagent_vivado.harness.approval_outcomes import SCOPE_VIVADO_SCRIPT, tag_vivado_adapter_result
    from edagent_vivado.harness.vivado_observed import observe_vivado_command

    tagged = tag_vivado_adapter_result(result, SCOPE_VIVADO_SCRIPT)
    if sid and rid:
        observe_vivado_command(
            session_id=sid,
            task_id=tid,
            run_id=rid,
            tool_name="run_vivado_script_tool",
            input_payload={"script": script[:500], "target_id": target_id},
            output=tagged,
            event_create=event_create,
        )
    return {"ok": result.success, "exit_code": result.exit_code, "stdout": result.stdout[:5000],
            "stderr": result.stderr[:2000], "elapsed_sec": result.elapsed_sec, "error": result.error,
            "tool_output": tagged}
