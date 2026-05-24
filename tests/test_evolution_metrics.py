"""SE-PR2 tests: feedback CRUD, post-task collector, rolling aggregator, API."""

from __future__ import annotations

import json
import time
import uuid

import pytest

from edagent_vivado.evolution import (
    aggregate_rolling,
    collect_task_metrics,
    feedback_create,
    feedback_list_for_session,
    feedback_list_for_task,
    feedback_thumb_for_task,
    feedback_thumb_rolling,
    latest_snapshot,
    snapshot_series,
)
from edagent_vivado.evolution.collector import VIVADO_EXECUTION_TOOLS
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import (
    project_create,
    run_create,
    run_update,
    session_create,
    task_create,
    task_update,
    toolcall_create,
    toolcall_update,
    usage_create,
)


# ── helpers ----------------------------------------------------------------


def _make_project_session_task():
    pid = project_create(
        {
            "name": f"se-pr2-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )
    s = session_create(name="m-session", project_id=pid["id"])
    db = get_db()
    db.execute("UPDATE sessions SET project_id=? WHERE id=?", (pid["id"], s["id"]))
    db.commit()
    t = task_create(s["id"], user_message_id=None)
    started = int(time.time()) - 30
    task_update(t["id"], state="running", started_at=started, updated_at=started)
    return pid, s, t


def _seed_vivado_toolcall(
    run_id: str,
    session_id: str,
    task_id: str,
    *,
    tool_name: str = "run_vivado_synth_tool",
    state: str = "completed",
    outcome: str = "execution_succeeded",
    extra: dict | None = None,
) -> dict:
    tc = toolcall_create(run_id=run_id, tool_name=tool_name, session_id=session_id, task_id=task_id, input_summary="{}")
    body = {"edagent_outcome": outcome, "summary": "ok", "ran": True, "success": outcome == "execution_succeeded"}
    if extra:
        body.update(extra)
    toolcall_update(
        tc["id"],
        state=state,
        finished_at=int(time.time()),
        elapsed_ms=120,
        output_summary=json.dumps(body),
    )
    return tc


def _seed_timing_toolcall(run_id: str, session_id: str, task_id: str, *, wns_ns: float, tns_ns: float) -> dict:
    tc = toolcall_create(run_id=run_id, tool_name="parse_timing_tool", session_id=session_id, task_id=task_id, input_summary="{}")
    toolcall_update(
        tc["id"],
        state="completed",
        finished_at=int(time.time()),
        elapsed_ms=8,
        output_summary=json.dumps({"wns": wns_ns, "tns": tns_ns, "whs": 0.1, "ths": 0.0}),
    )
    return tc


def _seed_util_toolcall(run_id: str, session_id: str, task_id: str, *, lut: int, ff: int):
    tc = toolcall_create(run_id=run_id, tool_name="parse_utilization_tool", session_id=session_id, task_id=task_id, input_summary="{}")
    toolcall_update(
        tc["id"],
        state="completed",
        finished_at=int(time.time()),
        elapsed_ms=6,
        output_summary=json.dumps({"lut": lut, "ff": ff, "bram": 0, "dsp": 0}),
    )
    return tc


# ── feedback CRUD ----------------------------------------------------------


def test_feedback_thumb_validation():
    init_db()
    _, s, _ = _make_project_session_task()
    with pytest.raises(ValueError):
        feedback_create(session_id=s["id"], user_thumb=42)


def test_feedback_create_and_query():
    _, s, t = _make_project_session_task()
    f = feedback_create(session_id=s["id"], task_id=t["id"], user_thumb=1, comment="nice")
    assert f["user_thumb"] == 1
    assert f["comment"] == "nice"

    listed = feedback_list_for_session(s["id"])
    assert any(row["id"] == f["id"] for row in listed)

    task_listed = feedback_list_for_task(t["id"])
    assert len(task_listed) == 1


def test_feedback_thumb_for_task_returns_latest():
    _, s, t = _make_project_session_task()
    feedback_create(session_id=s["id"], task_id=t["id"], user_thumb=-1)
    time.sleep(1.05)
    feedback_create(session_id=s["id"], task_id=t["id"], user_thumb=1)
    assert feedback_thumb_for_task(t["id"]) == 1


def test_feedback_thumb_rolling_counts():
    _, s, t = _make_project_session_task()
    feedback_create(session_id=s["id"], task_id=t["id"], user_thumb=-1)
    feedback_create(session_id=s["id"], task_id=t["id"], user_thumb=-1)
    feedback_create(session_id=s["id"], task_id=t["id"], user_thumb=1)
    feedback_create(session_id=s["id"], task_id=t["id"], user_thumb=0)
    summary = feedback_thumb_rolling(s["id"], limit=10)
    assert summary["counts"]["-1"] == 2
    assert summary["counts"]["+1"] == 1
    assert summary["total"] == 4
    assert 0.4 < summary["negative_rate"] < 0.6


# ── collector --------------------------------------------------------------


def test_collector_writes_task_snapshot_with_vivado_success():
    pid, s, t = _make_project_session_task()
    run = run_create("task", f"task:{t['id']}", session_id=s["id"], task_id=t["id"])
    _seed_vivado_toolcall(run["id"], s["id"], t["id"])
    _seed_timing_toolcall(run["id"], s["id"], t["id"], wns_ns=0.45, tns_ns=0.0)
    _seed_util_toolcall(run["id"], s["id"], t["id"], lut=1500, ff=900)
    usage_create(
        run_id=run["id"],
        model="glm-test",
        session_id=s["id"],
        task_id=t["id"],
        input_tokens=2000,
        output_tokens=4000,
        total_tokens=6000,
    )
    feedback_create(session_id=s["id"], task_id=t["id"], user_thumb=1)
    task_update(t["id"], state="done", finished_at=int(time.time()))
    run_update(run["id"], state="done", finished_at=int(time.time()))

    snap = collect_task_metrics(session_id=s["id"], task_id=t["id"], run_id=run["id"])
    assert snap is not None
    m = snap["metrics"]
    assert m["first_run_success"] is True
    assert m["wns_ps"] == 450
    assert m["tns_ps"] == 0
    assert m["lut"] == 1500
    assert m["task_tokens_total"] == 6000
    assert m["user_thumb_score"] == 1
    assert m["approval_pass_rate"] == 1.0
    assert snap["composite_score"] > 0.7


def test_collector_marks_user_rejection_as_no_first_run_success():
    pid, s, t = _make_project_session_task()
    run = run_create("task", f"task:{t['id']}", session_id=s["id"], task_id=t["id"])
    _seed_vivado_toolcall(
        run["id"], s["id"], t["id"],
        tool_name="run_vivado_synth_tool",
        state="rejected",
        outcome="user_rejected",
    )
    task_update(t["id"], state="done", finished_at=int(time.time()))
    snap = collect_task_metrics(session_id=s["id"], task_id=t["id"], run_id=run["id"])
    assert snap is not None
    m = snap["metrics"]
    assert m["first_run_success"] is False
    # rejection is excluded from vivado_total denominator
    assert m["vivado_success_rate"] is None
    # approval pass rate counts the rejection
    assert m["approval_pass_rate"] == 0.0
    assert m["approval_rejected"] == 1


def test_collector_emits_event_via_sink():
    pid, s, t = _make_project_session_task()
    run = run_create("task", f"task:{t['id']}", session_id=s["id"], task_id=t["id"])
    _seed_vivado_toolcall(run["id"], s["id"], t["id"])
    task_update(t["id"], state="done", finished_at=int(time.time()))

    events: list[dict] = []
    def sink(session_id, event_type, payload, **kwargs):
        events.append({"type": event_type, "payload": payload, **kwargs})

    snap = collect_task_metrics(
        session_id=s["id"], task_id=t["id"], run_id=run["id"], event_sink=sink
    )
    assert snap is not None
    assert any(e["type"] == "evolution.metric.snapshot" for e in events)


# ── aggregator -------------------------------------------------------------


def test_aggregator_returns_none_when_no_input():
    pid, _, _ = _make_project_session_task()
    snap = aggregate_rolling(pid["id"], "rolling_10")
    assert snap is None


def test_aggregator_means_and_bool_rate():
    pid, s, _ = _make_project_session_task()
    # Synthesize 3 task snapshots: first 2 wins, last 1 fail.
    runs = []
    for i, ok in enumerate([True, True, False]):
        t = task_create(s["id"], user_message_id=None)
        task_update(t["id"], state="done", started_at=int(time.time()) - 10, finished_at=int(time.time()))
        run = run_create("task", f"task:{t['id']}", session_id=s["id"], task_id=t["id"])
        runs.append(run)
        if ok:
            _seed_vivado_toolcall(run["id"], s["id"], t["id"])
            _seed_timing_toolcall(run["id"], s["id"], t["id"], wns_ns=0.2, tns_ns=0.0)
        else:
            _seed_vivado_toolcall(
                run["id"], s["id"], t["id"], state="completed", outcome="execution_failed",
            )
            _seed_timing_toolcall(run["id"], s["id"], t["id"], wns_ns=-0.5, tns_ns=-2.0)
        usage_create(
            run_id=run["id"], model="glm", session_id=s["id"], task_id=t["id"],
            input_tokens=1000, output_tokens=1000, total_tokens=2000,
        )
        collect_task_metrics(session_id=s["id"], task_id=t["id"], run_id=run["id"])

    rolling = aggregate_rolling(pid["id"], "rolling_10")
    assert rolling is not None
    m = rolling["metrics"]
    assert m["sample_size"] == 3
    assert pytest.approx(m["first_run_success"], abs=1e-6) == 2 / 3
    assert m["wns_ps"] is not None
    # mean of 200, 200, -500 ps = -33.33
    assert -60 < m["wns_ps"] < 0
    assert rolling["scope"] == "project"
    assert rolling["composite_score"] is not None


def test_latest_snapshot_returns_most_recent():
    pid, s, _ = _make_project_session_task()
    for i in range(2):
        t = task_create(s["id"], user_message_id=None)
        task_update(t["id"], state="done", finished_at=int(time.time()))
        run = run_create("task", f"task:{t['id']}", session_id=s["id"], task_id=t["id"])
        _seed_vivado_toolcall(run["id"], s["id"], t["id"])
        collect_task_metrics(session_id=s["id"], task_id=t["id"], run_id=run["id"])

    snap = latest_snapshot(project_id=pid["id"], scope="task", window="single")
    assert snap is not None
    assert snap["project_id"] == pid["id"]
    assert "metrics" in snap


def test_snapshot_series_returns_oldest_first():
    pid, s, _ = _make_project_session_task()
    created_ids = []
    for _ in range(3):
        t = task_create(s["id"], user_message_id=None)
        task_update(t["id"], state="done", finished_at=int(time.time()))
        run = run_create("task", f"task:{t['id']}", session_id=s["id"], task_id=t["id"])
        _seed_vivado_toolcall(run["id"], s["id"], t["id"])
        snap = collect_task_metrics(session_id=s["id"], task_id=t["id"], run_id=run["id"])
        created_ids.append(snap["id"])
        time.sleep(0.01)

    series = snapshot_series(project_id=pid["id"], limit=10)
    assert [row["id"] for row in series] == created_ids


# ── constants sanity ------------------------------------------------------


def test_vivado_execution_tools_constant_complete():
    assert "run_vivado_synth_tool" in VIVADO_EXECUTION_TOOLS
    assert "run_vivado_flow_tool" in VIVADO_EXECUTION_TOOLS
