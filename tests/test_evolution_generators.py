"""SE-PR3 tests: 4 candidate generators + dispatcher + dedup."""

from __future__ import annotations

import json
import time
import uuid

import pytest

from edagent_vivado.evolution import (
    aggregate_rolling,
    candidate_create,
    candidate_list,
    candidate_update_status,
    collect_task_metrics,
    feedback_create,
    gen_approval_drop,
    gen_negative_feedback,
    gen_recurrence,
    gen_repeated_failure,
    run_generators,
)
from edagent_vivado.evolution.generators import (
    APPROVAL_DROP_THRESHOLD,
    NEGATIVE_FEEDBACK_MIN_NEGATIVES,
    RECURRENCE_MIN_SESSIONS,
    REPEATED_FAILURE_THRESHOLD,
    _project_thumb_rolling,
)
from edagent_vivado.evolution.metrics import metric_snapshot_create
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import (
    problem_create,
    project_create,
    run_create,
    session_create,
    task_create,
    task_update,
    toolcall_create,
    toolcall_update,
)


def _make_project_session() -> tuple[dict, dict]:
    init_db()
    pid = project_create(
        {
            "name": f"se-pr3-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )
    s = session_create(name="m", project_id=pid["id"])
    get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
    get_db().commit()
    return pid, s


def _seed_completed_task(project_id: str, session_id: str, *, success: bool, approval_ok: bool = True) -> dict:
    t = task_create(session_id, user_message_id=None)
    task_update(t["id"], state="running", started_at=int(time.time()) - 5)
    run = run_create("task", f"task:{t['id']}", session_id=session_id, task_id=t["id"])
    tc = toolcall_create(
        run_id=run["id"],
        tool_name="run_vivado_synth_tool",
        session_id=session_id,
        task_id=t["id"],
        input_summary="{}",
    )
    outcome = "execution_succeeded" if success else "execution_failed"
    state = "completed" if approval_ok else "rejected"
    if not approval_ok:
        outcome = "user_rejected"
    toolcall_update(
        tc["id"],
        state=state,
        finished_at=int(time.time()),
        elapsed_ms=10,
        output_summary=json.dumps({
            "edagent_outcome": outcome,
            "summary": "x",
            "ran": approval_ok,
            "success": success and approval_ok,
        }),
    )
    task_update(t["id"], state="done", finished_at=int(time.time()))
    collect_task_metrics(session_id=session_id, task_id=t["id"], run_id=run["id"])
    aggregate_rolling(project_id, "rolling_10")
    return t


# ── recurrence -------------------------------------------------------------


def test_recurrence_does_not_fire_below_threshold():
    pid, s = _make_project_session()
    problem_create(
        s["id"], "ERROR: top mismatch", source="harness",
        normalized_signature="signature-A", category="vivado", severity="error",
    )
    out = gen_recurrence(project_id=pid["id"])
    assert out == []


def test_recurrence_fires_with_three_distinct_sessions():
    pid, _ = _make_project_session()
    for _ in range(RECURRENCE_MIN_SESSIONS):
        s = session_create(name="m", project_id=pid["id"])
        get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
        get_db().commit()
        problem_create(
            s["id"], "ERROR: [Synth 8-439] Module 'echo' not found",
            source="harness",
            normalized_signature="synth-8-439:echo",
            category="vivado", severity="error",
        )
    out = gen_recurrence(project_id=pid["id"])
    assert len(out) == 1
    cand = out[0]
    assert cand["surface"] == "kb"
    assert cand["status"] == "pending"
    signal = json.loads(cand["signal_source_json"])
    assert signal["sessions_n"] >= RECURRENCE_MIN_SESSIONS


def test_recurrence_dedups_across_runs():
    pid, _ = _make_project_session()
    for _ in range(RECURRENCE_MIN_SESSIONS):
        s = session_create(name="m", project_id=pid["id"])
        get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
        get_db().commit()
        problem_create(
            s["id"], "ERROR: [Synth 8-439]",
            source="harness", normalized_signature="dup-key",
            category="vivado", severity="error",
        )
    first = gen_recurrence(project_id=pid["id"])
    second = gen_recurrence(project_id=pid["id"])
    assert len(first) == 1
    assert len(second) == 1
    assert first[0]["id"] == second[0]["id"]
    assert len(candidate_list(status="pending", surface="kb", project_id=pid["id"])) == 1


def test_recurrence_after_reject_creates_new_candidate():
    """Once a pending candidate is rejected, a fresh signal must be allowed."""
    pid, _ = _make_project_session()
    for _ in range(RECURRENCE_MIN_SESSIONS):
        s = session_create(name="m", project_id=pid["id"])
        get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
        get_db().commit()
        problem_create(
            s["id"], "ERROR", source="harness",
            normalized_signature="reject-key", category="vivado", severity="error",
        )
    first = gen_recurrence(project_id=pid["id"])
    candidate_update_status(first[0]["id"], "rejected", reviewed_by="tester")
    second = gen_recurrence(project_id=pid["id"])
    assert len(second) == 1
    assert second[0]["id"] != first[0]["id"]


# ── repeated_failure -------------------------------------------------------


def test_repeated_failure_no_op_without_project():
    out = gen_repeated_failure(project_id=None)
    assert out == []


def test_repeated_failure_no_op_below_min_sample():
    pid, s = _make_project_session()
    # 4 tasks with one failure — below MIN_SAMPLE
    for ok in [True, True, True, False]:
        _seed_completed_task(pid["id"], s["id"], success=ok)
    out = gen_repeated_failure(project_id=pid["id"])
    assert out == []


def test_repeated_failure_fires_when_rate_below_threshold():
    pid, s = _make_project_session()
    # 6 tasks: 5 fail, 1 succeed -> rate = 0.166 << 0.4
    for ok in [False, False, False, True, False, False]:
        _seed_completed_task(pid["id"], s["id"], success=ok)
    out = gen_repeated_failure(project_id=pid["id"], session_id=s["id"])
    assert len(out) == 1
    cand = out[0]
    assert cand["surface"] == "prompt"
    signal = json.loads(cand["signal_source_json"])
    assert signal["first_run_success"] < REPEATED_FAILURE_THRESHOLD
    assert signal["sample_size"] >= 5


def test_repeated_failure_dedup_is_idempotent():
    pid, s = _make_project_session()
    for ok in [False] * 6:
        _seed_completed_task(pid["id"], s["id"], success=ok)
    a = gen_repeated_failure(project_id=pid["id"])
    b = gen_repeated_failure(project_id=pid["id"])
    assert a and b
    assert a[0]["id"] == b[0]["id"]


def test_repeated_failure_silent_above_threshold():
    pid, s = _make_project_session()
    for ok in [True] * 6:
        _seed_completed_task(pid["id"], s["id"], success=ok)
    out = gen_repeated_failure(project_id=pid["id"])
    assert out == []


# ── negative_feedback ------------------------------------------------------


def test_negative_feedback_project_thumb_helper():
    pid, _ = _make_project_session()
    s1 = session_create(name="m", project_id=pid["id"])
    s2 = session_create(name="m", project_id=pid["id"])
    get_db().execute(
        "UPDATE sessions SET project_id=? WHERE id IN (?, ?)",
        (pid["id"], s1["id"], s2["id"]),
    )
    get_db().commit()
    feedback_create(session_id=s1["id"], user_thumb=-1)
    feedback_create(session_id=s2["id"], user_thumb=-1)
    feedback_create(session_id=s1["id"], user_thumb=1)
    summary = _project_thumb_rolling(pid["id"], limit=10)
    assert summary["counts"]["-1"] == 2
    assert summary["counts"]["+1"] == 1
    assert summary["total"] == 3


def test_negative_feedback_fires_at_threshold():
    pid, s = _make_project_session()
    for _ in range(NEGATIVE_FEEDBACK_MIN_NEGATIVES):
        feedback_create(session_id=s["id"], user_thumb=-1)
    out = gen_negative_feedback(project_id=pid["id"], session_id=s["id"])
    assert len(out) == 1
    cand = out[0]
    assert cand["surface"] == "prompt"
    signal = json.loads(cand["signal_source_json"])
    assert signal["negatives"] >= NEGATIVE_FEEDBACK_MIN_NEGATIVES


def test_negative_feedback_silent_below_threshold():
    pid, s = _make_project_session()
    for _ in range(NEGATIVE_FEEDBACK_MIN_NEGATIVES - 1):
        feedback_create(session_id=s["id"], user_thumb=-1)
    feedback_create(session_id=s["id"], user_thumb=1)
    out = gen_negative_feedback(project_id=pid["id"], session_id=s["id"])
    assert out == []


def test_negative_feedback_dedups():
    pid, s = _make_project_session()
    for _ in range(NEGATIVE_FEEDBACK_MIN_NEGATIVES + 1):
        feedback_create(session_id=s["id"], user_thumb=-1)
    a = gen_negative_feedback(project_id=pid["id"], session_id=s["id"])
    b = gen_negative_feedback(project_id=pid["id"], session_id=s["id"])
    assert a and b
    assert a[0]["id"] == b[0]["id"]


# ── approval_drop ----------------------------------------------------------


def _seed_rolling_with_approval_rate(project_id: str, session_id: str, *, pass_rate: float, sample: int = 8) -> None:
    """Insert N task-scope snapshots and trigger rolling_10 so the rolling row carries `pass_rate`."""
    for i in range(sample):
        snap_pass = pass_rate
        metric_snapshot_create(
            scope="task", window="single",
            metrics={
                "first_run_success": True,
                "approval_pass_rate": snap_pass,
                "approval_completed": int(round(snap_pass * 10)),
                "approval_rejected": int(round((1 - snap_pass) * 10)),
                "task_tokens_total": 4000,
                "user_thumb_score": 0,
            },
            project_id=project_id, session_id=session_id, task_id=f"synthetic-{i}",
        )
    aggregate_rolling(project_id, "rolling_10")


def test_approval_drop_fires_below_threshold():
    pid, s = _make_project_session()
    _seed_rolling_with_approval_rate(pid["id"], s["id"], pass_rate=0.25, sample=6)
    out = gen_approval_drop(project_id=pid["id"], session_id=s["id"])
    assert len(out) == 1
    cand = out[0]
    assert cand["surface"] == "prompt"
    signal = json.loads(cand["signal_source_json"])
    assert signal["approval_pass_rate"] < APPROVAL_DROP_THRESHOLD


def test_approval_drop_silent_above_threshold():
    pid, s = _make_project_session()
    _seed_rolling_with_approval_rate(pid["id"], s["id"], pass_rate=0.95, sample=6)
    out = gen_approval_drop(project_id=pid["id"], session_id=s["id"])
    assert out == []


def test_approval_drop_dedups():
    pid, s = _make_project_session()
    _seed_rolling_with_approval_rate(pid["id"], s["id"], pass_rate=0.1, sample=6)
    a = gen_approval_drop(project_id=pid["id"], session_id=s["id"])
    b = gen_approval_drop(project_id=pid["id"], session_id=s["id"])
    assert a and b
    assert a[0]["id"] == b[0]["id"]


# ── dispatcher -------------------------------------------------------------


def test_run_generators_runs_all_and_collects_results():
    pid, s = _make_project_session()
    # Seed enough signals for recurrence + negative_feedback simultaneously
    for _ in range(RECURRENCE_MIN_SESSIONS):
        s2 = session_create(name="m", project_id=pid["id"])
        get_db().execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s2["id"]))
        get_db().commit()
        problem_create(
            s2["id"], "ERROR: combo-test", source="harness",
            normalized_signature="combo-key", category="vivado", severity="error",
        )
    for _ in range(NEGATIVE_FEEDBACK_MIN_NEGATIVES):
        feedback_create(session_id=s["id"], user_thumb=-1)

    events: list[dict] = []
    def sink(session_id, event_type, payload, **kwargs):
        events.append({"type": event_type, "payload": payload, **kwargs})

    out = run_generators(
        project_id=pid["id"], session_id=s["id"], task_id="", event_sink=sink,
    )
    surfaces = {
        c["candidate_id"]: c["generator"] for c in out["created"]
    }
    assert "recurrence" in surfaces.values()
    assert "negative_feedback" in surfaces.values()
    fired_signals = [e for e in events if e["type"] == "evolution.signal.fired"]
    candidate_events = [e for e in events if e["type"] == "evolution.candidate.created"]
    assert len(fired_signals) >= 2
    assert len(candidate_events) == len(out["created"])
    assert out["errors"] == {}


def test_run_generators_only_filter():
    pid, s = _make_project_session()
    for _ in range(NEGATIVE_FEEDBACK_MIN_NEGATIVES):
        feedback_create(session_id=s["id"], user_thumb=-1)
    out = run_generators(
        project_id=pid["id"], session_id=s["id"], only=["negative_feedback"],
    )
    assert all(c["generator"] == "negative_feedback" for c in out["created"])
