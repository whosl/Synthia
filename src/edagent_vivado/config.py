"""Configuration loader — reads YAML configs and merges with environment."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG_PATHS = [
    Path("configs/default.yaml"),
    Path.home() / ".edagent" / "config.yaml",
]


class EdAgentConfig:
    """Central config — loads from YAML then overlays env vars."""

    def __init__(self, config_path: str | Path | None = None) -> None:
        self._data: dict[str, Any] = {}
        if config_path:
            self._load_file(Path(config_path))
        else:
            for p in DEFAULT_CONFIG_PATHS:
                if p.exists():
                    self._load_file(p)
                    break
        self._apply_env_overrides()

    # ── loader ────────────────────────────────────────────────
    def _load_file(self, path: Path) -> None:
        with open(path) as f:
            self._data = yaml.safe_load(f) or {}

    def _apply_env_overrides(self) -> None:
        if os.environ.get("VIVADO_PATH"):
            self._data.setdefault("vivado", {})["path"] = os.environ["VIVADO_PATH"]

    # ── accessors ─────────────────────────────────────────────
    @property
    def raw(self) -> dict[str, Any]:
        return self._data

    def get(self, key: str, default: Any = None) -> Any:
        keys = key.split(".")
        d = self._data
        for k in keys:
            if not isinstance(d, dict):
                return default
            d = d.get(k)
            if d is None:
                return default
        return d

    def vivado_path(self) -> str | None:
        return self.get("vivado.path") or os.environ.get("VIVADO_PATH")

    def project(self) -> dict[str, Any]:
        return self.get("project", {})

    @property
    def langsmith_tracing(self) -> bool:
        return os.environ.get("LANGSMITH_TRACING", "").lower() in ("true", "1")

    @property
    def anthropic_api_key(self) -> str | None:
        return os.environ.get("ANTHROPIC_API_KEY")

    @property
    def edagent_model(self) -> str:
        return os.environ.get("EDAGENT_MODEL", "claude-sonnet-4-20250514")
