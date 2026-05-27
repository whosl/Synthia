"""RBAC admin endpoints — Phase 8."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from edagent_vivado.auth.audit import log_audit
from edagent_vivado.auth.identity import add_project_member, create_user, get_user_by_id, list_users
from edagent_vivado.auth.permissions import invalidate_perm_cache
from edagent_vivado.repository.db import get_db
from edagent_vivado.web.dependencies import get_identity, require_role

router = APIRouter(prefix="/admin", tags=["rbac-admin"])


class CreateUserReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    username: str
    display_name: str = ""
    email: str = ""
    global_role: str = "viewer"
    is_service_account: bool = False


class AddMemberReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: str
    role_name: str


@router.get("/users", dependencies=[Depends(require_role("admin"))])
async def api_list_users():
    return {"users": list_users()}


@router.post("/users", dependencies=[Depends(require_role("admin"))])
async def api_create_user(req: CreateUserReq, identity=Depends(get_identity)):
    user = create_user(
        username=req.username,
        display_name=req.display_name,
        email=req.email,
        global_role=req.global_role,
        is_service_account=req.is_service_account,
    )
    log_audit(
        actor_user_id=identity.user.id,
        action="user.create",
        resource_type="user",
        resource_id=user["id"],
        details={"username": req.username, "role": req.global_role},
    )
    invalidate_perm_cache()
    return user


@router.post("/users/{user_id}/deactivate", dependencies=[Depends(require_role("admin"))])
async def api_deactivate_user(user_id: str, identity=Depends(get_identity)):
    get_db().execute("UPDATE users SET is_active=0 WHERE id=?", (user_id,))
    get_db().commit()
    log_audit(
        actor_user_id=identity.user.id,
        action="user.deactivate",
        resource_type="user",
        resource_id=user_id,
    )
    invalidate_perm_cache()
    return {"ok": True}


@router.post("/users/{user_id}/rotate-token", dependencies=[Depends(require_role("admin"))])
async def api_rotate_token(user_id: str, identity=Depends(get_identity)):
    new_token = secrets.token_urlsafe(32)
    get_db().execute("UPDATE users SET api_token=? WHERE id=?", (new_token, user_id))
    get_db().commit()
    log_audit(
        actor_user_id=identity.user.id,
        action="user.rotate_token",
        resource_type="user",
        resource_id=user_id,
    )
    return {"user_id": user_id, "api_token": new_token}


@router.post(
    "/projects/{project_id}/members",
    dependencies=[Depends(require_role("admin", "project_owner"))],
)
async def api_add_member(project_id: str, req: AddMemberReq, identity=Depends(get_identity)):
    if not get_user_by_id(req.user_id):
        raise HTTPException(404, "user not found")
    add_project_member(project_id, req.user_id, req.role_name, added_by=identity.user.id)
    log_audit(
        actor_user_id=identity.user.id,
        action="project.member.add",
        resource_type="project",
        resource_id=project_id,
        project_id=project_id,
        details={"user_id": req.user_id, "role": req.role_name},
    )
    invalidate_perm_cache()
    return {"ok": True}


@router.delete(
    "/projects/{project_id}/members/{user_id}",
    dependencies=[Depends(require_role("admin", "project_owner"))],
)
async def api_remove_member(project_id: str, user_id: str, identity=Depends(get_identity)):
    get_db().execute(
        "DELETE FROM project_members WHERE project_id=? AND user_id=?",
        (project_id, user_id),
    )
    get_db().commit()
    log_audit(
        actor_user_id=identity.user.id,
        action="project.member.remove",
        resource_type="project",
        resource_id=project_id,
        project_id=project_id,
        details={"user_id": user_id},
    )
    invalidate_perm_cache()
    return {"ok": True}


@router.post("/cache/invalidate-permissions", dependencies=[Depends(require_role("admin"))])
async def api_invalidate_perms():
    invalidate_perm_cache()
    return {"ok": True}
