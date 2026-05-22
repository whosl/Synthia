"""Workspace — manages per-run working directory."""

from __future__ import annotations

import json
import logging
import shutil
import shlex
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

from edagent_vivado.harness.manifest import Manifest

logger = logging.getLogger(__name__)


class Workspace:
    """Creates and manages a timestamped run directory."""

    def __init__(self, base_dir: str | Path, task_name: str = "run") -> None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.root = (Path(base_dir) / f"{timestamp}_{task_name}").resolve()
        self._mkdirs()

    # ── directory creation ────────────────────────────────────

    def _mkdirs(self) -> None:
        for sub in ("reports", "scripts", "checkpoints", "artifacts", "agent_notes"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)

    # ── artifact helpers ──────────────────────────────────────

    def artifact_path(self, name: str) -> Path:
        return self.root / "artifacts" / name

    def script_path(self, name: str) -> Path:
        return self.root / "scripts" / name

    def report_path(self, name: str) -> Path:
        return self.root / "reports" / name

    def checkpoint_path(self, name: str) -> Path:
        return self.root / "checkpoints" / name

    def note_path(self, name: str) -> Path:
        return self.root / "agent_notes" / name

    # ── manifest persistence ──────────────────────────────────

    def write_manifest(self, manifest: Manifest) -> Path:
        dst = self.root / "input_manifest.yaml"
        with open(dst, "w") as f:
            yaml.dump(manifest.model_dump(), f)
        return dst

    def write_json(self, data: Any, name: str) -> Path:
        p = self.artifact_path(name)
        with open(p, "w") as f:
            json.dump(data, f, indent=2, default=str)
        return p

    # ── source management ────────────────────────────────────

    def copy_sources(self, manifest: Manifest) -> None:
        src_dir = self.root / "src"
        src_dir.mkdir(exist_ok=True)
        for rtl in manifest.rtl_paths():
            if rtl.exists():
                shutil.copy2(rtl, src_dir / rtl.name)
        for xdc in manifest.xdc_paths():
            if xdc.exists():
                shutil.copy2(xdc, self.root / xdc.name)

    def __str__(self) -> str:
        return str(self.root)
