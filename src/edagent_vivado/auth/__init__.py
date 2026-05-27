"""RBAC + audit — Phase 8."""

from edagent_vivado.auth.audit import list_audits, log_audit
from edagent_vivado.auth.identity import (
    Identity,
    User,
    add_project_member,
    create_user,
    get_user_by_id,
    get_user_by_token,
    list_users,
    load_identity,
)
from edagent_vivado.auth.permissions import (
    PermissionError,
    check_any,
    check_permission,
    invalidate_perm_cache,
)

__all__ = [
    "Identity",
    "User",
    "add_project_member",
    "create_user",
    "get_user_by_id",
    "get_user_by_token",
    "list_users",
    "load_identity",
    "list_audits",
    "log_audit",
    "PermissionError",
    "check_any",
    "check_permission",
    "invalidate_perm_cache",
]
