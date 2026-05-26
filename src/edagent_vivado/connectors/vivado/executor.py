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


def import_xpr(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    del connector
    from edagent_vivado.projects.xpr_importer import import_xpr_project

    xpr_path = str(req.inputs.get("xpr_path") or "")
    if not xpr_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="xpr_path required",
            edagent_outcome="execution_failed",
        )
    try:
        result = import_xpr_project(xpr_path)
        return ToolRunResult(
            request_id=req.request_id,
            success=True,
            exit_code=0,
            edagent_outcome="execution_succeeded",
            artifacts=[
                Artifact(
                    artifact_id=f"manifest_{result.doc.name}",
                    artifact_type="manifest",
                    path=result.manifest_path,
                    mime_type="application/x-yaml",
                )
            ],
        )
    except Exception as exc:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error=f"import_xpr failed: {exc}",
            edagent_outcome="execution_failed",
        )


def scan_project(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    del connector
    import json

    from edagent_vivado.projects.scanner import scan_directory

    root_path = str(req.inputs.get("root_path") or "")
    if not root_path:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="root_path required",
            edagent_outcome="execution_failed",
        )
    try:
        result = scan_directory(root_path)
        payload = result.to_dict()
        return ToolRunResult(
            request_id=req.request_id,
            success=result.is_likely_fpga_project,
            exit_code=0 if result.is_likely_fpga_project else 1,
            edagent_outcome="execution_succeeded" if result.is_likely_fpga_project else "execution_failed",
            error=json.dumps(payload),
        )
    except Exception as exc:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error=f"scan failed: {exc}",
            edagent_outcome="execution_failed",
        )


def sync_xpr_manifest(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    del connector
    import json

    from edagent_vivado.projects.manifest_sync import check_sync

    project_root = str(req.inputs.get("project_root") or req.inputs.get("root_path") or "")
    if not project_root:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error="project_root required",
            edagent_outcome="execution_failed",
        )
    sr = check_sync(project_root)
    ok = sr.status in ("in_sync", "no_xpr")
    return ToolRunResult(
        request_id=req.request_id,
        success=ok,
        exit_code=0 if ok else 1,
        edagent_outcome="execution_succeeded" if ok else "execution_failed",
        error=json.dumps({"status": sr.status, "detail": sr.detail}),
    )


def create_vivado_project(connector: VivadoConnector, req: ToolRunRequest) -> ToolRunResult:
    del connector
    from edagent_vivado.projects.wizard import WizardInput, create_project

    try:
        wi = WizardInput(
            name=str(req.inputs.get("name") or ""),
            location=str(req.inputs.get("location") or ""),
            part=str(req.inputs.get("part") or ""),
            board_part=str(req.inputs.get("board_part") or ""),
            top_module=str(req.inputs.get("top_module") or ""),
            target_language=str(req.inputs.get("target_language") or "verilog"),
            rtl_sources=list(req.inputs.get("rtl_sources") or []),
            xdc_sources=list(req.inputs.get("xdc_sources") or []),
            tb_sources=list(req.inputs.get("tb_sources") or []),
            ip_sources=list(req.inputs.get("ip_sources") or []),
            bd_sources=list(req.inputs.get("bd_sources") or []),
            copy_sources=bool(req.inputs.get("copy_sources", True)),
        )
        result = create_project(wi)
        return ToolRunResult(
            request_id=req.request_id,
            success=True,
            exit_code=0,
            edagent_outcome="execution_succeeded",
            artifacts=[
                Artifact(
                    artifact_id=f"manifest_{wi.name}",
                    artifact_type="manifest",
                    path=str(result.manifest_path).replace("\\", "/"),
                )
            ],
            error="; ".join(result.warnings) if result.warnings else "",
        )
    except Exception as exc:
        return ToolRunResult(
            request_id=req.request_id,
            success=False,
            exit_code=1,
            error=str(exc),
            edagent_outcome="execution_failed",
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
    del connector
    return ToolRunResult(
        request_id=req.request_id,
        success=False,
        exit_code=1,
        error="run_full_flow is deprecated — use RunOrchestrator via POST /api/v1/vivado/commands/flow",
        edagent_outcome="execution_failed",
    )
