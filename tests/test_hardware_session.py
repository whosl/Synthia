"""Phase 12 — hardware session and programmer."""

from __future__ import annotations

import importlib

import pytest

from edagent_vivado.repository import db as db_mod


@pytest.fixture()
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.delenv("VIVADO_REMOTE_HOST", raising=False)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "hw.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    monkeypatch.setenv("SYNTHIA_AUTH_TEST_MODE", "1")
    monkeypatch.setenv("SYNTHIA_HW_MOCK_PROGRAM", "1")
    importlib.reload(db_mod)
    db_mod.close_db()
    db_mod.init_db()
    yield
    db_mod.close_db()


def test_job_state_machine():
    from edagent_vivado.hardware.models import InvalidJobTransition, assert_job_transition

    assert_job_transition("pending_approval", "approved")
    assert_job_transition("approved", "programming")
    assert_job_transition("programming", "succeeded")

    with pytest.raises(InvalidJobTransition):
        assert_job_transition("pending_approval", "programming")
    with pytest.raises(InvalidJobTransition):
        assert_job_transition("succeeded", "programming")


def test_target_busy_blocks_session(fresh_db):
    from edagent_vivado.hardware.models import HardwareTarget
    from edagent_vivado.hardware.session import session_open
    from edagent_vivado.hardware.target_registry import target_create, target_update

    t = HardwareTarget.new(name="t", serial="s/0", part="x")
    target_create(t)
    target_update(t.id, state="busy")

    with pytest.raises(RuntimeError, match="busy"):
        session_open(t.id, opened_by="u1")


def test_program_sha_mismatch(tmp_path):
    from edagent_vivado.hardware.models import ProgramJob, ProgramJobState
    from edagent_vivado.hardware.programmer import program_target

    bit = tmp_path / "fake.bit"
    bit.write_bytes(b"contents")

    job = ProgramJob.new(
        hardware_session_id="s1",
        target_id="t1",
        bitstream_artifact_id="a1",
        bitstream_sha256="0" * 64,
        bitstream_path=str(bit),
        requested_by="u1",
        approval_id="ap1",
    )
    job.state = ProgramJobState.APPROVED.value

    res = program_target(job, vivado_path="nonexistent")
    assert not res.success
    assert "sha256" in res.error


def test_program_file_missing(tmp_path):
    from edagent_vivado.hardware.models import ProgramJob, ProgramJobState
    from edagent_vivado.hardware.programmer import program_target

    job = ProgramJob.new(
        hardware_session_id="s1",
        target_id="t1",
        bitstream_artifact_id="a1",
        bitstream_sha256="x" * 64,
        bitstream_path=str(tmp_path / "missing.bit"),
        requested_by="u1",
        approval_id="ap1",
    )
    job.state = ProgramJobState.APPROVED.value
    res = program_target(job)
    assert not res.success
    assert "not found" in res.error


def test_approve_program_mock_flow(fresh_db, tmp_path):
    from edagent_vivado.hardware.models import HardwareTarget
    from edagent_vivado.hardware.session import approve_program, request_program, session_open
    from edagent_vivado.hardware.target_registry import target_create
    from edagent_vivado.repository.store import artifact_create

    t = HardwareTarget.new(name="board", serial="Mock/0", part="xc7a50t")
    target_create(t)
    sess = session_open(t.id, opened_by="u1")

    bit = tmp_path / "design.bit"
    bit.write_bytes(b"bitstream-bytes")
    art = artifact_create("bitstream", str(bit), session_id=sess["id"])

    result = request_program(
        hardware_session_id=sess["id"],
        bitstream_artifact_id=art["id"],
        requested_by="u1",
    )
    job_id = result["job"]["id"]

    final = approve_program(job_id, approver_id="u2", reason="smoke test")
    assert final["state"] == "succeeded"
