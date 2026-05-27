"""User identity resolution — Phase 8."""

from __future__ import annotations

import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from edagent_vivado.repository.db import get_db


@dataclass
class User:
    id: str
    username: str
    display_name: str = ""
    global_role: str = "viewer"
    is_active: bool = True
    is_service_account: bool = False

    @property
    def is_admin(self) -> bool:
        return self.global_role == "admin"


@dataclass
class Identity:
    user: User
    project_roles: dict[str, str] = field(default_factory=dict)

    def role_for_project(self, project_id: str) -> str:
        if self.user.global_role == "admin":
            return "admin"
        if project_id and project_id in self.project_roles:
            return self.project_roles[project_id]
        return self.user.global_role


def _row_to_user(row) -> User:
    return User(
        id=row["id"],
        username=row["username"],
        display_name=row["display_name"] or "",
        global_role=row["global_role"] or "viewer",
        is_active=bool(row["is_active"]),
        is_service_account=bool(row["is_service_account"]),
    )


def get_user_by_token(token: str) -> Optional[User]:
    if not token:
        return None
    row = get_db().execute(
        "SELECT id, username, display_name, global_role, is_active, is_service_account "
        "FROM users WHERE api_token = ? AND is_active = 1",
        (token,),
    ).fetchone()
    if not row:
        return None
    return _row_to_user(row)


def get_user_by_username(username: str) -> Optional[User]:
    row = get_db().execute(
        "SELECT id, username, display_name, global_role, is_active, is_service_account "
        "FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    return _row_to_user(row) if row else None


def get_user_by_id(user_id: str) -> Optional[User]:
    if not user_id:
        return None
    row = get_db().execute(
        "SELECT id, username, display_name, global_role, is_active, is_service_account "
        "FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return _row_to_user(row) if row else None


def load_identity(token: str) -> Optional[Identity]:
    user = get_user_by_token(token)
    if not user:
        try:
            from edagent_vivado.web.auth import legacy_token_matches

            if legacy_token_matches(token):
                user = get_user_by_username("admin")
        except Exception:
            user = None
    if not user:
        return None

    rows = get_db().execute(
        "SELECT project_id, role_name FROM project_members WHERE user_id = ?",
        (user.id,),
    ).fetchall()
    project_roles = {r["project_id"]: r["role_name"] for r in rows}

    try:
        db = get_db()
        db.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            (int(time.time() * 1000), user.id),
        )
        db.commit()
    except Exception:
        pass

    return Identity(user=user, project_roles=project_roles)


def list_users() -> list[dict]:
    rows = get_db().execute(
        "SELECT id, username, display_name, email, global_role, is_active, "
        "is_service_account, created_at, last_login_at FROM users ORDER BY username"
    ).fetchall()
    return [dict(r) for r in rows]


def create_user(
    *,
    username: str,
    display_name: str = "",
    email: str = "",
    global_role: str = "viewer",
    is_service_account: bool = False,
    api_token: str | None = None,
) -> dict:
    user_id = str(uuid.uuid4())
    token = api_token or secrets.token_urlsafe(32)
    now = int(time.time() * 1000)
    get_db().execute(
        "INSERT INTO users (id, username, display_name, email, api_token, "
        "global_role, is_service_account, is_active, created_at) VALUES (?,?,?,?,?,?,?,1,?)",
        (
            user_id,
            username,
            display_name,
            email,
            token,
            global_role,
            1 if is_service_account else 0,
            now,
        ),
    )
    get_db().commit()
    return {
        "id": user_id,
        "username": username,
        "api_token": token,
        "global_role": global_role,
        "is_service_account": is_service_account,
    }


def add_project_member(
    project_id: str,
    user_id: str,
    role_name: str,
    *,
    added_by: str = "",
) -> None:
    from edagent_vivado.repository.connection import get_backend

    db = get_db()
    now = int(time.time() * 1000)
    if get_backend() == "postgres":
        db.execute(
            "INSERT INTO project_members (project_id, user_id, role_name, added_by, added_at) "
            "VALUES (?,?,?,?,?) "
            "ON CONFLICT (project_id, user_id) DO UPDATE SET "
            "role_name = EXCLUDED.role_name, added_by = EXCLUDED.added_by, added_at = EXCLUDED.added_at",
            (project_id, user_id, role_name, added_by, now),
        )
    else:
        db.execute(
            "INSERT OR REPLACE INTO project_members (project_id, user_id, role_name, added_by, added_at) "
            "VALUES (?,?,?,?,?)",
            (project_id, user_id, role_name, added_by, now),
        )
    db.commit()
