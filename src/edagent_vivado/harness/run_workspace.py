"""Unified Run Workspace layout — SPEC §9B.9."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from edagent_vivado.repository.store import run_get, run_update

RUN_WORKSPACE_SUBDIRS = (
    "input_snapshot",
    "generated_tcl",
    "logs",
    "reports",
    "checkpoints",
    "bitstreams",
    "artifacts",
    "patches",
    "parsed",
    "audit",
)


def runtime_root() -> Path:
    return Path(os.environ.get("EDAGENT_RUNTIME_DIR", ".edagent")).resolve()


class RunWorkspace:
    """Per-run directory under ``{runtime}/runs/run_{id}/``."""

    def __init__(self, run_id: str, base: Path | None = None) -> None:
        self.run_id = run_id
        self.root = (base or runtime_root() / "runs" / f"run_{run_id}").resolve()

    def ensure(self) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        for sub in RUN_WORKSPACE_SUBDIRS:
            (self.root / sub).mkdir(exist_ok=True)
        self._write_layout()
        return self.root

    def subdir(self, name: str) -> Path:
        if name not in RUN_WORKSPACE_SUBDIRS:
            raise ValueError(f"unknown workspace subdir: {name}")
        p = self.root / name
        p.mkdir(parents=True, exist_ok=True)
        return p

    def _write_layout(self) -> None:
        layout = {
            "run_id": self.run_id,
            "root": str(self.root),
            "subdirs": list(RUN_WORKSPACE_SUBDIRS),
        }
        (self.root / "layout.json").write_text(
            json.dumps(layout, indent=2),
            encoding="utf-8",
        )

    def bind_run_metadata(self) -> dict | None:
        """Persist workspace path on the run row."""
        row = run_get(self.run_id)
        if not row:
            return None
        try:
            meta = json.loads(row.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            meta = {}
        meta["workspace_root"] = str(self.root)
        meta["workspace_layout"] = list(RUN_WORKSPACE_SUBDIRS)
        return run_update(self.run_id, metadata_json=json.dumps(meta, ensure_ascii=False))


def ensure_run_workspace(run_id: str) -> RunWorkspace:
    """Create layout and attach metadata; safe to call repeatedly."""
    ws = RunWorkspace(run_id)
    ws.ensure()
    ws.bind_run_metadata()
    return ws


def mirror_artifact_path(run_id: str, src_path: str | Path, *, subdir: str = "artifacts") -> Path | None:
    """Copy a file into the unified run workspace (reports/logs/artifacts)."""
    src = Path(src_path)
    if not src.is_file() or not run_id:
        return None
    if subdir not in RUN_WORKSPACE_SUBDIRS:
        subdir = "artifacts"
    ws = RunWorkspace(run_id)
    ws.ensure()
    dest = ws.subdir(subdir) / src.name
    try:
        shutil.copy2(src, dest)
        return dest
    except OSError:
        return None


def mirror_artifacts_from_paths(run_id: str, paths: list[str | Path]) -> list[str]:
    """Best-effort copy of report/log paths into workspace subdirs."""
    copied: list[str] = []
    for raw in paths:
        p = Path(raw)
        if not p.is_file():
            continue
        sub = "reports"
        name = p.name.lower()
        if "vivado.log" in name or name.endswith(".log"):
            sub = "logs"
        elif name.endswith((".bit", ".bin")):
            sub = "bitstreams"
        elif name.endswith((".dcp", ".rpt")):
            sub = "reports" if name.endswith(".rpt") else "checkpoints"
        dest = mirror_artifact_path(run_id, p, subdir=sub)
        if dest:
            copied.append(str(dest))
    return copied


def workspace_root_for_run(run_id: str) -> Path | None:
    row = run_get(run_id)
    if not row:
        return None
    try:
        meta = json.loads(row.get("metadata_json") or "{}")
    except json.JSONDecodeError:
        meta = {}
    root = meta.get("workspace_root")
    if root:
        return Path(root)
    ws = RunWorkspace(run_id)
    if ws.root.is_dir():
        return ws.root
    return None
