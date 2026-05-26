"""Bridge Timeline interactions ↔ unified approvals table (Phase 6D)."""

from __future__ import annotations

import json
import time
from typing import Any

from edagent_vivado.harness.interaction import Interaction, InteractionStatus, InteractionType
from edagent_vivado.repository.db import get_db
from edagent_vivado.repository.store import (
    approval_create,
    approval_find_by_interaction,
    approval_get,
    approval_list,
    approval_update,
    event_list,
    event_list_by_type,
)


def _approval_type_for_interaction(interaction: Interaction) -> str:
    if interaction.files:
        return "file_changes"
    reason = (interaction.reason or "").strip()
    if reason.startswith("{"):
        try:
            payload = json.loads(reason)
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict):
            if payload.get("tcl_command"):
                return "tcl_execution"
            if payload.get("manifest_path") or payload.get("action"):
                return "vivado_execution"
    if interaction.interaction_type == InteractionType.APPROVAL:
        return "vivado_execution"
    return "input_request"


def _risk_for_interaction(interaction: Interaction) -> str:
    if interaction.files and len(interaction.files) > 3:
        return "high"
    if interaction.files:
        return "medium"
    return "low"


def mirror_interaction_to_approval(
    interaction: Interaction,
    *,
    run_id: str = "",
    connector_id: str = "vivado",
) -> dict | None:
    """Create or update approvals row linked to interaction.requested."""
    existing = approval_find_by_interaction(interaction.id)
    if existing:
        return existing

    approval_type = _approval_type_for_interaction(interaction)

    payload = interaction.to_dict()
    row = approval_create(
        approval_type,
        payload,
        session_id=interaction.session_id,
        task_id=interaction.task_id,
        run_id=run_id,
        connector_id=connector_id,
        risk_level=_risk_for_interaction(interaction),
        interaction_id=interaction.id,
    )
    return row


def sync_approval_on_interaction_resolved(interaction: Interaction) -> dict | None:
    """Update approvals row when user responds via /interactions/{id}/respond."""
    row = approval_find_by_interaction(interaction.id)
    if not row:
        row = mirror_interaction_to_approval(interaction)
    if not row:
        return None

    status_map = {
        InteractionStatus.APPROVED: "approved",
        InteractionStatus.REJECTED: "rejected",
        InteractionStatus.RESPONDED: "approved",
    }
    new_status = status_map.get(interaction.status, "pending")
    now = int(time.time())
    return approval_update(
        row["id"],
        status=new_status,
        decided_at=now,
        decided_by="user",
        payload_json=json.dumps(interaction.to_dict(), ensure_ascii=False),
    )


def _parse_event_payload(ev: dict) -> dict:
    raw = ev.get("payload_json") or "{}"
    try:
        payload = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _interaction_still_pending(interaction_id: str) -> bool:
    row = approval_find_by_interaction(interaction_id)
    if row and row.get("status") != "pending":
        return False
    resolved = get_db().execute(
        """SELECT 1 FROM events WHERE event_type IN (
               'interaction.approved','interaction.rejected','interaction.responded'
           ) AND (payload_json LIKE ? OR payload_json LIKE ?) LIMIT 1""",
        (f'%"id": "{interaction_id}"%', f'%"interaction_id": "{interaction_id}"%'),
    ).fetchone()
    return resolved is None


def _append_pending_interaction_row(
    rows: list[dict],
    seen_interactions: set[str],
    ev: dict,
    payload: dict,
    *,
    session_id: str = "",
) -> None:
    iid = str(payload.get("id") or payload.get("interaction_id") or "")
    if not iid or iid in seen_interactions:
        return
    if payload.get("status") not in (None, "pending", ""):
        return
    if not _interaction_still_pending(iid):
        return
    rows.append({
        "id": f"interaction:{iid}",
        "approval_type": "file_changes" if payload.get("files") else "input_request",
        "status": "pending",
        "session_id": payload.get("session_id") or ev.get("session_id") or session_id,
        "task_id": payload.get("task_id") or ev.get("task_id"),
        "interaction_id": iid,
        "payload": payload,
        "risk_level": "medium",
        "created_at": ev.get("created_at"),
        "_source": "interaction",
    })
    seen_interactions.add(iid)


def list_pending_approvals_unified(
    *,
    session_id: str = "",
    limit: int = 100,
) -> list[dict]:
    """Merge DB approvals with pending interactions not yet mirrored."""
    rows = approval_list(status="pending", session_id=session_id, limit=limit)
    seen_interactions = {r.get("interaction_id") for r in rows if r.get("interaction_id")}

    events = (
        event_list(session_id, limit=500)
        if session_id
        else event_list_by_type("interaction.requested", limit=limit * 3)
    )
    for ev in events:
        if ev.get("event_type") != "interaction.requested":
            continue
        payload = _parse_event_payload(ev)
        _append_pending_interaction_row(rows, seen_interactions, ev, payload, session_id=session_id)
        if len(rows) >= limit:
            break
    return rows[:limit]


def get_unified_approval_detail(approval_id: str, interaction_id: str = "") -> dict | None:
    """Resolve approval row or synthetic interaction-backed approval."""
    if interaction_id:
        existing = approval_find_by_interaction(interaction_id)
        if existing:
            return existing
        from edagent_vivado.harness.interaction import _load_requested_interaction_payload

        loaded = _load_requested_interaction_payload(interaction_id)
        if not loaded:
            return None
        payload, sid, tid = loaded
        return {
            "id": approval_id,
            "approval_type": "file_changes" if payload.get("files") else "input_request",
            "status": "pending",
            "session_id": sid,
            "task_id": tid,
            "interaction_id": interaction_id,
            "payload": payload,
            "risk_level": "medium",
            "_source": "interaction",
        }
    return approval_get(approval_id)


def resolve_unified_approval_id(approval_id: str) -> tuple[str, str]:
    """Return (kind, id) where kind is 'approval' or 'interaction'."""
    if approval_id.startswith("interaction:"):
        return "interaction", approval_id.split(":", 1)[1]
    row = approval_get(approval_id)
    if row and row.get("interaction_id"):
        return "interaction", str(row["interaction_id"])
    return "approval", approval_id
