"""Vivado Connector — wraps VivadoRuntimeAdapter (Phase 6B)."""

from __future__ import annotations

from pathlib import Path

from edagent_vivado.connectors.base.connector import BaseConnector
from edagent_vivado.connectors.base.manifest import manifest_from_eda_yaml, validate_manifest_file
from edagent_vivado.connectors.base.policy import policy_from_tcl
from edagent_vivado.connectors.base.registry import register_connector
from edagent_vivado.connectors.base.types import (
    Artifact,
    ParsedReport,
    ParsedReportBundle,
    PreparedRun,
    ToolCapability,
    ToolEnvironment,
    ToolErrorSummary,
    ToolManifest,
    ToolRunRequest,
    ToolRunResult,
    ValidationResult,
)
from edagent_vivado.connectors.vivado.artifacts import artifacts_from_workspace, stage_from_path
from edagent_vivado.connectors.vivado.capabilities import VIVADO_CAPABILITIES
from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter


class VivadoConnector(BaseConnector):
    connector_id = "vivado"
    tool_name = "vivado"
    supported_versions = ["2020.2", "2022.1", "2023.2", "2024.1"]

    def __init__(self) -> None:
        self._adapter = VivadoRuntimeAdapter()

    def detect_environment(self) -> ToolEnvironment:
        h = self._adapter.health_check()
        t = self._adapter.target
        target_type = "mock"
        if t:
            target_type = "remote_ssh" if t.target_type == "remote_ssh" else "local"
            if not t.host and not h.get("reachable"):
                target_type = "mock"
        return ToolEnvironment(
            connector_id=self.connector_id,
            tool_name=self.tool_name,
            version=str(h.get("version") or (t.vivado_version if t else "")),
            executable_path=t.vivado_path if t else "",
            target_id=t.id if t else "",
            target_type=target_type,  # type: ignore[arg-type]
            reachable=bool(h.get("reachable")),
            remote_workdir=t.remote_work_root if t else "",
            extra={"raw_health": h},
        )

    def list_capabilities(self) -> list[ToolCapability]:
        return list(VIVADO_CAPABILITIES)

    def validate_manifest(self, manifest: ToolManifest) -> ValidationResult:
        path = manifest.raw.get("_manifest_path") or manifest.project.get("manifest_path")
        if path:
            return validate_manifest_file(path)
        return super().validate_manifest(manifest)

    def prepare_run(self, request: ToolRunRequest) -> PreparedRun:
        manifest_path = request.manifest_path or str(request.inputs.get("manifest_path") or "")
        workspace = str(request.inputs.get("workspace_root") or "")
        if not workspace:
            workspace = str(Path(manifest_path).parent) if manifest_path else "."
        cap = request.capability_id
        command: list[str] = ["vivado", "-mode", "batch"]
        if cap in ("run_synthesis", "run_implementation", "run_simulation"):
            script = f"generated_{cap}.tcl"
            command.extend(["-source", script])
        elif cap == "run_tcl":
            command.extend(["-source", "inline.tcl"])
        policy = None
        tcl = str(request.inputs.get("tcl_command") or request.inputs.get("command") or "")
        if tcl:
            from edagent_vivado.harness.tcl_policy import check_tcl_policy

            policy = policy_from_tcl(check_tcl_policy(tcl, auto_approved=request.auto_approved))
        return PreparedRun(
            request=request,
            workspace_root=workspace,
            generated_scripts=[],
            command=command,
            allowed_paths=[workspace] if workspace else [],
            policy=policy,
        )

    def execute(self, prepared: PreparedRun) -> ToolRunResult:
        req = prepared.request
        cap = req.capability_id
        manifest_path = req.manifest_path or str(req.inputs.get("manifest_path") or "")
        if prepared.policy and prepared.policy.verdict == "denied":
            return ToolRunResult(
                request_id=req.request_id,
                success=False,
                exit_code=1,
                edagent_outcome="policy_denied",
                error="; ".join(prepared.policy.reasons),
            )
        if prepared.policy and prepared.policy.verdict == "needs_approval":
            return ToolRunResult(
                request_id=req.request_id,
                success=False,
                exit_code=0,
                edagent_outcome="needs_approval",
                error="approval required",
            )

        try:
            if cap == "validate_project":
                vr = self.validate_manifest(
                    manifest_from_eda_yaml(manifest_path) if manifest_path else ToolManifest({}, {}, {}, {}, {})
                )
                return ToolRunResult(
                    request_id=req.request_id,
                    success=vr.ok,
                    exit_code=0 if vr.ok else 1,
                    error="; ".join(vr.errors),
                    edagent_outcome="execution_succeeded" if vr.ok else "execution_failed",
                )
            session_id = str(req.inputs.get("session_id") or "")
            task_id = str(req.inputs.get("task_id") or "")
            run_id = str(req.inputs.get("run_id") or "")
            if cap == "run_synthesis" and manifest_path:
                raw = self._adapter.run_synthesis(
                    manifest_path,
                    session_id=session_id,
                    task_id=task_id,
                    run_id=run_id,
                )
                return self._result_from_raw(req.request_id, raw, stage="synth")
            if cap == "run_implementation" and manifest_path:
                run_synth_first = bool(req.inputs.get("run_synth_first", True))
                raw = self._adapter.run_implementation(
                    manifest_path,
                    session_id=session_id,
                    task_id=task_id,
                    run_id=run_id,
                    run_synth_first=run_synth_first,
                )
                return self._result_from_raw(req.request_id, raw, stage="impl")
            if cap == "run_simulation":
                return ToolRunResult(
                    request_id=req.request_id,
                    success=False,
                    exit_code=2,
                    edagent_outcome="execution_failed",
                    error="run_simulation capability not implemented yet (planned v1.0)",
                )
            if cap in (
                "report_timing_summary",
                "report_utilization",
                "report_drc",
                "report_methodology",
                "parse_vivado_log",
            ):
                return self._execute_report_capability(req, cap)
            if cap == "classify_vivado_error":
                log_path = str(req.inputs.get("log_path") or "")
                if log_path:
                    from pathlib import Path
                    from edagent_vivado.connectors.vivado.parsers.log_summary import parse_log_summary

                    text = Path(log_path).read_text(encoding="utf-8", errors="replace")
                    summary = parse_log_summary(text)
                    err_n = summary.data.get("error_count", 0)
                    return ToolRunResult(
                        request_id=req.request_id,
                        success=True,
                        exit_code=0,
                        edagent_outcome="execution_succeeded",
                        error=f"errors={err_n}",
                    )
            return ToolRunResult(
                request_id=req.request_id,
                success=False,
                exit_code=1,
                error=f"capability not implemented in connector yet: {cap}",
                edagent_outcome="execution_failed",
            )
        except Exception as exc:
            return ToolRunResult(
                request_id=req.request_id,
                success=False,
                exit_code=1,
                error=str(exc),
                edagent_outcome="execution_failed",
            )

    def _execute_report_capability(self, req: ToolRunRequest, cap: str) -> ToolRunResult:
        from pathlib import Path

        report_path = str(req.inputs.get("report_path") or req.inputs.get("path") or "")
        workspace = str(req.inputs.get("workspace") or "")
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
        tr = ToolRunResult(
            request_id=req.request_id,
            success=True,
            exit_code=0,
            edagent_outcome="execution_succeeded",
            artifacts=[art],
        )
        return tr

    def _result_from_raw(self, request_id: str, raw: dict, *, stage: str) -> ToolRunResult:
        ok = bool(raw.get("success"))
        workspace = str(raw.get("workspace") or "")
        artifacts = artifacts_from_workspace(workspace, stage=stage) if workspace else []
        return ToolRunResult(
            request_id=request_id,
            success=ok,
            exit_code=int(raw.get("return_code") or (0 if ok else 1)),
            error=str(raw.get("error") or ""),
            edagent_outcome="execution_succeeded" if ok else "execution_failed",
            target_id=str(raw.get("target_id") or ""),
            artifacts=artifacts,
        )

    def parse_artifacts(self, result: ToolRunResult) -> ParsedReportBundle:
        from edagent_vivado.connectors.vivado.parsers.drc import parse_drc_report
        from edagent_vivado.connectors.vivado.parsers.log_summary import parse_log_summary
        from edagent_vivado.connectors.vivado.parsers.methodology import parse_methodology_report
        from edagent_vivado.parsers.timing_parser import parse_timing_summary
        from edagent_vivado.parsers.utilization_parser import parse_utilization

        reports: list = []
        for art in result.artifacts:
            path = art.path
            if not path:
                continue
            try:
                text = Path(path).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            stage = stage_from_path(path)
            aid = art.artifact_id
            if path.endswith("_timing_summary.rpt"):
                t = parse_timing_summary(text)
                if t:
                    reports.append(
                        ParsedReport(
                            type="timing_summary",
                            tool="vivado",
                            stage=stage,
                            data={
                                "wns": t.wns,
                                "tns": t.tns,
                                "whs": t.whs,
                                "ths": t.ths,
                            },
                            source_artifact_id=aid,
                        )
                    )
            elif path.endswith("_utilization.rpt"):
                u = parse_utilization(text)
                if u:
                    reports.append(
                        ParsedReport(
                            type="utilization",
                            tool="vivado",
                            stage=stage,
                            data={"lut": u.lut, "ff": u.ff, "bram": u.bram, "dsp": u.dsp},
                            source_artifact_id=aid,
                        )
                    )
            elif path.endswith("_drc.rpt"):
                r = parse_drc_report(text, stage=stage)
                r.source_artifact_id = aid
                reports.append(r)
            elif path.endswith("_methodology.rpt"):
                r = parse_methodology_report(text, stage=stage)
                r.source_artifact_id = aid
                reports.append(r)
            elif path.endswith(".log") or art.artifact_type == "vivado_log":
                r = parse_log_summary(text, stage=stage)
                r.source_artifact_id = aid
                reports.append(r)
        return ParsedReportBundle(reports=reports)

    def classify_error(self, result: ToolRunResult) -> ToolErrorSummary | None:
        base = super().classify_error(result)
        if base and result.error:
            if "[Synth" in result.error or "ERROR" in result.error:
                base.signature = result.error.split("\n", 1)[0][:120]
        return base


def register() -> None:
    register_connector(VivadoConnector())
    _sync_capabilities_to_db()


def _sync_capabilities_to_db() -> None:
    """Persist capability declarations for API/UI without requiring in-memory registry."""
    try:
        from edagent_vivado.repository.store import capability_upsert, connector_upsert

        connector_upsert("vivado", "Vivado", version="2022.1", status="ready")
        for cap in VIVADO_CAPABILITIES:
            capability_upsert(
                cap.connector_id,
                cap.capability_id,
                display_name=cap.display_name,
                stage=cap.stage,
                risk_level=cap.risk_level,
                requires_approval=cap.requires_approval,
                input_schema=cap.input_schema,
                outputs=cap.outputs,
                supports_stop=cap.supports_stop,
                supports_mock=cap.supports_mock,
            )
    except Exception:
        pass
