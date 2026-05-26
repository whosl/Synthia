"""Persist ParsedReportBundle to DB and emit report.parsed.created events."""

from __future__ import annotations

from typing import Any, Callable

from edagent_vivado.connectors import ensure_connectors
from edagent_vivado.connectors.base.registry import get_connector
from edagent_vivado.connectors.base.types import Artifact, ToolRunResult
from edagent_vivado.connectors.vivado.artifacts import artifacts_from_workspace
from edagent_vivado.harness.approval_outcomes import OUTCOME_EXECUTION_SUCCEEDED, parse_tool_outcome
from edagent_vivado.repository.store import parsed_report_create

EventSink = Callable[..., Any] | None


def _metrics_for_report(report_type: str, data: dict | None) -> dict[str, Any]:
    """Compute a slim metrics dict for a parsed report (consumed by trend)."""
    if not isinstance(data, dict):
        return {}
    if report_type == "timing_summary":
        return {
            "wns_ns": data.get("wns"),
            "tns_ns": data.get("tns"),
            "whs_ns": data.get("whs"),
            "ths_ns": data.get("ths"),
            "violated_path_count": int(data.get("violated_path_count") or 0),
            "met_setup": bool(data.get("met_setup", True)),
            "met_hold": bool(data.get("met_hold", True)),
        }
    if report_type == "utilization":
        return {
            "lut_pct": data.get("lut_pct"),
            "ff_pct": data.get("ff_pct"),
            "bram_pct": data.get("bram_pct"),
            "dsp_pct": data.get("dsp_pct"),
            "uram_pct": data.get("uram_pct"),
            "lut_used": data.get("lut"),
            "ff_used": data.get("ff"),
        }
    if report_type == "drc":
        errors = data.get("errors") or []
        warnings = data.get("warnings") or []
        return {
            "error_count": len(errors),
            "warning_count": len(warnings),
            "clean": bool(data.get("clean")),
            "by_category": dict(data.get("by_category") or {}),
        }
    if report_type == "methodology":
        return {
            "count": int(data.get("count") or 0),
            "by_severity": dict(data.get("by_severity") or {}),
        }
    if report_type == "log_summary":
        return {
            "error_count": int(data.get("error_count") or 0),
            "critical_warning_count": int(data.get("critical_warning_count") or 0),
            "warning_count": int(data.get("warning_count") or 0),
        }
    if report_type == "impl_summary":
        issues = data.get("issues") or []
        return {
            "ok": bool(data.get("ok")),
            "issue_count": len(issues),
        }
    if report_type == "bitstream":
        return {
            "bit_found": bool(data.get("found")),
            "bit_count": int(data.get("count") or 0),
        }
    return {}

_MANIFEST_TOOLS = frozenset({
    "run_vivado_synth_tool",
    "run_vivado_impl_tool",
    "run_vivado_flow_tool",
})


def persist_from_tool_output(
    session_id: str,
    task_id: str,
    run_id: str,
    tool_name: str,
    output: str,
    event_sink: EventSink = None,
) -> list[dict]:
    """Parse tool JSON output, extract workspace reports, store parsed_reports."""
    if tool_name not in _MANIFEST_TOOLS or not run_id:
        return []
    parsed = parse_tool_outcome(output)
    if parsed.get("edagent_outcome") != OUTCOME_EXECUTION_SUCCEEDED:
        return []
    workspace = str(parsed.get("workspace") or "")
    if not workspace:
        return []
    stage = "synth" if tool_name == "run_vivado_synth_tool" else "impl"
    artifacts = artifacts_from_workspace(workspace, stage=stage)
    if not artifacts:
        return []
    tool_result = ToolRunResult(
        request_id="",
        success=True,
        exit_code=0,
        artifacts=artifacts,
    )
    return persist_tool_run_result(
        run_id,
        tool_result,
        session_id=session_id,
        task_id=task_id,
        event_sink=event_sink,
        step_id="",
    )


def persist_tool_run_result(
    run_id: str,
    tool_result: ToolRunResult,
    *,
    session_id: str = "",
    task_id: str = "",
    step_id: str = "",
    event_sink: EventSink = None,
    connector_id: str = "vivado",
) -> list[dict]:
    ensure_connectors()
    conn = get_connector(connector_id)
    if not conn:
        return []
    bundle = conn.parse_artifacts(tool_result)
    saved: list[dict] = []
    for report in bundle.reports:
        metrics = _metrics_for_report(report.type, report.data)
        row = parsed_report_create(
            run_id,
            connector_id,
            report.type,
            report.stage,
            report.data,
            step_id=step_id,
            source_artifact_id=report.source_artifact_id,
            metrics=metrics,
        )
        saved.append(row)
        if event_sink and session_id:
            event_sink(
                session_id,
                "report.parsed.created",
                {
                    "parsed_report_id": row.get("id"),
                    "type": report.type,
                    "stage": report.stage,
                    "run_id": run_id,
                    "step_id": step_id or None,
                },
                task_id=task_id or None,
                run_id=run_id,
            )
    if tool_result.log_paths or tool_result.artifacts:
        try:
            from edagent_vivado.harness.run_workspace import mirror_artifacts_from_paths

            paths = list(tool_result.log_paths)
            for art in tool_result.artifacts:
                paths.append(art.path)
            mirror_artifacts_from_paths(run_id, paths)
        except Exception:
            pass
    return saved


def tool_result_from_adapter_dict(raw: dict[str, Any], *, request_id: str = "") -> ToolRunResult:
    workspace = str(raw.get("workspace") or "")
    ok = bool(raw.get("success"))
    artifacts = artifacts_from_workspace(workspace) if workspace else []
    log_paths: list[str] = []
    if workspace:
        vlog = workspace + "/vivado.log" if "/" in workspace else f"{workspace}\\vivado.log"
        from pathlib import Path
        if Path(vlog).is_file():
            log_paths.append(str(Path(vlog)))
    return ToolRunResult(
        request_id=request_id,
        success=ok,
        exit_code=int(raw.get("return_code") or (0 if ok else 1)),
        error=str(raw.get("error") or ""),
        edagent_outcome="execution_succeeded" if ok else "execution_failed",
        artifacts=artifacts,
        log_paths=log_paths,
        target_id=str(raw.get("target_id") or ""),
    )
