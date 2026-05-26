"""Phase 5 trend + summary integration tests."""

from __future__ import annotations

import importlib

import pytest

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod
from edagent_vivado.runs.summary import render_run_summary
from edagent_vivado.runs.trend import project_trend


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "p5.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "rt"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def _make_project_with_run(store, *, project_id: str, run_state: str, started_at: int,
                            timing_metrics: dict, util_metrics: dict, drc_metrics: dict,
                            impl_metrics: dict | None = None) -> str:
    db = db_mod.get_db()
    db.execute(
        "INSERT OR IGNORE INTO projects(id,name,status,root_path,manifest_path,xpr_path,part,created_at,updated_at,metadata_json) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (project_id, f"proj-{project_id}", "active", ".", "eda.yaml", "", "x", started_at, started_at, "{}"),
    )
    db.commit()
    run = store.run_create("vivado_synth_only", name=f"run-{started_at}", session_id="s1")
    store.run_update(run["id"], state=run_state, started_at=started_at, finished_at=started_at + 1000)
    db.execute("UPDATE runs SET project_id=? WHERE id=?", (project_id, run["id"]))
    db.commit()

    store.parsed_report_create(
        run["id"], "vivado", "timing_summary", "impl",
        {"wns": timing_metrics.get("wns_ns"), "tns": -0.5, "whs": 0.1, "ths": 0.0},
        metrics=timing_metrics,
    )
    store.parsed_report_create(
        run["id"], "vivado", "utilization", "impl",
        {"lut_pct": util_metrics.get("lut_pct"), "ff_pct": util_metrics.get("ff_pct")},
        metrics=util_metrics,
    )
    store.parsed_report_create(
        run["id"], "vivado", "drc", "impl",
        {"errors": [{"rule": "DRC-1"}] * drc_metrics.get("error_count", 0),
         "warnings": [{"rule": "DRC-2"}] * drc_metrics.get("warning_count", 0),
         "clean": drc_metrics.get("error_count", 0) == 0,
         "by_category": {"timing": 1}},
        metrics=drc_metrics,
    )
    if impl_metrics:
        store.parsed_report_create(
            run["id"], "vivado", "impl_summary", "impl",
            {"ok": impl_metrics.get("ok"), "issues": [{"severity": "high", "category": "timing", "message": "violation"}]},
            metrics=impl_metrics,
        )
    return run["id"]


def test_project_trend_aggregates_recent_runs(store):
    project_id = "projA"
    run_old = _make_project_with_run(
        store,
        project_id=project_id,
        run_state="succeeded",
        started_at=1_700_000_000,
        timing_metrics={"wns_ns": -0.5},
        util_metrics={"lut_pct": 40.0, "ff_pct": 30.0},
        drc_metrics={"error_count": 2, "warning_count": 5, "clean": False},
        impl_metrics={"ok": False, "issue_count": 1},
    )
    run_new = _make_project_with_run(
        store,
        project_id=project_id,
        run_state="succeeded",
        started_at=1_700_000_500,
        timing_metrics={"wns_ns": 0.2},
        util_metrics={"lut_pct": 42.0, "ff_pct": 32.0},
        drc_metrics={"error_count": 0, "warning_count": 1, "clean": True},
        impl_metrics={"ok": True, "issue_count": 0},
    )

    trend = project_trend(project_id, limit=5)
    assert trend["project_id"] == project_id
    series = trend["series"]
    assert len(series) == 2
    # chronological order (oldest first)
    assert series[0]["run_id"] == run_old
    assert series[1]["run_id"] == run_new
    new_metrics = series[1]["metrics"]
    assert new_metrics["wns_ns"] == 0.2
    assert new_metrics["lut_pct"] == 42.0
    assert new_metrics["drc_error_count"] == 0
    assert new_metrics["impl_ok"] is True


def test_render_run_summary_includes_all_sections(store):
    run_id = _make_project_with_run(
        store,
        project_id="projB",
        run_state="succeeded",
        started_at=1_700_000_000,
        timing_metrics={"wns_ns": -0.1},
        util_metrics={"lut_pct": 70.0, "ff_pct": 40.0},
        drc_metrics={"error_count": 1, "warning_count": 0, "clean": False},
        impl_metrics={"ok": False, "issue_count": 1},
    )
    md = render_run_summary(run_id)
    assert "# Run Summary" in md
    assert "timing_summary" in md
    assert "utilization" in md
    assert "drc" in md
    assert "impl_summary" in md
    assert "Errors: 1" in md
    assert "LUT" in md
