"""Project snapshot helpers for sessions and context building."""

from __future__ import annotations

import json
from typing import Any


def parse_snapshot(session_or_json: dict | str | None) -> dict[str, Any]:
    if not session_or_json:
        return {}
    if isinstance(session_or_json, dict):
        raw = session_or_json.get("project_snapshot_json")
        if raw is None and any(k in session_or_json for k in ("manifest_path", "root_path", "project_id")):
            return dict(session_or_json)
        if raw is None:
            return {}
        if isinstance(raw, dict):
            return dict(raw)
        session_or_json = raw
    if isinstance(session_or_json, str):
        if not session_or_json.strip():
            return {}
        try:
            data = json.loads(session_or_json)
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def snapshot_manifest_path(session: dict | None, request_manifest: str = "") -> str:
    if request_manifest.strip():
        return request_manifest.strip()
    if not session:
        return ""
    snap = parse_snapshot(session)
    return str(snap.get("manifest_path") or "").strip()


def snapshot_context_lines(snapshot: dict[str, Any]) -> str:
    if not snapshot:
        return ""
    lines = []
    if snapshot.get("legacy_migration"):
        lines.append("(Legacy migrated session — paths may be approximate.)")
    if snapshot.get("name"):
        lines.append(f"Project name: {snapshot['name']}")
    if snapshot.get("project_id"):
        lines.append(f"Project id: {snapshot['project_id']}")
    for key, label in (
        ("root_path", "Root"),
        ("manifest_path", "Manifest"),
        ("xpr_path", "Vivado .xpr"),
        ("part", "Part"),
        ("board_part", "Board part"),
        ("top_module", "Top module"),
        ("default_vivado_target_id", "Vivado target"),
    ):
        val = snapshot.get(key)
        if val:
            lines.append(f"{label}: {val}")
    return "\n".join(lines)
