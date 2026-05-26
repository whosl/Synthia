"""Vivado execution dispatcher — extracted from connector.py (Phase 2)."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import TYPE_CHECKING

from edagent_vivado.connectors.base.types import Artifact, ToolRunRequest, ToolRunResult
from edagent_vivado.connectors.vivado.parsers.log_summary import parse_log_summary

if TYPE_CHECKING:
    from edagent_vivado.connectors.vivado.connector import VivadoConnector


def run_synthesis(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    manifest_path = str(req.manifest_path or req.inputs.get("manifest_path") or "")
    if not manifest_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="manifest_path required",
            edagent_outcome="execution_failed",
        )
    raw = connector._adapter.run_synthesis(
        manifest_path,
        session_id=str(req.inputs.get("session_id") or ""),
        task_id=str(req.inputs.get("task_id") or ""),
        run_id=str(req.run_id or req.inputs.get("run_id") or ""),
    )
    return connector._result_from_raw(req.request_id, raw, stage="synth")


def run_implementation(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    manifest_path = str(req.manifest_path or req.inputs.get("manifest_path") or "")
    if not manifest_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="manifest_path required",
            edagent_outcome="execution_failed",
        )
    run_synth_first = bool(req.inputs.get("run_synth_first", True))
    raw = connector._adapter.run_implementation(
        manifest_path,
        session_id=str(req.inputs.get("session_id") or ""),
        task_id=str(req.inputs.get("task_id") or ""),
        run_id=str(req.run_id or req.inputs.get("run_id") or ""),
        run_synth_first=run_synth_first,
    )
    return connector._result_from_raw(req.request_id, raw, stage="impl")


def classify_error_from_log(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    del connector
    log_path = str(req.inputs.get("log_path") or "")
    if not log_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="log_path required",
            edagent_outcome="execution_failed",
        )
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


def stub_not_implemented(req: ToolRunRequest, capability_id: str) -> ToolRunResult:
    return ToolRunResult(
        request_id=req.request_id,
        success=False,
        exit_code=1,
        error=f"{capability_id} stub — full implementation planned for Phase 3",
        edagent_outcome="execution_failed",
    )


def generate_bitstream(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    manifest_path = str(req.manifest_path or req.inputs.get("manifest_path") or "")
    if not manifest_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="manifest_path required",
            edagent_outcome="execution_failed",
        )
    raw = connector._adapter.run_bitstream(
        manifest_path,
        session_id=str(req.inputs.get("session_id") or ""),
        task_id=str(req.inputs.get("task_id") or ""),
        run_id=str(req.run_id or req.inputs.get("run_id") or ""),
    )
    return connector._result_from_raw(req.request_id, raw, stage="bitstream")


def collect_bitstream(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    del connector
    run_id = str(req.inputs.get("run_id") or req.run_id or "")
    if not run_id:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="run_id required",
            edagent_outcome="execution_failed",
        )
    from edagent_vivado.harness.run_workspace import ensure_run_workspace

    ws = ensure_run_workspace(run_id)
    artifacts: list[Artifact] = []
    for bp in Path(ws.root).rglob("*.bit"):
        try:
            data = bp.read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            artifacts.append(
                Artifact(
                    artifact_id=f"bit_{sha[:12]}",
                    artifact_type="bitstream",
                    path=str(bp),
                    mime_type="application/octet-stream",
                    size_bytes=len(data),
                    sha256=sha,
                )
            )
        except OSError:
            continue
    return ToolRunResult(
        request_id=req.request_id,
        success=bool(artifacts),
        exit_code=0 if artifacts else 1,
        artifacts=artifacts,
        edagent_outcome="execution_succeeded" if artifacts else "execution_failed",
        error="" if artifacts else "no .bit file found",
    )


def run_full_flow(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    stages = req.inputs.get("stages") or ["synth", "impl"]
    if not isinstance(stages, list):
        stages = [str(stages)]
    if "synth" in stages or "impl" in stages:
        synth_first = "synth" in stages
        impl_req = ToolRunRequest(
            request_id=req.request_id,
            run_id=req.run_id,
            step_id=req.step_id,
            connector_id=req.connector_id,
            capability_id="run_implementation",
            inputs={**req.inputs, "run_synth_first": synth_first},
            manifest_path=req.manifest_path,
            target_id=req.target_id,
            auto_approved=req.auto_approved,
        )
        impl_result = run_implementation(connector, impl_req)
        if not impl_result.success:
            return impl_result
    if "bitstream" in stages:
        return generate_bitstream(connector, req)
    return ToolRunResult(
        request_id=req.request_id,
        success=True,
        exit_code=0,
        edagent_outcome="execution_succeeded",
    )
