"""Project path validation per SPEC §7.1."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


class ProjectValidationError(ValueError):
    pass


def _resolve(path: str, base: Path | None = None) -> Path:
    p = Path(path).expanduser()
    if not p.is_absolute() and base is not None:
        p = (base / p).resolve()
    else:
        p = p.resolve()
    return p


def load_manifest(manifest_path: Path) -> dict[str, Any]:
    if not manifest_path.is_file():
        raise ProjectValidationError(f"manifest not found: {manifest_path}")
    try:
        data = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        raise ProjectValidationError(f"manifest parse failed: {exc}") from exc
    if not isinstance(data, dict):
        raise ProjectValidationError("manifest must be a YAML mapping")
    return data


def validate_project_paths(
    *,
    root_path: str,
    manifest_path: str,
    xpr_path: str,
    part: str | None = None,
    board_part: str | None = None,
    cwd: Path | None = None,
) -> dict[str, Any]:
    """Validate and normalize project paths. Returns manifest dict + resolved paths."""
    base = cwd or Path.cwd()
    root = _resolve(root_path, base)
    manifest = _resolve(manifest_path, base)
    xpr = _resolve(xpr_path, base) if xpr_path.strip() else None

    if not root.is_dir():
        raise ProjectValidationError(f"root_path is not a directory: {root}")

    manifest_data = load_manifest(manifest)

    try:
        manifest.relative_to(root)
    except ValueError:
        raise ProjectValidationError("manifest_path must be under root_path")

    flow = str((manifest_data.get("project") or {}).get("flow") or "").lower()
    non_project = flow == "non_project"

    if xpr is not None:
        if not xpr.is_file():
            if non_project:
                xpr = None
            else:
                raise ProjectValidationError(f"xpr_path not found: {xpr}")
        else:
            try:
                xpr.relative_to(root)
            except ValueError:
                raise ProjectValidationError("xpr_path must be under root_path")

    if xpr is None and not non_project:
        raise ProjectValidationError("xpr_path is required unless manifest project.flow is non_project")

    part = (part or "").strip() or str((manifest_data.get("project") or {}).get("part") or "").strip()
    board_part = (board_part or "").strip() or str(
        (manifest_data.get("project") or {}).get("board_part") or ""
    ).strip()
    if not part and not board_part:
        raise ProjectValidationError("part or board_part is required (in request or manifest)")

    top_module = str((manifest_data.get("project") or {}).get("top") or "").strip()

    return {
        "root_path": str(root),
        "manifest_path": str(manifest),
        "xpr_path": str(xpr) if xpr else "",
        "part": part or None,
        "board_part": board_part or None,
        "top_module": top_module or None,
        "manifest": manifest_data,
        "flow": flow or None,
    }
