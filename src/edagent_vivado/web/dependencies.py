"""FastAPI dependencies for auth/permission — Phase 8."""

from __future__ import annotations

from fastapi import HTTPException, Request

from edagent_vivado.auth.audit import log_audit
from edagent_vivado.auth.identity import Identity
from edagent_vivado.auth.permissions import check_permission


def get_identity(request: Request) -> Identity:
    identity = getattr(request.state, "identity", None)
    if identity is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return identity


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def _resolve_project_id(request: Request, project_id_param: str) -> str:
    if not project_id_param:
        return ""
    return (
        request.path_params.get(project_id_param)
        or request.query_params.get(project_id_param)
        or ""
    )


def require_perm(permission: str, *, project_id_param: str = "project_id"):
    async def _checker(request: Request) -> Identity:
        identity = get_identity(request)
        proj_id = _resolve_project_id(request, project_id_param)
        role = identity.role_for_project(proj_id)
        if not check_permission(role, permission):
            log_audit(
                actor_user_id=identity.user.id,
                action="auth.denied",
                resource_type="permission",
                resource_id=permission,
                project_id=proj_id,
                ip_address=_client_ip(request),
                user_agent=request.headers.get("User-Agent", ""),
                details={"role": role, "method": request.method, "path": str(request.url.path)},
                success=False,
                error_message=f"role={role} lacks={permission}",
            )
            raise HTTPException(status_code=403, detail=f"forbidden: requires {permission}")
        return identity

    return _checker


def require_role(*role_names: str):
    async def _checker(request: Request) -> Identity:
        identity = get_identity(request)
        proj_id = request.path_params.get("project_id", "")
        role = identity.role_for_project(proj_id)
        allowed = set(role_names) | {"admin"}
        if role not in allowed and identity.user.global_role not in allowed:
            log_audit(
                actor_user_id=identity.user.id,
                action="auth.denied",
                details={"required_roles": list(role_names), "role": role},
                success=False,
            )
            raise HTTPException(status_code=403, detail=f"forbidden: requires {role_names}")
        return identity

    return _checker


def assert_perm(
    identity: Identity,
    permission: str,
    *,
    project_id: str = "",
    request: Request | None = None,
) -> None:
    role = identity.role_for_project(project_id)
    if check_permission(role, permission):
        return
    log_audit(
        actor_user_id=identity.user.id,
        action="auth.denied",
        resource_type="permission",
        resource_id=permission,
        project_id=project_id,
        ip_address=_client_ip(request) if request else "",
        user_agent=request.headers.get("User-Agent", "") if request else "",
        details={"role": role},
        success=False,
    )
    raise HTTPException(status_code=403, detail=f"forbidden: requires {permission}")
