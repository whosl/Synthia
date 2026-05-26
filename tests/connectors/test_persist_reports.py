"""Phase 6C — persist parsed reports from workspace."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from edagent_vivado.connectors.base.registry import clear_registry
from edagent_vivado.connectors.vivado.connector import register
from edagent_vivado.connectors.vivado.persist import persist_from_tool_output
from edagent_vivado.harness.approval_outcomes import tag_execution_result, SCOPE_VIVADO_SYNTH
from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


@pytest.fixture()
def store(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "reports.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(runtime))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    db_mod.init_db()
    clear_registry()
    register()
    return store_mod


def test_persist_from_synth_output(store, tmp_path):
    ws = tmp_path / "ws"
    reports = ws / "reports"
    reports.mkdir(parents=True)
    (reports / "post_synth_timing_summary.rpt").write_text(
        "WNS=0.100\nTNS=0.000\nWHS=0.040\nTHS=0.000\n", encoding="utf-8"
    )
    (reports / "post_synth_utilization.rpt").write_text(
        "Slice LUTs: 1200\nSlice Registers: 600\nBRAM: 2\nDSP: 0\n", encoding="utf-8"
    )
    (reports / "post_synth_drc.rpt").write_text("No violations.\n", encoding="utf-8")

    run = store.run_create(session_id="s1", name="test", run_type="task")
    payload = {"success": True, "workspace": str(ws), "return_code": 0}
    output = tag_execution_result(payload, SCOPE_VIVADO_SYNTH)
    events: list[tuple] = []

    def sink(sid, et, pl, **kw):
        events.append((et, pl))

    saved = persist_from_tool_output("s1", "", run["id"], "run_vivado_synth_tool", output, sink)
    assert len(saved) >= 2
    types = {r["report_type"] for r in store.parsed_report_list(run_id=run["id"])}
    assert "timing_summary" in types
    assert "utilization" in types
    assert any(e[0] == "report.parsed.created" for e in events)
