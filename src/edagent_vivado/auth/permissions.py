"""Permission check — Phase 8."""

from __future__ import annotations

import fnmatch
import json
from typing import Iterable

from edagent_vivado.repository.db import get_db

_ROLE_PERMS_CACHE: dict[str, list[str]] = {}


class PermissionError(Exception):
    def __init__(self, perm: str, role: str):
        self.perm = perm
        self.role = role
        super().__init__(f"role '{role}' lacks permission '{perm}'")


def _load_role_perms(role_name: str) -> list[str]:
    if role_name in _ROLE_PERMS_CACHE:
        return _ROLE_PERMS_CACHE[role_name]
    row = get_db().execute(
        "SELECT permissions_json FROM roles WHERE name = ?", (role_name,)
    ).fetchone()
    if not row:
        return []
    perms = json.loads(row["permissions_json"] or "[]")
    _ROLE_PERMS_CACHE[role_name] = perms
    return perms


def invalidate_perm_cache(role_name: str = "") -> None:
    if role_name:
        _ROLE_PERMS_CACHE.pop(role_name, None)
    else:
        _ROLE_PERMS_CACHE.clear()


def check_permission(role_name: str, permission: str) -> bool:
    perms = _load_role_perms(role_name)
    for p in perms:
        if p == "*":
            return True
        if fnmatch.fnmatchcase(permission, p):
            return True
    return False


def check_any(role_name: str, permissions: Iterable[str]) -> bool:
    return any(check_permission(role_name, p) for p in permissions)
