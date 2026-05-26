"""Artifact persistence bridge to repository store."""

from __future__ import annotations

from pathlib import Path

from edagent_vivado.connectors.base.types import Artifact
from edagent_vivado.repository.store import artifact_create


def persist_artifact(
    artifact_type: str,
    path: str | Path,
    *,
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
    mime_type: str = "",
    summary: str = "",
) -> Artifact:
    p = Path(path)
    row = artifact_create(
        artifact_type,
        str(p),
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
        mime_type=mime_type,
        size_bytes=p.stat().st_size if p.is_file() else 0,
        summary=summary,
    )
    return Artifact(
        artifact_id=row["id"],
        artifact_type=artifact_type,
        path=str(p),
        mime_type=mime_type or row.get("mime_type") or "",
        size_bytes=int(row.get("size_bytes") or 0),
        sha256=row.get("sha256") or "",
    )
