"""Vivado-like project creation wizard."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from edagent_vivado.projects.manifest_gen import write_internal_manifest

ProjectKind = Literal["rtl_project", "post_synth", "empty"]


@dataclass
class WizardInput:
    name: str
    location: str
    kind: ProjectKind = "rtl_project"
    part: str = ""
    board_part: str = ""
    top_module: str = ""
    target_language: str = "verilog"
    rtl_sources: list[str] = field(default_factory=list)
    xdc_sources: list[str] = field(default_factory=list)
    tb_sources: list[str] = field(default_factory=list)
    ip_sources: list[str] = field(default_factory=list)
    bd_sources: list[str] = field(default_factory=list)
    include_dirs: list[str] = field(default_factory=list)
    copy_sources: bool = True


@dataclass
class WizardResult:
    project_root: Path
    manifest_path: Path
    xpr_path: Path | None = None
    warnings: list[str] = field(default_factory=list)


def create_project(req: WizardInput) -> WizardResult:
    root = Path(req.location) / req.name
    root.mkdir(parents=True, exist_ok=False)

    warnings: list[str] = []
    if req.copy_sources:
        rtl_dir = root / "rtl"
        constr_dir = root / "constraints"
        tb_dir = root / "tb"
        ip_dir = root / "ip"
        bd_dir = root / "bd"
        for d in (rtl_dir, constr_dir, tb_dir, ip_dir, bd_dir):
            d.mkdir(exist_ok=True)
        rtl_copies = _copy_files(req.rtl_sources, rtl_dir, warnings)
        xdc_copies = _copy_files(req.xdc_sources, constr_dir, warnings)
        tb_copies = _copy_files(req.tb_sources, tb_dir, warnings)
        ip_copies = _copy_files(req.ip_sources, ip_dir, warnings)
        bd_copies = _copy_files(req.bd_sources, bd_dir, warnings)
    else:
        rtl_copies = [str(Path(p)).replace("\\", "/") for p in req.rtl_sources]
        xdc_copies = [str(Path(p)).replace("\\", "/") for p in req.xdc_sources]
        tb_copies = [str(Path(p)).replace("\\", "/") for p in req.tb_sources]
        ip_copies = [str(Path(p)).replace("\\", "/") for p in req.ip_sources]
        bd_copies = [str(Path(p)).replace("\\", "/") for p in req.bd_sources]

    manifest = {
        "project": {
            "name": req.name,
            "vivado_version": "2024.1",
            "part": req.part,
            "board_part": req.board_part,
            "top": req.top_module,
            "target_language": req.target_language,
            "flow": "project",
        },
        "sources": {
            "rtl": rtl_copies,
            "tb": tb_copies,
            "include_dirs": req.include_dirs,
        },
        "constraints": {"xdc": xdc_copies},
        "ip": {"xci": ip_copies},
        "bd": {"files": bd_copies},
        "runs": {
            "synth": {"enabled": True},
            "impl": {"enabled": True},
        },
        "_meta": {
            "created_by_wizard": True,
            "wizard_kind": req.kind,
        },
    }
    manifest_path = write_internal_manifest(root, manifest)

    return WizardResult(
        project_root=root,
        manifest_path=manifest_path,
        xpr_path=None,
        warnings=warnings,
    )


def _copy_files(sources: list[str], dest_dir: Path, warnings: list[str]) -> list[str]:
    out: list[str] = []
    for src in sources:
        sp = Path(src)
        if not sp.exists():
            warnings.append(f"source not found, skipped: {src}")
            continue
        dst = dest_dir / sp.name
        try:
            shutil.copy2(sp, dst)
            out.append(str(dst).replace("\\", "/"))
        except OSError as exc:
            warnings.append(f"copy failed for {src}: {exc}")
    return out
