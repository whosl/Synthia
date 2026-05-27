"""Hardware API — Phase 12."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from edagent_vivado.hardware.detector import detect_targets, sync_detected_to_registry
from edagent_vivado.hardware.session import (
    approve_program,
    job_get,
    reject_program,
    request_program,
    session_close,
    session_get,
    session_open,
)
from edagent_vivado.hardware.target_registry import target_get, target_list, target_update
from edagent_vivado.repository.store import artifact_list
from edagent_vivado.web.dependencies import get_identity, require_perm

router = APIRouter(prefix="/hardware", tags=["hardware"])


class OpenSessionReq(BaseModel):
    target_id: str
    project_id: str = ""


class ProgramReq(BaseModel):
    hardware_session_id: str
    bitstream_artifact_id: str


class ProgramDecisionReq(BaseModel):
    reason: str = ""


class DetectReq(BaseModel):
    host: str = ""


@router.get("/targets", dependencies=[Depends(require_perm("hardware.read"))])
async def api_list_targets(state: str = ""):
    return {"targets": target_list(state=state)}


@router.get("/targets/{target_id}", dependencies=[Depends(require_perm("hardware.read"))])
async def api_get_target(target_id: str):
    t = target_get(target_id)
    if not t:
        raise HTTPException(404)
    return t


@router.post("/targets/detect", dependencies=[Depends(require_perm("hardware.detect"))])
async def api_detect(body: DetectReq | None = None):
    """Trigger a fresh detection of physically connected targets."""
    host = (body.host if body else "") or ""
    detected = detect_targets()
    stats = sync_detected_to_registry(detected, host=host)
    return {"detected_count": len(detected), "stats": stats}


@router.post("/targets/{target_id}/retire", dependencies=[Depends(require_perm("hardware.admin"))])
async def api_retire_target(target_id: str):
    target_update(target_id, state="retired")
    return {"ok": True}


@router.get("/bitstreams", dependencies=[Depends(require_perm("hardware.read"))])
async def api_list_bitstreams(limit: int = 100):
    arts = artifact_list(limit=limit)
    bits = [a for a in arts if (a.get("path") or "").lower().endswith(".bit")]
    return {"artifacts": bits}


@router.post("/sessions", dependencies=[Depends(require_perm("hardware.session.open"))])
async def api_open_session(req: OpenSessionReq, identity=Depends(get_identity)):
    try:
        return session_open(
            req.target_id,
            opened_by=identity.user.id,
            project_id=req.project_id,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post(
    "/sessions/{session_id}/close",
    dependencies=[Depends(require_perm("hardware.session.open"))],
)
async def api_close_session(session_id: str):
    if not session_get(session_id):
        raise HTTPException(404)
    session_close(session_id)
    return {"ok": True}


@router.post("/program/request", dependencies=[Depends(require_perm("hardware.program.request"))])
async def api_request_program(req: ProgramReq, identity=Depends(get_identity)):
    try:
        return request_program(
            hardware_session_id=req.hardware_session_id,
            bitstream_artifact_id=req.bitstream_artifact_id,
            requested_by=identity.user.id,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post(
    "/program/{job_id}/approve",
    dependencies=[Depends(require_perm("hardware.program.approve"))],
)
async def api_approve_program(
    job_id: str,
    req: ProgramDecisionReq,
    identity=Depends(get_identity),
):
    if not req.reason.strip():
        raise HTTPException(400, "strong approval requires a reason")
    try:
        return approve_program(job_id, approver_id=identity.user.id, reason=req.reason)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post(
    "/program/{job_id}/reject",
    dependencies=[Depends(require_perm("hardware.program.approve"))],
)
async def api_reject_program(
    job_id: str,
    req: ProgramDecisionReq,
    identity=Depends(get_identity),
):
    try:
        return reject_program(job_id, approver_id=identity.user.id, reason=req.reason)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/program/{job_id}", dependencies=[Depends(require_perm("hardware.read"))])
async def api_get_program(job_id: str):
    j = job_get(job_id)
    if not j:
        raise HTTPException(404)
    return j
