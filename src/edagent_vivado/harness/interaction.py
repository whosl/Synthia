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
            "interaction_type": self.interaction_type.value,
            "session_id": self.session_id,
            "task_id": self.task_id,
            "title": self.title,
            "message": self.message,
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


def create_interaction(
    interaction_type: InteractionType,
    session_id: str,
    task_id: str,
    title: str,
    message: str = "",
    files: list[FileItem] | None = None,
    fields: list[InputField] | None = None,
) -> Interaction:
    interaction = Interaction(
        id=uuid.uuid4().hex[:12],
        interaction_type=interaction_type,
        session_id=session_id,
        task_id=task_id,
        title=title,
        message=message,
        created_at=int(time.time()),
        files=files or [],
        fields=fields or [],
    )
    _interactions[interaction.id] = interaction
    _interaction_events[interaction.id] = asyncio.Event()
    return interaction


def get_interaction(interaction_id: str) -> Interaction | None:
    return _interactions.get(interaction_id)


def get_pending_for_session(session_id: str) -> list[Interaction]:
    return [i for i in _interactions.values()
            if i.session_id == session_id and i.status == InteractionStatus.PENDING]


def respond_interaction(interaction_id: str, response: dict[str, Any]) -> Interaction | None:
    interaction = _interactions.get(interaction_id)
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


async def wait_for_response(interaction_id: str, timeout: float | None = None) -> Interaction | None:
    """Block until user responds to an interaction. Returns None on timeout."""
    evt = _interaction_events.get(interaction_id)
    if not evt:
        return None
    try:
        if timeout:
            await asyncio.wait_for(evt.wait(), timeout)
        else:
            await evt.wait()
    except asyncio.TimeoutError:
        return None
    return _interactions.get(interaction_id)


def cleanup_interaction(interaction_id: str) -> None:
    _interactions.pop(interaction_id, None)
    _interaction_events.pop(interaction_id, None)
