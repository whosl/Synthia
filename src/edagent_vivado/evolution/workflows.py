"""Candidate review workflows (SPEC §22.8 + §22.9).

Each function takes a candidate id (or overlay id for retire) and performs the
state transition + side effect:

- ``approve``  → ``overlays`` row created (state=active), candidate.status=approved
- ``reject``   → candidate.status=rejected; optional suppress_days blocks the
                  same signal_key from re-firing for the given window
- ``merge``    → promote scope (session→project, project→global candidate)
- ``rollback`` → retire the applied overlay; re-activate parent_overlay_id when
                  set so the previous behavior comes back
- ``retire``   → manual overlay retirement (no candidate involved)

All functions return the updated candidate (or overlay) dict and emit the
matching ``evolution.*`` event when an ``event_sink`` is provided.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable

from edagent_vivado.evolution.candidates import (
    candidate_get,
    candidate_update_status,
    candidate_create,
)
from edagent_vivado.evolution.overlays import (
    SURFACE_FLOW_TEMPLATE,
    SURFACE_KB,
    SURFACE_PROMPT,
    SURFACE_ROUTING,
    SURFACE_TOOL,
    overlay_activate,
    overlay_create,
    overlay_get,
    overlay_retire,
    overlay_retire_active_for,
)
from edagent_vivado.repository.db import get_db

logger = logging.getLogger(__name__)

EventSink = Callable[..., Any]


# ── default payload synthesis per surface ─────────────────────


def _default_payload_prompt(candidate: dict) -> dict:
    """Build a per-project prompt overlay body from the candidate's signal."""
    signal = _signal(candidate)
    signal_name = str(signal.get("signal") or "")
    if signal_name == "repeated_failure":
        rate = signal.get("first_run_success", 0.0)
        text = (
            f"This project currently shows first-run success of {float(rate):.0%}. "
            "Be cautious about synthesis errors: run `parse_vivado_log_tool` and "
            "`match_error_cases_tool` before proposing fixes, and prefer minimal patches."
        )
    elif signal_name == "negative_feedback":
        text = (
            "Recent user feedback was negative. Pause and ask clarifying questions "
            "before requesting tool approvals. Surface evidence (message IDs, log "
            "excerpts, WNS) in every diagnosis section."
        )
    elif signal_name == "approval_drop":
        text = (
            "Users have been rejecting recent approval requests. Make every "
            "`approval_request` minimal: cite specific evidence, propose only one "
            "concrete action at a time, and never bundle unrelated file changes."
        )
    else:
        text = candidate.get("rationale") or candidate.get("title") or ""
    return {"mode": "append", "text": text.strip()}


def _default_payload_flow_template(candidate: dict) -> dict:
    """Default flow template body — empty until SE-PR7 wires a real generator."""
    return {"templates": {}}


def _default_payload_routing(candidate: dict) -> dict:
    """Default routing payload — empty rules / weights until SE-PR7."""
    return {"weights": {}, "rules": []}


def _default_payload_tool(candidate: dict) -> dict:
    """Tool surface stays Level 0 — empty payload until SE-PR8."""
    return {"disabled": [], "additional_tool_ids": []}


def _signal(candidate: dict) -> dict:
    raw = candidate.get("signal_source_json")
    if isinstance(raw, str) and raw.strip():
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}
    if isinstance(raw, dict):
        return dict(raw)
    return {}


DEFAULT_PAYLOAD_BUILDERS = {
    SURFACE_PROMPT: _default_payload_prompt,
    SURFACE_FLOW_TEMPLATE: _default_payload_flow_template,
    SURFACE_ROUTING: _default_payload_routing,
    SURFACE_TOOL: _default_payload_tool,
}


# ── KB surface bridge ─────────────────────────────────────────


def _apply_kb_candidate(candidate: dict) -> dict:
    """KB-surface candidates land in the existing ``kb_cases`` table.

    Per SPEC §22.2 the KB surface reuses the existing approved-KB workflow.
    The overlay row still gets created so we can track which evolution
    candidate produced which kb_case (for rollback / audit).
    """
    from edagent_vivado.repository.store import kb_case_create

    signal = _signal(candidate)
    pattern = (
        str(signal.get("normalized_signature") or "").strip()
        or str(signal.get("sample_message") or "").strip()[:120]
        or candidate.get("title") or "(unspecified)"
    )
    likely = list(signal.get("likely_causes") or [])
    if not likely:
        msg = signal.get("sample_message")
        if isinstance(msg, str) and msg.strip():
            likely.append(f"Detected from recurring problem: {msg.strip()[:200]}")
    actions = list(signal.get("suggested_actions") or [])
    if not actions:
        actions = ["Investigate using parse_vivado_log_tool and match_error_cases_tool"]
    category = str(signal.get("sample_category") or "vivado")

    case = kb_case_create(
        pattern=pattern,
        likely_causes=likely,
        suggested_actions=actions,
        category=category,
        normalized_signature=pattern,
        source_candidate_id=candidate["id"],
        metadata={
            "origin": "evolution_candidate",
            "evolution_candidate_id": candidate["id"],
            "signal": signal,
        },
    )
    return case


# ── shared helpers ────────────────────────────────────────────


def _emit(sink: EventSink | None, *, session_id: str, event_type: str, payload: dict, task_id: str = "") -> None:
    if sink is None or not session_id:
        return
    try:
        sink(session_id, event_type, payload, task_id=task_id)
    except Exception as exc:  # pragma: no cover
        logger.debug("event emit failed (%s): %s", event_type, exc)


def _candidate_session_id(candidate: dict) -> str:
    sid = candidate.get("session_id") or ""
    if sid:
        return str(sid)
    return ""


# ── approve ───────────────────────────────────────────────────


def approve_candidate(
    candidate_id: str,
    *,
    reviewed_by: str = "user",
    payload_override: dict | None = None,
    event_sink: EventSink | None = None,
) -> dict:
    """Apply a candidate: retire any conflicting active overlay, create the new
    overlay (state=active), and flip the candidate to ``approved``.

    Returns the updated candidate dict (with ``applied_overlay_id`` populated).
    """
    cand = candidate_get(candidate_id)
    if not cand:
        raise LookupError(f"candidate {candidate_id} not found")
    if cand["status"] not in ("pending", "trialing"):
        raise ValueError(f"candidate is in status {cand['status']!r}; only pending/trialing may be approved")

    surface = cand["surface"]
    scope = cand.get("scope") or "project"
    if scope == "session":
        # Session-scope candidates do not become overlays directly; they must be
        # merged first (see merge_candidate).
        raise ValueError("session-scope candidate cannot be approved directly; merge to project first")

    project_id = cand.get("project_id") if scope == "project" else None

    # KB surface: bridge to the legacy kb_cases workflow + still write an overlay row.
    kb_case_id: str | None = None
    if surface == SURFACE_KB:
        kb_case = _apply_kb_candidate(cand)
        kb_case_id = kb_case["id"]

    # Compute the overlay payload (caller override > default builder > kb-only marker).
    if payload_override is not None:
        payload = dict(payload_override)
    elif surface == SURFACE_KB:
        payload = {
            "kb_case_id": kb_case_id,
            "pattern": _signal(cand).get("normalized_signature"),
        }
    else:
        builder = DEFAULT_PAYLOAD_BUILDERS.get(surface)
        if builder is None:
            raise ValueError(f"no default payload builder for surface {surface!r}")
        payload = builder(cand)

    # Retire the previously active overlay (if any) so the resolver picks up the new one.
    parent = overlay_retire_active_for(surface=surface, project_id=project_id, scope=scope)

    overlay = overlay_create(
        surface=surface,
        payload=payload,
        scope=scope,
        project_id=project_id,
        source_candidate_id=cand["id"],
        parent_overlay_id=(parent or {}).get("id"),
        metadata={
            "applied_by": reviewed_by,
            "candidate_title": cand.get("title"),
            "candidate_created_by": cand.get("created_by"),
            **({"kb_case_id": kb_case_id} if kb_case_id else {}),
        },
    )

    updated = candidate_update_status(
        cand["id"],
        "approved",
        reviewed_by=reviewed_by,
        applied_overlay_id=overlay["id"],
    )

    sid = _candidate_session_id(cand)
    payload_event = {
        "candidate_id": cand["id"],
        "overlay_id": overlay["id"],
        "surface": surface,
        "scope": scope,
        "project_id": project_id,
        "parent_overlay_id": (parent or {}).get("id"),
        "kb_case_id": kb_case_id,
        "reviewed_by": reviewed_by,
    }
    _emit(event_sink, session_id=sid, event_type="evolution.candidate.approved", payload=payload_event)
    _emit(event_sink, session_id=sid, event_type="evolution.overlay.applied", payload={
        "overlay_id": overlay["id"],
        "surface": surface,
        "scope": scope,
        "project_id": project_id,
        "source_candidate_id": cand["id"],
    })
    return updated


# ── reject (with optional suppression) ────────────────────────


def reject_candidate(
    candidate_id: str,
    *,
    reviewed_by: str = "user",
    suppress_days: int = 0,
    reason: str | None = None,
    event_sink: EventSink | None = None,
) -> dict:
    """Mark a candidate rejected; optionally suppress re-firing for N days.

    Suppression metadata lives on the rejected row itself so the generator
    dedup can find it (see ``generators._existing_blocking_candidate``).
    """
    cand = candidate_get(candidate_id)
    if not cand:
        raise LookupError(f"candidate {candidate_id} not found")
    if cand["status"] not in ("pending", "trialing"):
        raise ValueError(f"candidate is in status {cand['status']!r}; only pending/trialing may be rejected")

    suppressed_until = 0
    if suppress_days > 0:
        suppressed_until = int(time.time()) + int(suppress_days) * 86_400

    db = get_db()
    if suppressed_until or reason:
        try:
            meta = json.loads(cand.get("metadata_json") or "{}") or {}
        except json.JSONDecodeError:
            meta = {}
        if suppressed_until:
            meta["suppressed_until"] = suppressed_until
        if reason:
            meta["reject_reason"] = reason
        db.execute(
            "UPDATE evolution_candidates SET metadata_json=? WHERE id=?",
            (json.dumps(meta), cand["id"]),
        )
        db.commit()

    updated = candidate_update_status(cand["id"], "rejected", reviewed_by=reviewed_by)
    sid = _candidate_session_id(cand)
    _emit(event_sink, session_id=sid, event_type="evolution.candidate.rejected", payload={
        "candidate_id": cand["id"],
        "surface": cand.get("surface"),
        "scope": cand.get("scope"),
        "project_id": cand.get("project_id"),
        "suppressed_until": suppressed_until or None,
        "reason": reason,
        "reviewed_by": reviewed_by,
    })
    return updated


# ── merge (scope promotion) ───────────────────────────────────


def merge_candidate(
    candidate_id: str,
    *,
    reviewed_by: str = "user",
    event_sink: EventSink | None = None,
) -> dict:
    """Promote a candidate's scope (session→project, project→global).

    The original candidate is marked ``merged`` and a fresh ``pending``
    candidate at the next scope is created so the upgrade itself still
    requires explicit review.
    """
    cand = candidate_get(candidate_id)
    if not cand:
        raise LookupError(f"candidate {candidate_id} not found")
    if cand["status"] not in ("pending", "approved"):
        raise ValueError(f"candidate is in status {cand['status']!r}; cannot merge")

    scope = cand.get("scope") or "project"
    if scope == "session":
        next_scope = "project"
    elif scope == "project":
        next_scope = "global"
    else:
        raise ValueError("global-scope candidate cannot be merged further")

    signal = _signal(cand)
    signal_key = str(signal.get("signal_key") or f"merged:{cand['id']}")
    promoted_signal = {
        **signal,
        "signal_key": f"{signal_key}::{next_scope}",
        "promoted_from": cand["id"],
    }

    promoted = candidate_create(
        surface=cand["surface"],
        title=cand["title"],
        rationale=(cand.get("rationale") or "") + f"\n\nPromoted from {scope} → {next_scope}.",
        signal_source=promoted_signal,
        scope=next_scope,
        project_id=cand.get("project_id") if next_scope == "project" else None,
        session_id=cand.get("session_id") if next_scope == "project" else None,
        confidence=cand.get("confidence"),
        created_by=f"merge::{cand.get('created_by') or 'user'}",
        candidate_type=cand.get("candidate_type") or "overlay",
        metadata={
            "promoted_from": cand["id"],
            "promoted_at": int(time.time()),
        },
    )

    updated = candidate_update_status(cand["id"], "merged", reviewed_by=reviewed_by)
    sid = _candidate_session_id(cand)
    _emit(event_sink, session_id=sid, event_type="evolution.candidate.merged", payload={
        "candidate_id": cand["id"],
        "promoted_candidate_id": promoted["id"],
        "from_scope": scope,
        "to_scope": next_scope,
        "reviewed_by": reviewed_by,
    })
    return updated


# ── rollback ──────────────────────────────────────────────────


def rollback_candidate(
    candidate_id: str,
    *,
    reviewed_by: str = "user",
    reason: str | None = None,
    event_sink: EventSink | None = None,
) -> dict:
    """Retire an applied overlay and restore the previous one (if any).

    The candidate moves to ``rolled_back``. SPEC §22.8 guarantees that the
    baseline_artifact_id was snapshotted; here we use parent_overlay_id
    instead and re-activate the parent overlay row.
    """
    cand = candidate_get(candidate_id)
    if not cand:
        raise LookupError(f"candidate {candidate_id} not found")
    if cand["status"] != "approved":
        raise ValueError(f"candidate is in status {cand['status']!r}; only approved may be rolled back")

    overlay_id = cand.get("applied_overlay_id")
    overlay = overlay_get(overlay_id) if overlay_id else None
    restored_overlay_id: str | None = None
    if overlay and overlay.get("state") == "active":
        overlay_retire(overlay_id)
        parent_id = overlay.get("parent_overlay_id")
        if parent_id:
            parent = overlay_get(parent_id)
            if parent and parent.get("state") == "retired":
                overlay_activate(parent_id)
                restored_overlay_id = parent_id

    updated = candidate_update_status(cand["id"], "rolled_back", reviewed_by=reviewed_by)
    if reason:
        try:
            meta = json.loads(updated.get("metadata_json") or "{}") if updated else {}
        except json.JSONDecodeError:
            meta = {}
        meta["rollback_reason"] = reason
        db = get_db()
        db.execute(
            "UPDATE evolution_candidates SET metadata_json=? WHERE id=?",
            (json.dumps(meta), cand["id"]),
        )
        db.commit()
        updated = candidate_get(cand["id"])

    sid = _candidate_session_id(cand)
    payload_event = {
        "candidate_id": cand["id"],
        "overlay_id": overlay_id,
        "restored_overlay_id": restored_overlay_id,
        "surface": cand.get("surface"),
        "scope": cand.get("scope"),
        "project_id": cand.get("project_id"),
        "reason": reason,
        "reviewed_by": reviewed_by,
    }
    _emit(event_sink, session_id=sid, event_type="evolution.candidate.rolled_back", payload=payload_event)
    if overlay_id:
        _emit(event_sink, session_id=sid, event_type="evolution.overlay.retired", payload={
            "overlay_id": overlay_id,
            "surface": cand.get("surface"),
            "scope": cand.get("scope"),
            "project_id": cand.get("project_id"),
            "restored_overlay_id": restored_overlay_id,
        })
    return updated


# ── manual overlay retire ─────────────────────────────────────


def retire_overlay(
    overlay_id: str,
    *,
    reviewed_by: str = "user",
    event_sink: EventSink | None = None,
) -> dict:
    """Manual overlay retirement without touching the source candidate."""
    overlay = overlay_get(overlay_id)
    if not overlay:
        raise LookupError(f"overlay {overlay_id} not found")
    if overlay.get("state") == "retired":
        return overlay
    out = overlay_retire(overlay_id)
    # find a session id for the event sink (best-effort)
    cand_id = overlay.get("source_candidate_id")
    sid = ""
    if cand_id:
        cand = candidate_get(cand_id)
        if cand:
            sid = _candidate_session_id(cand)
    _emit(event_sink, session_id=sid, event_type="evolution.overlay.retired", payload={
        "overlay_id": overlay_id,
        "surface": overlay.get("surface"),
        "scope": overlay.get("scope"),
        "project_id": overlay.get("project_id"),
        "reviewed_by": reviewed_by,
        "manual": True,
    })
    return out or overlay
