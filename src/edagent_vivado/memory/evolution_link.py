"""Phase D — link evolution wins / approved overlays to L1 config atoms."""

from __future__ import annotations

import json
import logging
from typing import Any

from edagent_vivado.evolution.candidates import candidate_get
from edagent_vivado.evolution.overlays import overlay_get
from edagent_vivado.evolution.trials import trial_get
from edagent_vivado.repository.store import atom_create, atom_list

logger = logging.getLogger(__name__)


def _compact(text: str, max_len: int = 280) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= max_len else text[: max_len - 1].rstrip() + "…"


def _summarize_overlay_payload(surface: str, payload: dict[str, Any]) -> str:
    if not payload:
        return f"{surface}: (empty payload)"

    if surface == "prompt":
        mode = str(payload.get("mode") or "append")
        text = _compact(str(payload.get("text") or ""), 200)
        return f"prompt [{mode}]: {text or '(no text)'}"

    if surface == "routing":
        weights = payload.get("weights") or {}
        rules = payload.get("rules") or []
        w = ", ".join(f"{k}={v}" for k, v in list(weights.items())[:6])
        return _compact(f"routing weights: {w or 'default'}; rules={len(rules)}")

    if surface == "flow_template":
        templates = payload.get("templates") or {}
        keys = ", ".join(sorted(str(k) for k in templates.keys())[:8])
        return f"flow_template keys: {keys or '(none)'}"

    if surface == "tool":
        disabled = payload.get("disabled") or []
        extra = payload.get("additional_tools") or []
        names = [str(e.get("name") or "") for e in extra if isinstance(e, dict)]
        return _compact(
            f"tool disabled={list(disabled)[:6]}; added={names[:6]}"
        )

    if surface == "kb":
        pattern = payload.get("pattern") or payload.get("kb_case_id") or ""
        return _compact(f"kb overlay: {pattern}")

    return _compact(json.dumps(payload, ensure_ascii=False)[:400])


def _find_config_atom_by_overlay(project_id: str, overlay_id: str) -> dict | None:
    for row in atom_list(project_id, atom_type="config", limit=200):
        raw = row.get("metadata_json") or row.get("metadata") or "{}"
        try:
            meta = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except json.JSONDecodeError:
            meta = {}
        if meta.get("overlay_id") == overlay_id:
            return row
    return None


def record_overlay_config_atom(
    *,
    project_id: str,
    surface: str,
    overlay_id: str,
    source_session_id: str = "",
    decision: str = "approved",
    trial_id: str = "",
    candidate_id: str = "",
) -> dict | None:
    """Persist a winning / approved overlay as an L1 config atom."""
    if not project_id or not overlay_id:
        return None

    existing = _find_config_atom_by_overlay(project_id, overlay_id)
    if existing:
        return existing

    overlay = overlay_get(overlay_id)
    if not overlay:
        logger.debug("overlay %s not found for config atom", overlay_id)
        return None

    payload = overlay.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {"raw": payload}
    if not isinstance(payload, dict):
        payload = {}

    summary = _summarize_overlay_payload(surface, payload)
    predicate = "winning_config" if decision == "variant_wins" else "active_config"

    atom = atom_create(
        scope="project",
        project_id=project_id,
        atom_type="config",
        subject=surface,
        predicate=predicate,
        object=summary,
        confidence=0.92 if decision == "variant_wins" else 0.85,
        source_session_id=source_session_id,
        metadata={
            "overlay_id": overlay_id,
            "trial_id": trial_id,
            "candidate_id": candidate_id,
            "decision": decision,
            "surface": surface,
        },
    )

    try:
        from edagent_vivado.memory.personas import mark_project_persona_dirty

        mark_project_persona_dirty(project_id)
    except Exception:  # pragma: no cover
        logger.debug("persona dirty mark after config atom failed", exc_info=True)

    return atom


def record_trial_outcome(trial_id: str, decision: str) -> dict | None:
    """Write a config atom when a trial completes with variant_wins."""
    if decision != "variant_wins":
        return None

    trial = trial_get(trial_id)
    if not trial:
        return None

    project_id = str(trial.get("project_id") or "")
    surface = str(trial.get("surface") or "")
    variant_id = str(trial.get("variant_overlay_id") or "")
    if not project_id or not surface or not variant_id:
        return None

    cand = candidate_get(str(trial.get("candidate_id") or "")) or {}
    session_id = str(cand.get("session_id") or "")

    return record_overlay_config_atom(
        project_id=project_id,
        surface=surface,
        overlay_id=variant_id,
        source_session_id=session_id,
        decision="variant_wins",
        trial_id=trial_id,
        candidate_id=str(trial.get("candidate_id") or ""),
    )


def record_direct_approval(
    *,
    candidate_id: str,
    overlay_id: str,
    project_id: str,
    surface: str,
    source_session_id: str = "",
) -> dict | None:
    """Write a config atom when a candidate is approved without A/B trial."""
    return record_overlay_config_atom(
        project_id=project_id,
        surface=surface,
        overlay_id=overlay_id,
        source_session_id=source_session_id,
        decision="approved",
        candidate_id=candidate_id,
    )
