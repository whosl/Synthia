"""Phase 6A — connector DB tables and store CRUD."""

from __future__ import annotations

import importlib

import pytest

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "connectors.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(runtime))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    return store_mod


def test_connector_upsert_and_list(store):
    row = store.connector_upsert("vivado", "Vivado", version="2022.1", status="ready")
    assert row["connector_id"] == "vivado"
    assert store.connector_get("vivado")["tool_name"] == "Vivado"
    assert len(store.connector_list()) >= 1


def test_capability_upsert(store):
    store.connector_upsert("vivado", "Vivado")
    cap = store.capability_upsert(
        "vivado",
        "run_synthesis",
        display_name="Synthesis",
        stage="synth",
        risk_level="medium",
        requires_approval=True,
        outputs=["vivado_log"],
    )
    assert cap["capability_id"] == "run_synthesis"
    caps = store.capability_list("vivado")
    assert len(caps) == 1
    assert caps[0]["requires_approval"] == 1


def test_run_steps_and_parsed_reports(store):
    run = store.run_create("task", "test-run")
    step = store.run_step_create(
        run["id"],
        stage="synth",
        name="run_synthesis",
        connector_id="vivado",
        capability_id="run_synthesis",
    )
    assert step["state"] == "pending"
    store.run_step_update(step["id"], state="completed", elapsed_ms=1000)
    steps = store.run_step_list(run["id"])
    assert len(steps) == 1
    assert steps[0]["state"] == "completed"

    report = store.parsed_report_create(
        run["id"],
        "vivado",
        "timing_summary",
        "synth",
        {"wns": -0.12, "tns": -1.0},
        step_id=step["id"],
    )
    assert report["report_type"] == "timing_summary"
    listed = store.parsed_report_list(run_id=run["id"])
    assert len(listed) == 1
    assert listed[0]["data"]["wns"] == pytest.approx(-0.12)
