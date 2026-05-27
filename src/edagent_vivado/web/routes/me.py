"""Current user identity — Phase 8."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from edagent_vivado.web.dependencies import get_identity

router = APIRouter(tags=["me"])


@router.get("/me")
async def api_me(identity=Depends(get_identity)):
    return {
        "user": {
            "id": identity.user.id,
            "username": identity.user.username,
            "display_name": identity.user.display_name,
            "global_role": identity.user.global_role,
            "is_admin": identity.user.is_admin,
        },
        "project_roles": identity.project_roles,
    }
