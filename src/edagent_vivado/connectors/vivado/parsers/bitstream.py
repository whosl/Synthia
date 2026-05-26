"""Detect and describe bitstream-related files in a Vivado run workspace."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from edagent_vivado.connectors.base.types import ParsedReport

_KIND_MAP = {
    ".bit": "bit",
    ".bin": "bin",
    ".mcs": "mcs",
    ".ltx": "ltx",
}

_SHA_FULL_LIMIT = 64 * 1024 * 1024


def detect_bitstream(workspace_dir: str | Path, *, stage: str = "bitstream") -> ParsedReport:
    """Walk *workspace_dir* and return a ParsedReport describing bitstream files."""
    root = Path(workspace_dir) if workspace_dir else None
    if not root or not root.exists():
        return ParsedReport(
            type="bitstream",
            tool="vivado",
            stage=stage,
            data={"found": False, "files": [], "count": 0, "primary_bit": ""},
        )

    matches: list[Path] = []
    for ext in _KIND_MAP:
        matches.extend(sorted(root.rglob(f"*{ext}")))

    files: list[dict[str, Any]] = []
    bit_paths: list[Path] = []
    for path in matches:
        kind = _KIND_MAP.get(path.suffix.lower())
        if not kind:
            continue
        if kind == "bit":
            bit_paths.append(path)
        files.append(_describe(path, kind))

    primary = ""
    if bit_paths:
        primary = str(bit_paths[0].resolve()).replace("\\", "/")

    return ParsedReport(
        type="bitstream",
        tool="vivado",
        stage=stage,
        data={
            "found": bool(bit_paths),
            "count": len(files),
            "primary_bit": primary,
            "files": files,
        },
    )


def _describe(path: Path, kind: str) -> dict[str, Any]:
    try:
        stat = path.stat()
        size = stat.st_size
        mtime = int(stat.st_mtime)
    except OSError:
        size, mtime = 0, 0
    sha = ""
    if 0 < size <= _SHA_FULL_LIMIT:
        try:
            h = hashlib.sha256()
            with path.open("rb") as fh:
                for chunk in iter(lambda: fh.read(65536), b""):
                    h.update(chunk)
            sha = h.hexdigest()
        except OSError:
            sha = ""
    return {
        "path": str(path.resolve()).replace("\\", "/"),
        "kind": kind,
        "size_bytes": size,
        "mtime": mtime,
        "sha256": sha,
    }
