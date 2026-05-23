"""Auto-generate KB candidates from detected problems — Phase 3."""

from __future__ import annotations

import json
from typing import Any

from edagent_vivado.repository.store import kb_candidate_create, kb_candidate_list


def _signature_exists(session_id: str, signature: str) -> bool:
    sig = (signature or "").strip()[:200]
    if not sig:
        return False
    for row in kb_candidate_list(status="pending", limit=200):
        if row.get("source_session_id") == session_id and (row.get("normalized_signature") or row.get("pattern")) == sig:
            return True
    return False


def maybe_create_kb_candidate(
    problem: dict[str, Any],
    *,
    created_by: str = "harness",
) -> dict | None:
    """Create pending KB candidate if not duplicate."""
    msg = str(problem.get("message") or "")[:500]
    sig = str(problem.get("signature") or problem.get("normalized_signature") or msg[:120])
    sid = str(problem.get("session_id") or "")
    if _signature_exists(sid, sig):
        return None

    likely = [f"Detected: {msg[:200]}"]
    actions = ["Review Vivado log and constraints", "Check related RTL and XDC files"]
    meta = problem.get("metadata_json")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except json.JSONDecodeError:
            meta = {}
    category = str(problem.get("category") or "unclassified")
    if category == "vivado_synth":
        actions.append("Re-run synthesis after fixing reported errors")

    return kb_candidate_create(
        pattern=sig,
        likely_causes=likely,
        suggested_actions=actions,
        source_run_id=str(problem.get("run_id") or ""),
        source_session_id=sid,
        source_problem_id=str(problem.get("id") or ""),
        category=category,
        normalized_signature=sig,
        confidence=0.6,
        created_by=created_by,
        metadata=meta if isinstance(meta, dict) else {},
    )
