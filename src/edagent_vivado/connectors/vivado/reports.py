"""Vivado report parsing capabilities — extracted from connector.py (Phase 2)."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from edagent_vivado.connectors.base.types import Artifact, ToolRunRequest, ToolRunResult
from edagent_vivado.connectors.vivado.artifacts import stage_from_path

if TYPE_CHECKING:
    from edagent_vivado.connectors.vivado.connector import VivadoConnector

REPORT_CAPS = frozenset(
    {
        "report_timing_summary",
        "report_utilization",
        "report_drc",
        "report_methodology",
        "parse_vivado_log",
    }
)


def execute_report_capability(
    connector: VivadoConnector,
    req: ToolRunRequest,
    cap: str,
) -> ToolRunResult:
    del connector
    report_path = str(req.inputs.get("report_path") or req.inputs.get("path") or "")
    workspace = str(req.inputs.get("workspace") or req.inputs.get("workspace_root") or "")
    if not report_path and workspace:
        suffix = {
            "report_timing_summary": "_timing_summary.rpt",
            "report_utilization": "_utilization.rpt",
            "report_drc": "_drc.rpt",
            "report_methodology": "_methodology.rpt",
            "parse_vivado_log": "vivado.log",
        }.get(cap, "")
        if suffix:
            reports = Path(workspace) / "reports"
            if reports.is_dir():
                for p in reports.iterdir():
                    if p.name.endswith(suffix) or (cap == "parse_vivado_log" and p.suffix == ".log"):
                        report_path = str(p)
                        break
            if not report_path and cap == "parse_vivado_log":
                vlog = Path(workspace) / "vivado.log"
                if vlog.is_file():
                    report_path = str(vlog)
    if not report_path or not Path(report_path).is_file():
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error=f"report file not found for {cap}",
            edagent_outcome="execution_failed",
        )
    stage = stage_from_path(report_path)
    art = Artifact(
        artifact_id=f"{stage}:{Path(report_path).name}",
        artifact_type=cap.replace("report_", "").replace("parse_", ""),
        path=report_path,
    )
    return ToolRunResult(
        request_id=req.request_id,
        success=True,
        exit_code=0,
        edagent_outcome="execution_succeeded",
        artifacts=[art],
    )
