"""SE-PR1 foundation tests: schema + no-op resolvers + composite_score sanity."""

from __future__ import annotations

import json
import time
import uuid

import pytest

from edagent_vivado.evolution import (
    SURFACES,
    active_overlay,
    resolve_flow_template,
    resolve_prompt,
    resolve_routing,
    resolve_tools,
)
from edagent_vivado.evolution.candidates import (
    candidate_create,
    candidate_get,
    candidate_list,
    candidate_update_status,
)
from edagent_vivado.evolution.metrics import composite_score, metric_snapshot_create
from edagent_vivado.repository.db import get_db, init_db


# ── schema -----------------------------------------------------------------


def test_evolution_schema_tables_exist():
    init_db()
    db = get_db()
    tables = {
        row[0]
        for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    expected = {
        "evolution_candidates",
        "overlays",
        "evolution_trials",
        "feedback",
        "metric_snapshots",
        "eval_runs",
    }
    assert expected.issubset(tables), f"missing: {expected - tables}"


def test_surfaces_constant_complete():
    assert set(SURFACES) == {"kb", "prompt", "tool", "flow_template", "routing"}


# ── candidates -------------------------------------------------------------


def test_candidate_crud_roundtrip():
    pid = f"prj-{uuid.uuid4().hex[:6]}"
    cand = candidate_create(
        surface="prompt",
        title="Add timing-debug hint",
        rationale="3 negative thumbs in last 10 turns",
        project_id=pid,
        signal_source={"signal": "user_feedback", "thumbs_negative": 3},
        confidence=0.62,
        metadata={"weights": {"timing": 0.5}},
    )
    assert cand["status"] == "pending"
    assert cand["surface"] == "prompt"
    assert cand["project_id"] == pid

    listed = candidate_list(status="pending", surface="prompt", project_id=pid)
    assert any(c["id"] == cand["id"] for c in listed)

    updated = candidate_update_status(cand["id"], "rejected", reviewed_by="tester")
    assert updated and updated["status"] == "rejected"
    assert updated["reviewed_by"] == "tester"


# ── resolvers (no-op baseline) ---------------------------------------------


def test_resolve_prompt_baseline_when_no_overlay():
    assert resolve_prompt("BASE", project_id="nonexistent-project") == "BASE"


def test_resolve_tools_baseline_when_no_overlay():
    class _Tool:
        def __init__(self, name):
            self.name = name

    tools = [_Tool("a"), _Tool("b")]
    assert resolve_tools(tools, project_id="nonexistent-project") == tools


def test_resolve_flow_template_returns_none_for_baseline():
    assert resolve_flow_template("synth", project_id="nonexistent-project") is None


def test_resolve_routing_returns_none_for_baseline():
    assert resolve_routing(project_id="nonexistent-project") is None


def test_active_overlay_rejects_unknown_surface():
    with pytest.raises(ValueError):
        active_overlay("definitely-not-a-surface", None)


# ── resolver picks up overlays ---------------------------------------------


def _insert_overlay(*, surface: str, scope: str, project_id, payload: dict) -> str:
    db = get_db()
    oid = uuid.uuid4().hex[:12]
    db.execute(
        """INSERT INTO overlays(id, scope, project_id, surface, name, state, payload_json, created_at)
            VALUES(?,?,?,?,?,?,?,?)""",
        (oid, scope, project_id, surface, f"test-{surface}", "active", json.dumps(payload), int(time.time())),
    )
    db.commit()
    return oid


def test_resolve_prompt_picks_up_project_overlay():
    pid = f"prj-{uuid.uuid4().hex[:6]}"
    _insert_overlay(
        surface="prompt",
        scope="project",
        project_id=pid,
        payload={"mode": "append", "text": "Pay extra attention to UART framing errors."},
    )
    out = resolve_prompt("BASE", project_id=pid)
    assert out.startswith("BASE")
    assert "UART framing" in out


def test_resolve_tools_disables_named_tool():
    class _Tool:
        def __init__(self, name):
            self.name = name

    pid = f"prj-{uuid.uuid4().hex[:6]}"
    _insert_overlay(
        surface="tool",
        scope="project",
        project_id=pid,
        payload={"disabled": ["b"]},
    )
    filtered = resolve_tools([_Tool("a"), _Tool("b"), _Tool("c")], project_id=pid)
    names = [t.name for t in filtered]
    assert "b" not in names
    assert names == ["a", "c"]


def test_resolve_flow_template_returns_overlay_body():
    pid = f"prj-{uuid.uuid4().hex[:6]}"
    _insert_overlay(
        surface="flow_template",
        scope="project",
        project_id=pid,
        payload={"templates": {"synth": "# evolved synth\nsynth_design -top ${top} -part ${part}\n"}},
    )
    body = resolve_flow_template("synth", project_id=pid)
    assert body is not None
    assert "evolved synth" in body


def test_resolve_routing_returns_overlay_payload():
    pid = f"prj-{uuid.uuid4().hex[:6]}"
    _insert_overlay(
        surface="routing",
        scope="project",
        project_id=pid,
        payload={"weights": {"timing": 1.5}, "rules": [{"if_contains_any": ["wns"], "route_to": "timing"}]},
    )
    out = resolve_routing(project_id=pid)
    assert out is not None
    assert out["weights"]["timing"] == 1.5
    assert out["rules"][0]["route_to"] == "timing"


# ── composite score --------------------------------------------------------


def test_composite_score_with_full_metrics_is_high():
    s = composite_score(
        {
            "wns_ps": 250,
            "first_run_success": True,
            "approval_pass_rate": 0.95,
            "task_tokens_total": 5000,
            "user_thumb_score": 1,
        }
    )
    assert 0.8 < s <= 1.0


def test_composite_score_with_failure_is_low():
    s = composite_score(
        {
            "wns_ps": -800,
            "first_run_success": False,
            "approval_pass_rate": 0.20,
            "task_tokens_total": 80000,
            "user_thumb_score": -1,
        }
    )
    assert 0.0 <= s < 0.25


def test_composite_score_missing_fields_is_neutral():
    s = composite_score({})
    assert 0.45 <= s <= 0.55


def test_metric_snapshot_create_persists_with_composite():
    pid = f"prj-{uuid.uuid4().hex[:6]}"
    snap = metric_snapshot_create(
        project_id=pid,
        task_id="t-1",
        metrics={"wns_ps": 100, "first_run_success": True, "task_tokens_total": 6000},
    )
    assert snap["composite_score"] > 0.5
    row = get_db().execute("SELECT * FROM metric_snapshots WHERE id=?", (snap["id"],)).fetchone()
    assert row is not None
    assert row["scope"] == "task"
    assert json.loads(row["metrics_json"])["composite_score"] == snap["composite_score"]
