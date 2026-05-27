"""Audit log query — Phase 8."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from edagent_vivado.auth.audit import list_audits
from edagent_vivado.web.dependencies import require_perm

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("/logs", dependencies=[Depends(require_perm("audit.read"))])
async def api_audit_logs(
    actor_user_id: str = Query(""),
    action: str = Query(""),
    resource_type: str = Query(""),
    resource_id: str = Query(""),
    project_id: str = Query(""),
    since_ms: int = Query(0),
    until_ms: int = Query(0),
    limit: int = Query(200, le=1000),
    offset: int = Query(0),
):
    rows = list_audits(
        actor_user_id=actor_user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        project_id=project_id,
        since_ms=since_ms,
        until_ms=until_ms,
        limit=limit,
        offset=offset,
    )
    return {"logs": rows, "count": len(rows)}
