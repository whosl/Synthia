"""Generic ToolManifest parsing — wraps eda.yaml via harness Manifest."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from edagent_vivado.connectors.base.types import ToolManifest, ValidationResult


def manifest_from_eda_yaml(path: str | Path) -> ToolManifest:
    """Load Vivado-style eda.yaml into a cross-tool ToolManifest."""
    from edagent_vivado.harness.manifest import Manifest

    p = Path(path)
    m = Manifest.load(p)
    raw = m.model_dump()

    project_name = m.project.name
    extensions: dict[str, Any] = {}
    vivado_ext: dict[str, Any] = {}
    if raw.get("runs"):
        vivado_ext["runs"] = raw["runs"]
    if raw.get("qor_targets"):
        vivado_ext["qor_targets"] = raw["qor_targets"]
    if vivado_ext:
        extensions["vivado"] = vivado_ext

    return ToolManifest(
        project={"name": project_name, "root": str(p.parent), "type": "fpga"},
        tool={
            "connector": "vivado",
            "version": str(m.project.vivado_version or ""),
            "mode": str(m.project.flow or "non_project"),
        },
        source={
            "rtl": list(m.sources.rtl),
            "constraints": list(m.constraints.xdc),
            "tb": list(m.sources.tb),
        },
        design={
            "top": m.project.top,
            "part": m.project.part,
            "board_part": getattr(m.project, "board_part", None),
        },
        flow={"stages": _infer_stages_from_manifest(m)},
        raw=raw,
        extensions=extensions,
    )


def _infer_stages_from_manifest(m: Any) -> list[str]:
    stages: list[str] = ["validate"]
    if m.runs.synth.enabled:
        stages.append("synth")
    if m.runs.impl.enabled:
        stages.extend(["opt", "place", "route"])
    stages.append("report")
    return stages


def validate_manifest_file(path: str | Path) -> ValidationResult:
    p = Path(path)
    if not p.is_file():
        return ValidationResult(ok=False, errors=[f"manifest not found: {path}"])
    try:
        manifest_from_eda_yaml(p)
        return ValidationResult(ok=True)
    except Exception as exc:
        return ValidationResult(ok=False, errors=[str(exc)])
