"""Audit log helper — Phase 8."""

from __future__ import annotations

import json
import logging
import time

from edagent_vivado.repository.db import get_db

logger = logging.getLogger(__name__)


def log_audit(
    *,
    actor_user_id: str = "",
    actor_kind: str = "user",
    action: str,
    resource_type: str = "",
    resource_id: str = "",
    project_id: str = "",
    session_id: str = "",
    ip_address: str = "",
    user_agent: str = "",
    details: dict | None = None,
    success: bool = True,
    error_message: str = "",
) -> None:
    try:
        db = get_db()
        db.execute(
            "INSERT INTO audit_logs "
            "(actor_user_id, actor_kind, action, resource_type, resource_id, "
            "project_id, session_id, ip_address, user_agent, details_json, "
            "success, error_message, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                actor_user_id,
                actor_kind,
                action,
                resource_type,
                resource_id,
                project_id,
                session_id,
                ip_address,
                user_agent,
                json.dumps(details or {}, ensure_ascii=False),
                1 if success else 0,
                error_message,
                int(time.time() * 1000),
            ),
        )
        db.commit()
    except Exception:
        logger.exception("audit log failed action=%s resource=%s", action, resource_id)


def list_audits(
    *,
    actor_user_id: str = "",
    action: str = "",
    resource_type: str = "",
    resource_id: str = "",
    project_id: str = "",
    since_ms: int = 0,
    until_ms: int = 0,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    where: list[str] = []
    params: list = []
    if actor_user_id:
        where.append("actor_user_id = ?")
        params.append(actor_user_id)
    if action:
        where.append("action = ?")
        params.append(action)
    if resource_type:
        where.append("resource_type = ?")
        params.append(resource_type)
    if resource_id:
        where.append("resource_id = ?")
        params.append(resource_id)
    if project_id:
        where.append("project_id = ?")
        params.append(project_id)
    if since_ms:
        where.append("created_at >= ?")
        params.append(since_ms)
    if until_ms:
        where.append("created_at <= ?")
        params.append(until_ms)

    sql = "SELECT * FROM audit_logs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    rows = get_db().execute(sql, params).fetchall()
    return [dict(r) for r in rows]
