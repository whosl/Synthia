"""Hash-aware file sync to remote Vivado host — Phase 3A."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.path_mapper import PathMapper
from edagent_vivado.harness.remote_executor import RemoteExecutor

logger = logging.getLogger(__name__)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def sync_manifest_sources(
    manifest: Manifest,
    workspace_root: Path,
    executor: RemoteExecutor | None = None,
    *,
    remote_work_dir: str | None = None,
) -> dict[str, Any]:
    """Upload RTL/XDC from workspace to remote src/ (skip unchanged by sha256)."""
    ex = executor or RemoteExecutor()
    rwd = remote_work_dir or ex.target.remote_work_root
    mapper = PathMapper(workspace_root, rwd)
    remote_src = mapper.remote_src_dir()
    ex.mkdir_remote(remote_src)

    state_path = workspace_root / "artifacts" / "file_sync_state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    prev: dict[str, str] = {}
    if state_path.is_file():
        try:
            prev = json.loads(state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            prev = {}

    uploaded: list[str] = []
    skipped: list[str] = []

    ws_src = workspace_root / "src"
    candidates: list[Path] = []
    if ws_src.is_dir():
        candidates.extend(p for p in ws_src.rglob("*") if p.is_file())
    for p in manifest.rtl_paths() + manifest.xdc_paths():
        if p.is_file() and p not in candidates:
            candidates.append(p)

    new_state: dict[str, str] = {}
    for local in candidates:
        digest = _sha256(local)
        try:
            key = str(local.resolve().relative_to(workspace_root.resolve()))
        except ValueError:
            key = local.name
        new_state[key] = digest
        if prev.get(key) == digest:
            skipped.append(key)
            continue
        rel_name = local.name
        rel_name = local.name
        try:
            rel_name = str(local.resolve().relative_to(ws_src.resolve())).replace("\\", "/")
        except ValueError:
            pass
        remote = f"{remote_src}/{rel_name}"
        ex.mkdir_remote(str(Path(remote).parent.as_posix()).replace("\\", "/"))
        result = ex.upload(local, remote)
        if result.return_code != 0:
            return {
                "ok": False,
                "error": result.stderr or "upload failed",
                "uploaded": uploaded,
                "skipped": skipped,
                "remote_src": remote_src,
            }
        uploaded.append(key)

    state_path.write_text(json.dumps(new_state, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "uploaded": uploaded,
        "skipped": skipped,
        "remote_src": remote_src,
        "remote_work_dir": rwd,
    }
