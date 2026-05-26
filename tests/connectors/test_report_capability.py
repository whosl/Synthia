"""Vivado report capability execution."""

from pathlib import Path

from edagent_vivado.connectors.base.registry import clear_registry
from edagent_vivado.connectors.base.types import ToolRunRequest
from edagent_vivado.connectors.vivado.connector import VivadoConnector, register


def test_report_timing_from_workspace(tmp_path):
    clear_registry()
    register()
    ws = tmp_path / "ws"
    reports = ws / "reports"
    reports.mkdir(parents=True)
    (reports / "post_synth_timing_summary.rpt").write_text(
        "WNS=0.050\nTNS=0.000\n", encoding="utf-8"
    )
    conn = VivadoConnector()
    req = ToolRunRequest(
        request_id="r1",
        run_id="run1",
        step_id="",
        connector_id="vivado",
        capability_id="report_timing_summary",
        inputs={"workspace": str(ws)},
    )
    prepared = conn.prepare_run(req)
    result = conn.execute(prepared)
    assert result.success
    assert len(result.artifacts) == 1
    bundle = conn.parse_artifacts(result)
    assert any(r.type == "timing_summary" for r in bundle.reports)
