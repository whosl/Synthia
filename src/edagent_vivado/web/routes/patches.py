"""Patch proposal endpoints — Phase 7."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from edagent_vivado.patches.proposal import InvalidPatchTransition
from edagent_vivado.patches.service import (
    approve_and_apply,
    patch_audits_for,
    patch_proposal_get_row,
    propose_patch,
    reject_patch,
    revert_patch,
)
from edagent_vivado.repository.store import patch_proposal_list

router = APIRouter(tags=["patches"])


class CreatePatchProposalReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str
    task_id: str = ""
    run_id: str = ""
    project_id: str = ""
    title: str = Field(..., min_length=1)
    summary: str = ""
    rationale: str = ""
    changes: list[dict] = Field(default_factory=list)


class PatchDecisionReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reason: str = ""
    reviewer_id: str = "user"


@router.post("/patches/propose")
async def api_patch_propose(req: CreatePatchProposalReq):
    try:
        return propose_patch(
            session_id=req.session_id,
            task_id=req.task_id,
            run_id=req.run_id,
            project_id=req.project_id,
            title=req.title,
            summary=req.summary,
            rationale=req.rationale,
            changes=req.changes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/patches/{patch_id}")
async def api_patch_get(patch_id: str):
    p = patch_proposal_get_row(patch_id)
    if not p:
        raise HTTPException(404, "patch not found")
    return {"patch": p, "audits": patch_audits_for(patch_id)}


@router.get("/sessions/{session_id}/patches")
async def api_session_patches(session_id: str, state: str = "", limit: int = 100):
    rows = patch_proposal_list(session_id=session_id, status=state, limit=limit)
    from edagent_vivado.patches.service import proposal_from_row

    return {
        "patches": [
            {**proposal_from_row(r).to_dict(), "status": r.get("status"), "id": r["id"]}
            for r in rows
        ],
    }


@router.post("/patches/{patch_id}/approve")
async def api_patch_approve(patch_id: str, req: PatchDecisionReq):
    try:
        return approve_and_apply(
            patch_id,
            reviewer_id=req.reviewer_id or "user",
            reason=req.reason,
        )
    except InvalidPatchTransition as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/patches/{patch_id}/reject")
async def api_patch_reject(patch_id: str, req: PatchDecisionReq):
    try:
        return reject_patch(patch_id, reviewer_id=req.reviewer_id or "user", reason=req.reason)
    except InvalidPatchTransition as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/patches/{patch_id}/revert")
async def api_patch_revert(patch_id: str):
    try:
        return revert_patch(patch_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
