"""ArtifactStore — simple key-value artifact persistence."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class ArtifactStore:
    """Read/write artifacts (JSON/text) inside a workspace."""

    def __init__(self, root: str | Path) -> None:
        self._root = Path(root)

    def put_json(self, key: str, data: Any) -> Path:
        p = self._root / f"{key}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w") as f:
            json.dump(data, f, indent=2, default=str)
        return p

    def get_json(self, key: str) -> Any | None:
        p = self._root / f"{key}.json"
        if not p.exists():
            return None
        with open(p) as f:
            return json.load(f)

    def put_text(self, key: str, text: str) -> Path:
        p = self._root / f"{key}.txt"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return p

    def get_text(self, key: str) -> str | None:
        p = self._root / f"{key}.txt"
        return p.read_text() if p.exists() else None
