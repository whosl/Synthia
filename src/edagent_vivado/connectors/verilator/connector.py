"""Verilator connector — mock-friendly second tool (Phase 6F)."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from edagent_vivado.connectors.base.connector import BaseConnector
from edagent_vivado.connectors.base.registry import register_connector
from edagent_vivado.connectors.base.types import (
    ParsedReport,
    ParsedReportBundle,
    PreparedRun,
    ToolCapability,
    ToolEnvironment,
    ToolManifest,
    ToolRunRequest,
    ToolRunResult,
    ValidationResult,
)
from edagent_vivado.connectors.verilator.capabilities import VERILATOR_CAPABILITIES
from edagent_vivado.connectors.verilator.parsers.verilator_log import parse_verilator_log


class VerilatorConnector(BaseConnector):
    connector_id = "verilator"
    tool_name = "verilator"
    supported_versions = ["5.0", "5.2"]

    def detect_environment(self) -> ToolEnvironment:
        exe = shutil.which("verilator") or ""
        return ToolEnvironment(
            connector_id=self.connector_id,
            tool_name=self.tool_name,
            version="5.0",
            executable_path=exe,
            target_type="mock" if not exe else "local",
            reachable=bool(exe),
        )

    def list_capabilities(self) -> list[ToolCapability]:
        return list(VERILATOR_CAPABILITIES)

    def prepare_run(self, request: ToolRunRequest) -> PreparedRun:
        top = str(request.inputs.get("top_module") or "top")
        return PreparedRun(
            request=request,
            workspace_root=tempfile.gettempdir(),
            generated_scripts=[],
            command=["verilator", "--lint-only", top],
            allowed_paths=[],
        )

    def execute(self, prepared: PreparedRun) -> ToolRunResult:
        req = prepared.request
        cap = req.capability_id
        top = str(req.inputs.get("top_module") or "top")
        exe = shutil.which("verilator")

        if not exe:
            log = f"%Warning: verilator not found — mock lint for {top}\n"
            return ToolRunResult(
                request_id=req.request_id,
                success=True,
                exit_code=0,
                edagent_outcome="execution_succeeded",
                log_paths=["mock://verilator.log"],
                error="",
            )

        try:
            if cap == "lint_design":
                proc = subprocess.run(
                    [exe, "--lint-only", "-Wall", top],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                out = (proc.stdout or "") + (proc.stderr or "")
                ok = proc.returncode == 0
                return ToolRunResult(
                    request_id=req.request_id,
                    success=ok,
                    exit_code=proc.returncode,
                    error=out[-500:] if not ok else "",
                    edagent_outcome="execution_succeeded" if ok else "execution_failed",
                )
            return ToolRunResult(
                request_id=req.request_id,
                success=False,
                exit_code=1,
                error=f"capability not implemented: {cap}",
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

    def parse_artifacts(self, result: ToolRunResult) -> ParsedReportBundle:
        if result.error:
            return ParsedReportBundle(reports=[parse_verilator_log(result.error, stage="lint")])
        return ParsedReportBundle(
            reports=[
                ParsedReport(
                    type="log_summary",
                    tool="verilator",
                    stage="lint",
                    data={"error_count": 0, "mock": True},
                )
            ]
        )


def register() -> None:
    register_connector(VerilatorConnector())
    try:
        from edagent_vivado.repository.store import capability_upsert, connector_upsert

        connector_upsert("verilator", "Verilator", version="5.0", status="ready")
        for cap in VERILATOR_CAPABILITIES:
            capability_upsert(
                cap.connector_id,
                cap.capability_id,
                display_name=cap.display_name,
                stage=cap.stage,
                risk_level=cap.risk_level,
                requires_approval=cap.requires_approval,
                input_schema=cap.input_schema,
                outputs=cap.outputs,
            )
    except Exception:
        pass
