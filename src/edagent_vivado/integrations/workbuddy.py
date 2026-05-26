"""WorkBuddy skill HTTP contract — SPEC §9B.15 (thin delegation to api_v1)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from edagent_vivado.repository.store import project_get, session_list

router = APIRouter(prefix="/workbuddy", tags=["workbuddy"])


class WorkBuddyTaskBody(BaseModel):
    question: str = ""
    capability: str = ""
    manifest_path: str = ""
    session_id: str = ""


def _session_for_project(project_id: str) -> str | None:
    rows = session_list(project_id=project_id, limit=1)
    return str(rows[0]["id"]) if rows else None


@router.post("/projects/{project_id}/run-synth")
async def wb_run_synth(project_id: str, body: WorkBuddyTaskBody):
    """synthia-run-synth → start task with synthesis-oriented question."""
    if not project_get(project_id):
        raise HTTPException(404, "project not found")
    session_id = body.session_id or _session_for_project(project_id) or ""
    if not session_id:
        raise HTTPException(400, "no session for project; create a session first")
    question = body.question or "Run Vivado synthesis for this project."
    if body.capability:
        question = f"{question}\n[capability:{body.capability}]"
    from edagent_vivado.web.api_v1 import StartTaskReq, api_task_start

    return await api_task_start(session_id, StartTaskReq(
        question=question,
        manifest_path=body.manifest_path,
        metadata={"workbuddy_skill": "run-synth", "capability": body.capability or "run_synthesis"},
    ))


@router.post("/projects/{project_id}/debug-timing")
async def wb_debug_timing(project_id: str, body: WorkBuddyTaskBody):
    question = body.question or "Analyze timing failures and suggest fixes."
    body = WorkBuddyTaskBody(
        question=question,
        capability=body.capability or "report_timing_summary",
        manifest_path=body.manifest_path,
        session_id=body.session_id,
    )
    return await wb_run_synth(project_id, body)


@router.get("/approvals/patches")
async def wb_review_patches(status: str = "pending", limit: int = 50):
    """synthia-review-patch → unified approvals filtered to patch types."""
    from edagent_vivado.web.api_v1 import api_approvals_list

    rows = (await api_approvals_list(status=status, limit=limit)).get("approvals", [])
    filtered = [
        r for r in rows
        if r.get("approval_type") in ("patch", "file_changes", "vivado_execution", "tcl_execution")
    ]
    return {"approvals": filtered}


@router.get("/runs/{run_id}/reports")
async def wb_export_reports(run_id: str):
    """synthia-export-report → parsed reports for a run."""
    from edagent_vivado.web.api_v1 import api_run_reports

    return await api_run_reports(run_id)


@router.get("/projects/{project_id}/sessions")
async def wb_list_sessions(project_id: str, limit: int = 10):
    if not project_get(project_id):
        raise HTTPException(404, "project not found")
    rows = session_list(project_id=project_id, limit=limit)
    return {"project_id": project_id, "sessions": rows}


@router.post("/projects/{project_id}/tasks")
async def wb_start_task(project_id: str, body: WorkBuddyTaskBody):
    """Generic skill entry — forwards to session task start."""
    if not project_get(project_id):
        raise HTTPException(404, "project not found")
    session_id = body.session_id or _session_for_project(project_id) or ""
    if not session_id:
        raise HTTPException(400, "no session; create one in Synthia first")
    from edagent_vivado.web.api_v1 import StartTaskReq, api_task_start

    meta: dict = {"workbuddy": True}
    if body.capability:
        meta["capability"] = body.capability
    return await api_task_start(
        session_id,
        StartTaskReq(question=body.question or "WorkBuddy task", manifest_path=body.manifest_path, metadata=meta),
    )
