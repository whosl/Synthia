"""Generate internal .synthia/eda.yaml from XprDocument or ScanResult."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from edagent_vivado.projects.scanner import ScanResult
from edagent_vivado.projects.xpr_parser import XprDocument


def _rel_or_abs(project_root: str, path: str) -> str:
    """Prefer paths relative to project root when possible."""
    try:
        rel = Path(path).resolve().relative_to(Path(project_root).resolve())
        return str(rel).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def manifest_from_xpr(doc: XprDocument) -> dict[str, Any]:
    root = doc.project_dir
    return {
        "project": {
            "name": doc.name,
            "vivado_version": doc.vivado_version or "2024.1",
            "part": doc.part,
            "board_part": doc.board_part,
            "top": doc.top_module,
            "target_language": (doc.target_language or "Verilog").lower(),
            "flow": "project",
        },
        "sources": {
            "rtl": [_rel_or_abs(root, f.abs_path) for f in doc.rtl_files if f.file_type == "rtl"],
            "tb": [_rel_or_abs(root, f.abs_path) for f in doc.tb_files],
            "include_dirs": [],
        },
        "constraints": {
            "xdc": [_rel_or_abs(root, f.abs_path) for f in doc.xdc_files],
        },
        "ip": {
            "xci": [_rel_or_abs(root, f.abs_path) for f in doc.ip_files],
        },
        "bd": {
            "files": [_rel_or_abs(root, f.abs_path) for f in doc.bd_files],
        },
        "runs": {
            "synth": {"enabled": True},
            "impl": {"enabled": True},
        },
        "qor_targets": {
            "wns_min": 0.0,
            "require_drc_clean": True,
        },
        "_meta": {
            "imported_from_xpr": doc.xpr_path,
            "warnings": doc.warnings,
        },
    }


def manifest_from_scan(
    scan: ScanResult,
    *,
    top_module: str = "",
    part: str = "",
    name: str = "",
) -> dict[str, Any]:
    root = scan.root
    rtl = [_rel_or_abs(root, p) for p in scan.rtl_files + scan.sv_files + scan.vhd_files]
    return {
        "project": {
            "name": name or Path(scan.root).name,
            "vivado_version": "2024.1",
            "part": part or scan.detected_part,
            "top": top_module or (scan.candidate_top_modules[0] if scan.candidate_top_modules else ""),
            "flow": "non_project",
        },
        "sources": {
            "rtl": rtl,
            "tb": [],
            "include_dirs": [],
        },
        "constraints": {
            "xdc": [_rel_or_abs(root, p) for p in scan.xdc_files],
        },
        "ip": {"xci": [_rel_or_abs(root, p) for p in scan.ip_files]},
        "bd": {"files": [_rel_or_abs(root, p) for p in scan.bd_files]},
        "runs": {
            "synth": {"enabled": True},
            "impl": {"enabled": False},
        },
        "_meta": {
            "imported_from_scan": scan.root,
            "candidate_top_modules": scan.candidate_top_modules,
        },
    }


def write_internal_manifest(
    project_root: str | Path,
    manifest: dict[str, Any],
) -> Path:
    root = Path(project_root)
    synthia_dir = root / ".synthia"
    synthia_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = synthia_dir / "eda.yaml"
    manifest_path.write_text(
        yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return manifest_path.resolve()
