"""Human-in-the-loop interaction system — approval gates and input requests.

This module provides the mechanism for the agent to pause execution and
request user input (approvals, selections, text input) via SSE events.
The agent task runner checks for pending interactions and blocks until
the user responds.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class InteractionType(str, Enum):
    APPROVAL = "approval"
    INPUT_REQUEST = "input_request"


class InteractionStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    RESPONDED = "responded"


@dataclass
class FileItem:
    path: str
    content: str
    description: str = ""
    action: str = "create"  # create | modify | delete


@dataclass
class InputField:
    id: str
    label: str
    field_type: str = "text"  # text | select | search_select
    options: list[dict[str, str]] | None = None  # [{value, label}]
    placeholder: str = ""
    recommendations: list[str] | None = None
    required: bool = True


@dataclass
class Interaction:
    id: str
    interaction_type: InteractionType
    session_id: str
    task_id: str
    title: str
    message: str = ""
    reason: str = ""  # LLM justification shown in approval UI (申请理由)
    status: InteractionStatus = InteractionStatus.PENDING
    created_at: int = 0

    # For approval
    files: list[FileItem] = field(default_factory=list)

    # For input_request
    fields: list[InputField] = field(default_factory=list)

    # Response data
    response: dict[str, Any] = field(default_factory=dict)
    responded_at: int | None = None

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "interaction_id": self.id,
            "interaction_type": self.interaction_type.value,
            "session_id": self.session_id,
            "task_id": self.task_id,
            "title": self.title,
            "message": self.message,
            "reason": self.reason,
            "status": self.status.value,
            "created_at": self.created_at,
            "response": self.response,
            "responded_at": self.responded_at,
        }
        if self.files:
            d["files"] = [{"path": f.path, "content": f.content, "description": f.description, "action": f.action} for f in self.files]
        if self.fields:
            d["fields"] = [{"id": f.id, "label": f.label, "field_type": f.field_type, "options": f.options,
                           "placeholder": f.placeholder, "recommendations": f.recommendations, "required": f.required} for f in self.fields]
        return d


# In-memory store for pending interactions (per session)
_interactions: dict[str, Interaction] = {}
_interaction_events: dict[str, asyncio.Event] = {}

# Pending file ops batched per task (flushed before next non-file tool or task end)
_file_batches: dict[str, list[FileItem]] = {}
_file_batch_meta: dict[str, dict[str, str]] = {}


def _batch_key(session_id: str, task_id: str) -> str:
    return f"{session_id}:{task_id}"


def append_file_to_batch(
    session_id: str,
    task_id: str,
    file_item: FileItem,
    *,
    title: str = "File changes pending approval",
    message: str = "",
) -> int:
    """Queue a file create/modify for a single batched approval gate."""
    key = _batch_key(session_id, task_id)
    batch = _file_batches.setdefault(key, [])
    batch.append(file_item)
    meta = _file_batch_meta.setdefault(key, {"title": title, "message": message})
    if len(batch) > 1:
        meta["title"] = "File changes pending approval"
        meta["message"] = message or f"{len(batch)} files queued for your review."
    else:
        meta["title"] = title
        meta["message"] = message
    return len(batch)


def take_file_batch(session_id: str, task_id: str) -> tuple[list[FileItem], str, str]:
    """Pop queued files and return (files, title, message)."""
    key = _batch_key(session_id, task_id)
    files = _file_batches.pop(key, [])
    meta = _file_batch_meta.pop(key, {"title": "File changes pending approval", "message": ""})
    return files, meta.get("title", "File changes pending approval"), meta.get("message", "")


def pending_file_batch_count(session_id: str, task_id: str) -> int:
    return len(_file_batches.get(_batch_key(session_id, task_id), []))


def create_interaction(
    interaction_type: InteractionType,
    session_id: str,
    task_id: str,
    title: str,
    message: str = "",
    files: list[FileItem] | None = None,
    fields: list[InputField] | None = None,
    reason: str = "",
) -> Interaction:
    interaction = Interaction(
        id=uuid.uuid4().hex[:12],
        interaction_type=interaction_type,
        session_id=session_id,
        task_id=task_id,
        title=title,
        message=message,
        reason=reason.strip(),
        created_at=int(time.time()),
        files=files or [],
        fields=fields or [],
    )
    _interactions[interaction.id] = interaction
    _interaction_events[interaction.id] = asyncio.Event()
    return interaction


def interaction_from_payload(payload: dict[str, Any], session_id: str, task_id: str) -> Interaction:
    """Rebuild an Interaction from event payload / to_dict()."""
    files = [
        FileItem(
            path=f.get("path", ""),
            content=f.get("content", ""),
            description=f.get("description", ""),
            action=f.get("action", "create"),
        )
        for f in (payload.get("files") or [])
    ]
    fields = [
        InputField(
            id=f.get("id", ""),
            label=f.get("label", ""),
            field_type=f.get("field_type", "text"),
            options=f.get("options"),
            placeholder=f.get("placeholder", ""),
            recommendations=f.get("recommendations"),
            required=bool(f.get("required", True)),
        )
        for f in (payload.get("fields") or [])
    ]
    itype = InteractionType(payload.get("interaction_type", "approval"))
    status_raw = payload.get("status", "pending")
    try:
        status = InteractionStatus(status_raw)
    except ValueError:
        status = InteractionStatus.PENDING
    return Interaction(
        id=str(payload.get("id") or payload.get("interaction_id", "")),
        interaction_type=itype,
        session_id=session_id,
        task_id=task_id,
        title=str(payload.get("title", "")),
        message=str(payload.get("message", "")),
        reason=str(payload.get("reason", "")),
        status=status,
        created_at=int(payload.get("created_at") or time.time()),
        files=files,
        fields=fields,
        response=dict(payload.get("response") or {}),
        responded_at=payload.get("responded_at"),
    )


def _ensure_wait_event(interaction_id: str, interaction: Interaction | None = None) -> asyncio.Event:
    ev = _interaction_events.get(interaction_id)
    if ev is None:
        ev = asyncio.Event()
        _interaction_events[interaction_id] = ev
        if interaction and interaction.status != InteractionStatus.PENDING:
            ev.set()
    return ev


def rehydrate_session_interactions(session_id: str) -> list[Interaction]:
    """Restore pending interactions from persisted events (survives reload / server restart)."""
    from edagent_vivado.repository.store import event_list

    events = event_list(session_id, 0, 5000)
    resolved: set[str] = set()
    requested: dict[str, tuple[dict, str]] = {}  # id -> (payload, task_id)

    for row in events:
        raw = row.get("payload_json") or "{}"
        try:
            payload = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        iid = str(payload.get("id") or payload.get("interaction_id") or "")
        if not iid:
            continue
        if row["event_type"] == "interaction.requested":
            requested[iid] = (payload, str(row.get("task_id") or payload.get("task_id") or ""))
        elif row["event_type"] in ("interaction.approved", "interaction.rejected", "interaction.responded"):
            resolved.add(iid)

    restored: list[Interaction] = []
    for iid, (payload, task_id) in requested.items():
        if iid in resolved:
            continue
        existing = _interactions.get(iid)
        if existing:
            if existing.status == InteractionStatus.PENDING:
                _ensure_wait_event(iid, existing)
                restored.append(existing)
            continue
        interaction = interaction_from_payload(payload, session_id, task_id)
        interaction.status = InteractionStatus.PENDING
        _interactions[iid] = interaction
        _ensure_wait_event(iid, interaction)
        restored.append(interaction)
    return restored


def lookup_session_for_interaction(interaction_id: str) -> str | None:
    from edagent_vivado.repository.store import get_db

    row = get_db().execute(
        """SELECT session_id FROM events
           WHERE event_type='interaction.requested'
             AND (payload_json LIKE ? OR payload_json LIKE ?)
           ORDER BY seq DESC LIMIT 1""",
        (f'%"id": "{interaction_id}"%', f'%"interaction_id": "{interaction_id}"%'),
    ).fetchone()
    return str(row["session_id"]) if row and row["session_id"] else None


def get_interaction(interaction_id: str, session_id: str | None = None) -> Interaction | None:
    found = _interactions.get(interaction_id)
    if found:
        return found
    sid = session_id or lookup_session_for_interaction(interaction_id)
    if sid:
        rehydrate_session_interactions(sid)
        return _interactions.get(interaction_id)
    return None


def get_pending_for_session(session_id: str) -> list[Interaction]:
    rehydrate_session_interactions(session_id)
    return [i for i in _interactions.values()
            if i.session_id == session_id and i.status == InteractionStatus.PENDING]


def respond_interaction(interaction_id: str, response: dict[str, Any], session_id: str | None = None) -> Interaction | None:
    interaction = get_interaction(interaction_id, session_id=session_id)
    if not interaction:
        return None
    interaction.response = response
    interaction.responded_at = int(time.time())
    if interaction.interaction_type == InteractionType.APPROVAL:
        interaction.status = InteractionStatus.APPROVED if response.get("approved") else InteractionStatus.REJECTED
    else:
        interaction.status = InteractionStatus.RESPONDED
    evt = _interaction_events.get(interaction_id)
    if evt:
        evt.set()
    return interaction


def _task_stop_requested(task_id: str | None) -> bool:
    if not task_id:
        return False
    from edagent_vivado.repository.store import task_get

    row = task_get(task_id)
    return bool(row and row.get("stop_requested"))


async def wait_for_response(
    interaction_id: str,
    timeout: float | None = None,
    *,
    task_id: str | None = None,
) -> Interaction | None:
    """Block until user responds. Returns None on timeout or task stop."""
    interaction = _interactions.get(interaction_id)
    evt = _ensure_wait_event(interaction_id, interaction)
    if interaction is None:
        return None
    poll = 0.35
    deadline = (time.time() + timeout) if timeout else None
    while True:
        if _task_stop_requested(task_id):
            return None
        if evt.is_set():
            return _interactions.get(interaction_id)
        wait_for = poll
        if deadline is not None:
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            wait_for = min(wait_for, remaining)
        try:
            await asyncio.wait_for(evt.wait(), timeout=wait_for)
        except asyncio.TimeoutError:
            continue


def cleanup_interaction(interaction_id: str) -> None:
    _interactions.pop(interaction_id, None)
    _interaction_events.pop(interaction_id, None)
