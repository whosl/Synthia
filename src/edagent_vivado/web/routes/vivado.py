"""API routes: vivado."""

from __future__ import annotations

import asyncio
import json
import os as _os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from edagent_vivado.events.catalog import ALL_WIRE_EVENT_TYPES, PROTOCOL_VERSION
from edagent_vivado.events.envelope import enrich_wire_event
from edagent_vivado.harness.execution_approval import (
    is_vivado_execution_approved,
    set_vivado_execution_approval,
)
from edagent_vivado.harness.file_patch_policy import (
    is_file_patch_tool,
    is_file_tool_queued_for_approval,
    is_interaction_tool,
    normalize_tool_output,
)
from edagent_vivado.projects.snapshot import snapshot_manifest_path
from edagent_vivado.projects.validate import ProjectValidationError, validate_project_paths
from edagent_vivado.repository.store import (
    approval_get,
    approval_list,
    approval_update,
    artifact_list,
    capability_list,
    connector_get,
    connector_list,
    context_package_get,
    context_package_items,
    context_packages_for_run,
    context_packages_for_session,
    event_list,
    event_list_for_run,
    knowledge_source_list,
    kb_candidate_approve,
    kb_candidate_get,
    kb_candidate_list,
    kb_candidate_merge,
    kb_candidate_reject,
    memory_latest,
    memory_list,
    message_create,
    message_list,
    monitor_overview,
    monitor_retention_cleanup,
    parsed_report_get,
    parsed_report_list,
    parsed_report_trends,
    patch_proposal_get,
    patch_proposal_list,
    patch_proposal_update,
    problem_list,
    project_create,
    project_delete,
    project_get,
    project_is_archived,
    project_list,
    project_update,
    retrieval_audit_get,
    retrieval_audit_items,
    retrieval_audits_for_run,
    retrieval_audits_for_session,
    run_create,
    run_get,
    run_list,
    run_step_list,
    run_update,
    session_create,
    session_delete,
    session_get,
    session_list,
    session_update,
    task_active_for_session,
    task_create,
    task_get,
    task_update,
    toolcall_list,
    usage_create,
    usage_list,
    usage_totals_for_session,
    vivado_command_list,
)
from edagent_vivado.tools.patch_tools import is_patch_approved, set_patch_approval
from edagent_vivado.web.api_shared import (
    _archive_task_canvas,
    _blocked_tool_runs,
    _early_blocked_tool_runs,
    _early_completed_toolcall_ids,
    _ensure_project_persona,
    _flush_pending_file_batch,
    _langgraph_tool_run_key,
    _memory_pipeline_on_message,
    _publish,
    _stream_queues,
    _vivado_reject_run_keys,
    event_create,
)

router = APIRouter(tags=["vivado"])

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
    sid = str(body.get("session_id") or "")
    tid = str(body.get("task_id") or "")
    rid = str(body.get("run_id") or "")
    if policy.requires_approval and not auto_approved:
        from edagent_vivado.harness.vivado_approval_queue import enqueue_tcl_approval

        if not sid:
            return JSONResponse(
                {"ok": False, "error": "session_id required for Tcl approval queue"},
                status_code=400,
            )
        queued = enqueue_tcl_approval(
            command,
            session_id=sid,
            task_id=tid,
            run_id=rid,
            target_id=str(target_id or ""),
            policy_reason=policy.reason,
            event_sink=event_create,
        )
        return JSONResponse(
            {
                "ok": False,
                "requires_approval": True,
                "reason": policy.reason,
                "matched_rules": policy.matched_rules,
                "approval_id": queued.get("approval_id"),
                "interaction_id": queued.get("interaction_id"),
                "hint": "Approve via /approvals or Terminal, then re-run the command.",
            },
            status_code=202,
        )
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
    sid = str(body.get("session_id") or "")
    tid = str(body.get("task_id") or "")
    rid = str(body.get("run_id") or "")
    if policy.requires_approval and not auto_approved:
        from edagent_vivado.harness.vivado_approval_queue import enqueue_vivado_approval

        if not sid:
            return JSONResponse({"ok": False, "error": "session_id required"}, status_code=400)
        queued = enqueue_vivado_approval(
            approval_type="tcl_execution",
            payload={"reason": policy.reason, "action": "Run Vivado script", "script": script[:2000]},
            session_id=sid,
            task_id=tid,
            run_id=rid,
            title="Approve Vivado script",
            event_sink=event_create,
        )
        return JSONResponse(
            {
                "ok": False,
                "requires_approval": True,
                "approval_id": queued.get("approval_id"),
                "interaction_id": queued.get("interaction_id"),
            },
            status_code=202,
        )
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
