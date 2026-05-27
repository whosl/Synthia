"""Register connector artifacts in DB with full-file sha256."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from edagent_vivado.connectors.base.types import Artifact, ToolRunRequest

logger = logging.getLogger(__name__)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def register_artifact(
    *,
    run_id: str,
    artifact_type: str,
    path: str,
    session_id: str = "",
    task_id: str = "",
    mime_type: str = "",
    summary: str = "",
) -> dict:
    from edagent_vivado.repository.store import artifact_create

    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"artifact path not found: {path}")

    sha = _sha256_file(p)
    size = p.stat().st_size
    return artifact_create(
        artifact_type=artifact_type,
        path=str(p).replace("\\", "/"),
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
        mime_type=mime_type,
        size_bytes=size,
        sha256=sha,
        summary=summary,
    )


def persist_result_artifacts(request: ToolRunRequest, artifacts: list[Artifact]) -> None:
    """Best-effort DB registration for artifacts returned by a connector step."""
    if not request.run_id or not artifacts:
        return
    session_id = str(request.inputs.get("session_id") or "")
    task_id = str(request.inputs.get("task_id") or "")
    for art in artifacts:
        path = str(art.path or "")
        if not path or not Path(path).is_file():
            continue
        try:
            row = register_artifact(
                run_id=request.run_id,
                artifact_type=art.artifact_type or "file",
                path=path,
                session_id=session_id,
                task_id=task_id,
                mime_type=art.mime_type or "",
                summary=art.artifact_id,
            )
            if session_id:
                try:
                    from edagent_vivado.web.api_shared import event_create

                    event_create(
                        session_id,
                        "artifact.created",
                        {
                            "ui_kind": "artifact",
                            "block_id": f"art-{row.get('id', art.artifact_id)}",
                            "artifact_id": row.get("id", art.artifact_id),
                            "path": path,
                            "kind": art.artifact_type or "file",
                            "sha256": row.get("sha256", ""),
                            "size_bytes": row.get("size_bytes", 0),
                            "run_id": request.run_id,
                        },
                        task_id=task_id,
                        run_id=request.run_id,
                    )
                except Exception:
                    logger.exception("artifact.created event emit failed (non-fatal)")
        except Exception:
            logger.exception("register_artifact failed for %s", path)
