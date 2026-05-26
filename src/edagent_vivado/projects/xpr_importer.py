"""Import Vivado .xpr projects into Synthia internal manifest layout."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from edagent_vivado.projects.manifest_gen import manifest_from_xpr, write_internal_manifest
from edagent_vivado.projects.manifest_sync import write_fingerprint
from edagent_vivado.projects.xpr_parser import XprDocument, parse_xpr


@dataclass
class ImportXprResult:
    doc: XprDocument
    project_root: str
    manifest_path: str
    xpr_path: str


def import_xpr_project(xpr_path: str | Path) -> ImportXprResult:
    """Parse .xpr, write .synthia/eda.yaml and fingerprint snapshot."""
    doc = parse_xpr(xpr_path)
    project_root = doc.project_dir
    manifest = manifest_from_xpr(doc)
    manifest_path = write_internal_manifest(project_root, manifest)
    write_fingerprint(project_root, doc.xpr_path)
    return ImportXprResult(
        doc=doc,
        project_root=project_root,
        manifest_path=str(manifest_path).replace("\\", "/"),
        xpr_path=doc.xpr_path,
    )


def project_create_fields_from_import(result: ImportXprResult) -> dict:
    """Fields for repository.store.project_create."""
    return {
        "name": result.doc.name,
        "root_path": result.project_root,
        "manifest_path": result.manifest_path,
        "xpr_path": result.xpr_path,
        "part": result.doc.part or None,
        "board_part": result.doc.board_part or None,
        "top_module": result.doc.top_module or None,
        "target_language": (result.doc.target_language or "Verilog"),
        "metadata": {
            "imported_from_xpr": result.xpr_path,
            "warnings": result.doc.warnings,
        },
    }
