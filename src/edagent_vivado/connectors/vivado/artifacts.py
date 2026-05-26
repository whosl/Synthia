"""Collect Vivado workspace report files as connector Artifacts."""

from __future__ import annotations

import hashlib
from pathlib import Path

from edagent_vivado.connectors.base.types import Artifact

_REPORT_SUFFIXES = (
    "_timing_summary.rpt",
    "_utilization.rpt",
    "_drc.rpt",
    "_methodology.rpt",
)


def stage_from_path(path: str) -> str:
    name = Path(path).name.lower()
    if "post_synth" in name or "/synth" in path.replace("\\", "/").lower():
        return "synth"
    if "post_impl" in name or "/impl" in path.replace("\\", "/").lower():
        return "impl"
    return "report"


def artifacts_from_workspace(workspace: str | Path, *, stage: str = "") -> list[Artifact]:
    root = Path(workspace)
    if not root.is_dir():
        return []
    reports_dir = root / "reports"
    if not reports_dir.is_dir():
        return []
    out: list[Artifact] = []
    for path in sorted(reports_dir.iterdir()):
        if not path.is_file():
            continue
        if not any(path.name.endswith(sfx) for sfx in _REPORT_SUFFIXES) and path.suffix != ".log":
            continue
        st = stage or stage_from_path(str(path))
        try:
            size = path.stat().st_size
            digest = hashlib.sha256(path.read_bytes()[:65536]).hexdigest()[:16]
        except OSError:
            size, digest = 0, ""
        out.append(
            Artifact(
                artifact_id=f"{st}:{path.name}",
                artifact_type=_artifact_type(path.name),
                path=str(path),
                mime_type="text/plain",
                size_bytes=size,
                sha256=digest,
            )
        )
    vivado_log = root / "vivado.log"
    if vivado_log.is_file():
        out.append(
            Artifact(
                artifact_id=f"log:vivado.log",
                artifact_type="vivado_log",
                path=str(vivado_log),
                mime_type="text/plain",
            )
        )
    return out


def _artifact_type(filename: str) -> str:
    lower = filename.lower()
    if "timing" in lower:
        return "timing_summary"
    if "utilization" in lower:
        return "utilization"
    if "drc" in lower:
        return "drc"
    if "methodology" in lower:
        return "methodology"
    if lower.endswith(".log"):
        return "vivado_log"
    return "report"
