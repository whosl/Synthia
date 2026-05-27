"""Hardware session + ProgramJob orchestration — Phase 12."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from edagent_vivado.auth.audit import log_audit
from edagent_vivado.hardware.models import (
    HardwareSession,
    ProgramJob,
    SessionState,
    assert_job_transition,
)
from edagent_vivado.hardware.programmer import program_target, sha256_file
from edagent_vivado.hardware.target_registry import target_get
from edagent_vivado.repository.db import get_db

logger = logging.getLogger(__name__)


def session_open(target_id: str, opened_by: str, project_id: str = "") -> dict:
    target = target_get(target_id)
    if not target:
        raise ValueError("target not found")
    if target["state"] != "available":
        raise RuntimeError(f"target busy or offline: state={target['state']}")

    s = HardwareSession.new(
        target_id=target_id,
        opened_by=opened_by,
        project_id=project_id,
    )
    db = get_db()
    db.execute(
        "INSERT INTO hardware_sessions "
        "(id, target_id, project_id, opened_by, state, metadata_json, opened_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (
            s.id,
            s.target_id,
            s.project_id,
            s.opened_by,
            s.state,
            json.dumps(s.metadata),
            s.opened_at,
        ),
    )
    db.commit()
    return s.to_dict()


def session_close(session_id: str) -> None:
    db = get_db()
    db.execute(
        "UPDATE hardware_sessions SET state=?, closed_at=? WHERE id=?",
        (SessionState.CLOSED.value, int(time.time() * 1000), session_id),
    )
    db.commit()


def session_get(session_id: str) -> dict | None:
    db = get_db()
    r = db.execute("SELECT * FROM hardware_sessions WHERE id=?", (session_id,)).fetchone()
    return dict(r) if r else None


def request_program(
    *,
    hardware_session_id: str,
    bitstream_artifact_id: str,
    requested_by: str,
) -> dict:
    """Create a ProgramJob in pending_approval state."""
    from edagent_vivado.repository.store import approval_create, artifact_get

    art = artifact_get(bitstream_artifact_id)
    if not art:
        raise ValueError("bitstream artifact not found")

    bit_path = art.get("path", "")
    if not Path(bit_path).exists():
        raise FileNotFoundError(f"bitstream file missing: {bit_path}")

    sha256 = sha256_file(Path(bit_path))

    sess = session_get(hardware_session_id)
    if not sess:
        raise ValueError("session not found")

    target_id = sess["target_id"]
    target = target_get(target_id)
    if target and target.get("part"):
        pass

    approval = approval_create(
        "hardware_program",
        {
            "target_id": target_id,
            "bitstream_artifact_id": bitstream_artifact_id,
            "bitstream_sha256": sha256,
            "bitstream_path": bit_path,
            "requested_by": requested_by,
        },
        risk_level="high",
        metadata={"requires_strong_approval": True},
    )

    job = ProgramJob.new(
        hardware_session_id=hardware_session_id,
        target_id=target_id,
        bitstream_artifact_id=bitstream_artifact_id,
        bitstream_sha256=sha256,
        bitstream_path=bit_path,
        approval_id=approval.get("id", ""),
        requested_by=requested_by,
    )

    db = get_db()
    db.execute(
        "INSERT INTO program_jobs "
        "(id, hardware_session_id, target_id, bitstream_artifact_id, "
        "bitstream_sha256, bitstream_path, approval_id, requested_by, "
        "state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            job.id,
            job.hardware_session_id,
            job.target_id,
            job.bitstream_artifact_id,
            job.bitstream_sha256,
            job.bitstream_path,
            job.approval_id,
            job.requested_by,
            job.state,
            job.created_at,
        ),
    )
    db.commit()

    log_audit(
        actor_user_id=requested_by,
        action="program.request",
        resource_type="program_job",
        resource_id=job.id,
        details={
            "target_id": target_id,
            "sha256": sha256,
            "bitstream": Path(bit_path).name,
        },
    )

    return {"job": job.to_dict(), "approval": approval}


def approve_program(job_id: str, approver_id: str, reason: str = "") -> dict:
    """Transition pending_approval → approved → programming → succeeded/failed."""
    job = job_get(job_id)
    if not job:
        raise ValueError("job not found")

    assert_job_transition(job["state"], "approved")
    _job_update(job_id, state="approved", approved_by=approver_id)
    log_audit(
        actor_user_id=approver_id,
        action="program.approve",
        resource_type="program_job",
        resource_id=job_id,
        details={"reason": reason, "target_id": job["target_id"]},
    )

    assert_job_transition("approved", "programming")
    _job_update(job_id, state="programming", started_at=int(time.time() * 1000))

    job_obj = _hydrate(job_get(job_id))
    vivado_path = "mock" if os.environ.get("SYNTHIA_HW_MOCK_PROGRAM") else "vivado"
    result = program_target(job_obj, vivado_path=vivado_path)

    if result.success:
        log_artifact_id = _persist_log_artifact(
            result.log_path,
            target_id=job["target_id"],
            session_id=job["hardware_session_id"],
        )
        _job_update(
            job_id,
            state="succeeded",
            completed_at=int(time.time() * 1000),
            log_artifact_id=log_artifact_id,
        )
        log_audit(
            actor_user_id=approver_id,
            action="program.succeeded",
            resource_type="program_job",
            resource_id=job_id,
            details={"elapsed_ms": result.elapsed_ms, "log_artifact": log_artifact_id},
        )
    else:
        log_artifact_id = _persist_log_artifact(
            result.log_path,
            target_id=job["target_id"],
            session_id=job["hardware_session_id"],
        )
        _job_update(
            job_id,
            state="failed",
            completed_at=int(time.time() * 1000),
            error_message=result.error,
            log_artifact_id=log_artifact_id,
        )
        log_audit(
            actor_user_id=approver_id,
            action="program.failed",
            resource_type="program_job",
            resource_id=job_id,
            details={"error": result.error, "log_artifact": log_artifact_id},
            success=False,
            error_message=result.error,
        )

    return job_get(job_id) or {}


def reject_program(job_id: str, approver_id: str, reason: str = "") -> dict:
    job = job_get(job_id)
    if not job:
        raise ValueError("job not found")
    assert_job_transition(job["state"], "aborted")
    _job_update(
        job_id,
        state="aborted",
        error_message=reason,
        completed_at=int(time.time() * 1000),
    )
    log_audit(
        actor_user_id=approver_id,
        action="program.reject",
        resource_type="program_job",
        resource_id=job_id,
        details={"reason": reason},
        success=False,
    )
    return job_get(job_id) or {}


def job_get(job_id: str) -> dict | None:
    db = get_db()
    r = db.execute("SELECT * FROM program_jobs WHERE id=?", (job_id,)).fetchone()
    return dict(r) if r else None


def _job_update(job_id: str, **fields) -> None:
    if not fields:
        return
    db = get_db()
    sql = "UPDATE program_jobs SET " + ", ".join(f"{k}=?" for k in fields) + " WHERE id=?"
    db.execute(sql, (*fields.values(), job_id))
    db.commit()


def _hydrate(d: dict | None) -> ProgramJob:
    if not d:
        raise ValueError("job not found")
    return ProgramJob(
        id=d["id"],
        hardware_session_id=d["hardware_session_id"],
        target_id=d["target_id"],
        bitstream_artifact_id=d["bitstream_artifact_id"],
        bitstream_sha256=d["bitstream_sha256"],
        bitstream_path=d["bitstream_path"],
        approval_id=d["approval_id"],
        requested_by=d["requested_by"],
        approved_by=d.get("approved_by", ""),
        state=d["state"],
        created_at=d.get("created_at", 0),
    )


def _persist_log_artifact(log_path: str, *, target_id: str, session_id: str) -> str:
    try:
        from edagent_vivado.repository.store import artifact_create

        p = Path(log_path)
        size = p.stat().st_size if p.exists() else 0
        art = artifact_create(
            "program_log",
            log_path,
            session_id=session_id,
            size_bytes=size,
            metadata={"target_id": target_id, "session_id": session_id},
        )
        return art.get("id", "")
    except Exception:
        logger.exception("failed to persist log artifact")
        return ""
