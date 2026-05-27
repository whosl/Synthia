"""Hardware data models — Phase 12."""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class TargetState(str, Enum):
    AVAILABLE = "available"
    BUSY = "busy"
    OFFLINE = "offline"
    RETIRED = "retired"


class SessionState(str, Enum):
    OPEN = "open"
    CLOSED = "closed"
    ABANDONED = "abandoned"


class ProgramJobState(str, Enum):
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    PROGRAMMING = "programming"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    ABORTED = "aborted"


@dataclass
class HardwareTarget:
    id: str
    name: str
    serial: str
    part: str
    description: str = ""
    host: str = ""
    xvc_url: str = ""
    capabilities: dict[str, Any] = field(default_factory=dict)
    state: str = TargetState.AVAILABLE.value
    last_seen_at: int | None = None
    created_at: int = 0
    updated_at: int = 0

    @classmethod
    def new(
        cls,
        *,
        name: str,
        serial: str,
        part: str,
        host: str = "",
        xvc_url: str = "",
        description: str = "",
    ) -> HardwareTarget:
        now = int(time.time() * 1000)
        return cls(
            id=str(uuid.uuid4()),
            name=name,
            serial=serial,
            part=part,
            host=host,
            xvc_url=xvc_url,
            description=description,
            created_at=now,
            updated_at=now,
            capabilities={"can_program": True, "supports_ila": False},
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class HardwareSession:
    id: str
    target_id: str
    project_id: str = ""
    opened_by: str = ""
    state: str = SessionState.OPEN.value
    metadata: dict[str, Any] = field(default_factory=dict)
    opened_at: int = 0
    closed_at: int | None = None

    @classmethod
    def new(cls, *, target_id: str, opened_by: str, project_id: str = "") -> HardwareSession:
        return cls(
            id=str(uuid.uuid4()),
            target_id=target_id,
            project_id=project_id,
            opened_by=opened_by,
            opened_at=int(time.time() * 1000),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ProgramJob:
    id: str
    hardware_session_id: str
    target_id: str
    bitstream_artifact_id: str
    bitstream_sha256: str
    bitstream_path: str
    approval_id: str
    requested_by: str
    approved_by: str = ""
    state: str = ProgramJobState.PENDING_APPROVAL.value
    error_message: str = ""
    log_artifact_id: str = ""
    started_at: int | None = None
    completed_at: int | None = None
    created_at: int = 0

    @classmethod
    def new(
        cls,
        *,
        hardware_session_id: str,
        target_id: str,
        bitstream_artifact_id: str,
        bitstream_sha256: str,
        bitstream_path: str,
        requested_by: str,
        approval_id: str,
    ) -> ProgramJob:
        return cls(
            id=str(uuid.uuid4()),
            hardware_session_id=hardware_session_id,
            target_id=target_id,
            bitstream_artifact_id=bitstream_artifact_id,
            bitstream_sha256=bitstream_sha256,
            bitstream_path=bitstream_path,
            approval_id=approval_id,
            requested_by=requested_by,
            created_at=int(time.time() * 1000),
        )

    def to_dict(self) -> dict:
        return asdict(self)


_JOB_TRANSITIONS = {
    "pending_approval": {"approved", "aborted", "failed"},
    "approved": {"programming", "aborted"},
    "programming": {"succeeded", "failed", "aborted"},
    "succeeded": set(),
    "failed": set(),
    "aborted": set(),
}


class InvalidJobTransition(ValueError):
    pass


def assert_job_transition(src: str, dst: str) -> None:
    if dst not in _JOB_TRANSITIONS.get(src, set()):
        raise InvalidJobTransition(f"{src} → {dst} not allowed")
