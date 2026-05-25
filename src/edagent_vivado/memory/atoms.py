"""L1 memory atoms — extract atomic facts from sessions."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from edagent_vivado.repository.store import (
    atom_create,
    atom_find_duplicate,
    atom_find_similar,
    atom_list,
    message_list,
    session_get,
    toolcall_list,
)


@dataclass
class MemoryAtomDraft:
    atom_type: str
    subject: str
    object: str
    predicate: str = ""
    confidence: float = 0.7
    source_message_id: str = ""
    source_run_id: str = ""
    evidence_artifact_id: str = ""
    metadata: dict | None = None


_PREFERENCE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?:永远|always)\s*(?:不要|不|never)?\s*(.+)", re.I), "prefers_not"),
    (re.compile(r"(?:不要|never|别)\s*(.+)", re.I), "prefers_not"),
    (re.compile(r"(?:偏好|prefer|喜欢)\s*(.+)", re.I), "prefers"),
    (re.compile(r"(?:默认|default)\s*(?:用|使用|use)?\s*(.+)", re.I), "defaults_to"),
]

_VIVADO_TOOL_RE = re.compile(r"run_vivado_", re.I)
_ERROR_FILE_RE = re.compile(r"file not found|no such file", re.I)
_CLOCK_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(mhz|ghz|khz)", re.I)


def _compact(text: str, max_len: int = 240) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    return text if len(text) <= max_len else text[: max_len - 1].rstrip() + "…"


def _extract_preference_atoms(msg: dict) -> list[MemoryAtomDraft]:
    content = msg.get("content") or ""
    if not content.strip():
        return []
    drafts: list[MemoryAtomDraft] = []
    for pattern, predicate in _PREFERENCE_PATTERNS:
        m = pattern.search(content)
        if not m:
            continue
        obj = _compact(m.group(1), 120)
        if len(obj) < 3:
            continue
        drafts.append(
            MemoryAtomDraft(
                atom_type="preference",
                subject="user",
                predicate=predicate,
                object=obj,
                confidence=0.75,
                source_message_id=str(msg.get("id") or ""),
            )
        )
        break
    return drafts


def _extract_tool_atoms(tc: dict) -> list[MemoryAtomDraft]:
    name = str(tc.get("tool_name") or "")
    state = str(tc.get("state") or "")
    summary = str(tc.get("output_summary") or tc.get("input_summary") or "")
    evidence_id = str(tc.get("output_artifact_id") or "")
    if not name:
        return []

    drafts: list[MemoryAtomDraft] = []
    tool_subject = name.replace("_tool", "")

    if _VIVADO_TOOL_RE.search(name):
        if state in ("completed",):
            drafts.append(
                MemoryAtomDraft(
                    atom_type="event",
                    subject=tool_subject,
                    predicate="completed",
                    object=_compact(summary or "success", 160),
                    confidence=0.82,
                    source_run_id=str(tc.get("run_id") or ""),
                    evidence_artifact_id=evidence_id,
                    metadata={"tool_state": state, "toolcall_id": tc.get("id")},
                )
            )
        elif state in ("error", "rejected", "stopped"):
            obj = _compact(summary or state, 200)
            drafts.append(
                MemoryAtomDraft(
                    atom_type="event",
                    subject=tool_subject,
                    predicate="failed",
                    object=obj,
                    confidence=0.85,
                    source_run_id=str(tc.get("run_id") or ""),
                    evidence_artifact_id=evidence_id,
                    metadata={"tool_state": state, "toolcall_id": tc.get("id")},
                )
            )
            if _ERROR_FILE_RE.search(summary):
                drafts.append(
                    MemoryAtomDraft(
                        atom_type="fact",
                        subject="rtl_sync",
                        predicate="issue",
                        object="RTL file path missing or not synced to remote workspace",
                        confidence=0.88,
                        source_run_id=str(tc.get("run_id") or ""),
                    )
                )

    clock = _CLOCK_RE.search(summary)
    if clock:
        drafts.append(
            MemoryAtomDraft(
                atom_type="fact",
                subject="clock",
                predicate="frequency",
                object=f"{clock.group(1)} {clock.group(2).upper()}",
                confidence=0.8,
                source_run_id=str(tc.get("run_id") or ""),
            )
        )

    return drafts


def _extract_snapshot_atoms(session_id: str, project_id: str) -> list[MemoryAtomDraft]:
    sess = session_get(session_id) or {}
    raw = sess.get("project_snapshot_json") or ""
    if not raw:
        return []
    try:
        snap = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return []
    if not isinstance(snap, dict):
        return []

    drafts: list[MemoryAtomDraft] = []
    mapping = [
        ("part", "project", "uses_part", snap.get("part") or snap.get("fpga_part")),
        ("top_module", "project", "top_module", snap.get("top_module") or snap.get("top")),
        ("board_part", "project", "board_part", snap.get("board_part")),
    ]
    for subject, _stype, predicate, value in mapping:
        if value:
            drafts.append(
                MemoryAtomDraft(
                    atom_type="fact",
                    subject=subject,
                    predicate=predicate,
                    object=str(value),
                    confidence=0.9,
                    metadata={"source": "project_snapshot"},
                )
            )
    if snap.get("name"):
        drafts.append(
            MemoryAtomDraft(
                atom_type="fact",
                subject="project",
                predicate="name",
                object=str(snap["name"]),
                confidence=0.85,
                metadata={"source": "project_snapshot", "project_id": project_id},
            )
        )
    return drafts


def extract_atoms_from_session(
    session_id: str,
    project_id: str,
    *,
    since_created_at: int | None = None,
    max_atoms: int = 20,
) -> list[dict]:
    """Extract and persist L1 atoms from recent messages and tool calls."""
    if not session_id:
        return []

    msgs = message_list(session_id, limit=40)
    if since_created_at is not None:
        msgs = [m for m in msgs if int(m.get("created_at") or 0) > since_created_at]

    drafts: list[MemoryAtomDraft] = []
    drafts.extend(_extract_snapshot_atoms(session_id, project_id))

    for msg in msgs:
        if msg.get("role") == "user":
            drafts.extend(_extract_preference_atoms(msg))

    tcs = toolcall_list(session_id=session_id, limit=24)
    if since_created_at is not None:
        tcs = [t for t in tcs if int(t.get("finished_at") or t.get("started_at") or 0) > since_created_at]
    for tc in tcs:
        drafts.extend(_extract_tool_atoms(tc))

    created: list[dict] = []
    seen: set[tuple[str, str, str, str]] = set()
    for draft in drafts:
        if len(created) >= max_atoms:
            break
        key = ("project", project_id or "", draft.subject, draft.predicate or "", draft.object)
        if key in seen:
            continue
        seen.add(key)

        if project_id:
            dup = atom_find_duplicate(project_id, draft.subject, draft.predicate, draft.object)
            if dup:
                continue
            if draft.atom_type == "event":
                similar = atom_find_similar(
                    project_id,
                    draft.atom_type,
                    draft.subject,
                    draft.predicate,
                    draft.object,
                )
                if similar:
                    continue

        row = atom_create(
            scope="project" if project_id else "global",
            project_id=project_id,
            atom_type=draft.atom_type,
            subject=draft.subject,
            predicate=draft.predicate,
            object=draft.object,
            confidence=draft.confidence,
            source_session_id=session_id,
            source_message_id=draft.source_message_id,
            source_run_id=draft.source_run_id,
            evidence_artifact_id=draft.evidence_artifact_id,
            metadata=draft.metadata,
        )
        created.append(row)
    return created


def list_atoms_for_project(
    project_id: str,
    *,
    atom_type: str = "",
    limit: int = 50,
) -> list[dict]:
    return atom_list(project_id, atom_type=atom_type, limit=limit)
