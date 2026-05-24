"""A/B trial engine (SPEC §22 SE-PR5).

When ``trial.<surface>`` is enabled for a project, approving a candidate
does **not** flip the resolver to the new payload directly. Instead:

1. The candidate becomes ``trialing``.
2. A ``shadow`` overlay is created with the would-be payload; the
   currently-active overlay (if any) keeps state=active and acts as the
   baseline. Per SPEC §22.2 the ``tool`` surface refuses trials.
3. Each subsequent task in the project is randomly assigned to
   ``baseline`` or ``variant`` (~50/50, deterministic per task) via
   :mod:`task_arms`. The SE-PR2 collector tags the resulting
   ``metric_snapshots`` row with ``trial_id`` and ``arm``.
4. Once both arms have ≥ ``MIN_SAMPLES`` snapshots, :func:`maybe_decide_trial`
   compares the mean ``composite_score`` and picks a decision:
       variant_wins   → promote the shadow overlay (state shadow → active),
                        retire the baseline, candidate → approved.
       baseline_wins  → retire the shadow overlay, candidate → rejected.
       tie            → retire the shadow overlay, candidate → rejected
                        (with reason "ab_tie").
5. ``abort_trial`` lets the operator stop a trial mid-flight; ``force_decision``
   short-circuits the sample requirement.

The engine never blocks the agent loop; every call is wrapped in
try/except by the task-done hook.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from typing import Any, Callable

from edagent_vivado.evolution.candidates import candidate_get, candidate_update_status
from edagent_vivado.evolution.overlays import (
    SURFACE_TOOL,
    SURFACES,
    overlay_create,
    overlay_retire,
)
from edagent_vivado.repository.db import get_db

logger = logging.getLogger(__name__)

EventSink = Callable[..., Any]

# Knobs (kept in code, not SPEC, so we can tune without spec churn).
MIN_SAMPLES_PER_ARM = 10
DECISION_MARGIN = 0.05   # variant must beat baseline by 5% composite_score to win
MAX_TRIAL_AGE_SEC = 14 * 86_400  # auto-abort after 14 days

# Forbid trials on the tool surface per SPEC §22.2 ("Level 0 only").
TRIAL_FORBIDDEN_SURFACES = {SURFACE_TOOL}


# ── helpers ───────────────────────────────────────────────


def _uid() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> int:
    return int(time.time())


def _decode(row) -> dict:
    out = dict(row)
    for col in ("metric_baseline_json", "metric_variant_json", "metadata_json"):
        raw = out.get(col)
        if isinstance(raw, str) and raw:
            try:
                out[col.replace("_json", "")] = json.loads(raw)
            except json.JSONDecodeError:
                out[col.replace("_json", "")] = {}
    return out


def trial_get(tid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM evolution_trials WHERE id=?", (tid,)).fetchone()
    return _decode(row) if row else None


def trial_list(
    *,
    project_id: str | None = None,
    state: str | None = None,
    surface: str | None = None,
    limit: int = 200,
) -> list[dict]:
    q = "SELECT * FROM evolution_trials WHERE 1=1"
    params: list[Any] = []
    if project_id:
        q += " AND project_id=?"
        params.append(project_id)
    if state:
        q += " AND state=?"
        params.append(state)
    if surface:
        q += " AND surface=?"
        params.append(surface)
    q += " ORDER BY started_at DESC LIMIT ?"
    params.append(limit)
    rows = get_db().execute(q, params).fetchall()
    return [_decode(r) for r in rows]


def active_trial_for(*, project_id: str, surface: str) -> dict | None:
    """Return the running trial for a (project, surface) pair, if any."""
    row = get_db().execute(
        """SELECT * FROM evolution_trials
             WHERE project_id=? AND surface=? AND state='running'
             ORDER BY started_at DESC LIMIT 1""",
        (project_id, surface),
    ).fetchone()
    return _decode(row) if row else None


# ── start ─────────────────────────────────────────────────


def start_trial(
    *,
    candidate_id: str,
    variant_payload: dict,
    project_id: str,
    surface: str,
    baseline_overlay_id: str | None = None,
    metadata: dict | None = None,
) -> dict:
    """Open a trial: create a shadow overlay, build the trial row.

    Caller (workflows.approve_candidate) is responsible for flipping the
    candidate status to ``trialing``. The active baseline overlay is **not**
    retired — it keeps serving tasks assigned to the baseline arm.
    """
    if surface in TRIAL_FORBIDDEN_SURFACES:
        raise ValueError(f"surface {surface!r} cannot enter A/B trials")
    if surface not in SURFACES:
        raise ValueError(f"unknown surface {surface!r}")

    shadow = overlay_create(
        surface=surface,
        payload=variant_payload,
        scope="project",
        project_id=project_id,
        state="shadow",
        source_candidate_id=candidate_id,
        metadata={"role": "trial_variant", **(metadata or {})},
    )

    tid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        """INSERT INTO evolution_trials(
            id, candidate_id, project_id, surface, baseline_overlay_id, variant_overlay_id,
            state, started_at, n_baseline, n_variant, metric_baseline_json, metric_variant_json,
            metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            tid, candidate_id, project_id, surface,
            baseline_overlay_id, shadow["id"],
            "running", now, 0, 0,
            json.dumps({"scores": [], "mean": None}),
            json.dumps({"scores": [], "mean": None}),
            json.dumps({"min_samples": MIN_SAMPLES_PER_ARM, "margin": DECISION_MARGIN, **(metadata or {})}),
        ),
    )
    db.commit()
    return trial_get(tid)  # type: ignore[return-value]


# ── arm assignment ────────────────────────────────────────


def _split_arm(task_id: str, trial_id: str) -> str:
    """Deterministic 50/50 split keyed by (task_id, trial_id)."""
    digest = hashlib.md5(f"{task_id}|{trial_id}".encode()).digest()
    return "variant" if digest[0] & 1 else "baseline"


def assign_arms_for_task(
    *,
    project_id: str | None,
    task_id: str,
) -> dict[str, tuple[str, str | None, str]]:
    """Pick arms for every running trial in this project."""
    if not project_id or not task_id:
        return {}
    rows = trial_list(project_id=project_id, state="running")
    out: dict[str, tuple[str, str | None, str]] = {}
    for trial in rows:
        surface = trial["surface"]
        arm = _split_arm(task_id, trial["id"])
        overlay_id = (
            trial.get("variant_overlay_id") if arm == "variant" else trial.get("baseline_overlay_id")
        )
        out[surface] = (arm, overlay_id, trial["id"])
    return out


# ── snapshot recording ────────────────────────────────────


def record_snapshot(trial_id: str, arm: str, composite_score: float | None) -> None:
    """Increment the per-arm counter + bucket the composite score."""
    if arm not in ("baseline", "variant") or composite_score is None:
        return
    try:
        score = float(composite_score)
    except (TypeError, ValueError):
        return
    trial = trial_get(trial_id)
    if not trial or trial.get("state") != "running":
        return
    col = "metric_baseline_json" if arm == "baseline" else "metric_variant_json"
    n_col = "n_baseline" if arm == "baseline" else "n_variant"
    try:
        bucket = json.loads(trial.get(col) or "{}")
    except json.JSONDecodeError:
        bucket = {}
    scores = list(bucket.get("scores") or [])
    scores.append(round(score, 4))
    bucket["scores"] = scores
    bucket["mean"] = round(sum(scores) / len(scores), 4)
    db = get_db()
    db.execute(
        f"UPDATE evolution_trials SET {col}=?, {n_col}={n_col}+1 WHERE id=?",
        (json.dumps(bucket), trial_id),
    )
    db.commit()


# ── decision ──────────────────────────────────────────────


def _apply_decision(
    trial_id: str,
    decision: str,
    *,
    reviewed_by: str = "trial_engine",
    event_sink: EventSink | None = None,
) -> dict | None:
    trial = trial_get(trial_id)
    if not trial:
        return None
    cand = candidate_get(trial.get("candidate_id") or "")
    sess_id = (cand or {}).get("session_id") or ""
    variant_id = trial.get("variant_overlay_id")
    baseline_id = trial.get("baseline_overlay_id")
    now = _now()

    if decision == "variant_wins":
        # Promote the variant to active. The previous baseline (if any) becomes
        # the parent so a future rollback still has somewhere to fall back to.
        if baseline_id:
            try:
                overlay_retire(baseline_id)
            except Exception:  # pragma: no cover
                logger.debug("baseline retire failed", exc_info=True)
        if variant_id:
            db = get_db()
            db.execute(
                "UPDATE overlays SET state='active', parent_overlay_id=? WHERE id=?",
                (baseline_id, variant_id),
            )
            db.commit()
        if cand:
            candidate_update_status(
                cand["id"],
                "approved",
                reviewed_by=reviewed_by,
                applied_overlay_id=variant_id,
            )
    elif decision in ("baseline_wins", "tie"):
        if variant_id:
            try:
                overlay_retire(variant_id)
            except Exception:  # pragma: no cover
                logger.debug("variant retire failed", exc_info=True)
        if cand:
            candidate_update_status(cand["id"], "rejected", reviewed_by=reviewed_by)
            # Record decision reason for the review UI to surface.
            try:
                meta = json.loads(cand.get("metadata_json") or "{}") or {}
            except json.JSONDecodeError:
                meta = {}
            meta["ab_decision"] = decision
            meta["trial_id"] = trial_id
            db = get_db()
            db.execute(
                "UPDATE evolution_candidates SET metadata_json=? WHERE id=?",
                (json.dumps(meta), cand["id"]),
            )
            db.commit()
    else:
        return None

    db = get_db()
    db.execute(
        """UPDATE evolution_trials
             SET state='completed', decision=?, decided_at=?, finished_at=?
             WHERE id=?""",
        (decision, now, now, trial_id),
    )
    db.commit()

    if event_sink is not None and sess_id:
        try:
            event_sink(
                sess_id,
                "evolution.trial.completed",
                {
                    "trial_id": trial_id,
                    "candidate_id": cand["id"] if cand else None,
                    "surface": trial.get("surface"),
                    "decision": decision,
                    "baseline_overlay_id": baseline_id,
                    "variant_overlay_id": variant_id,
                },
            )
        except Exception:  # pragma: no cover
            logger.debug("trial.completed event emit failed", exc_info=True)
    return trial_get(trial_id)


def maybe_decide_trial(
    trial_id: str,
    *,
    min_samples: int | None = None,
    margin: float | None = None,
    event_sink: EventSink | None = None,
) -> dict | None:
    """Decide a running trial when both arms have collected enough samples.

    Returns the updated trial dict on decision, None otherwise.
    """
    trial = trial_get(trial_id)
    if not trial or trial.get("state") != "running":
        return None
    min_n = min_samples if min_samples is not None else (
        (trial.get("metadata") or {}).get("min_samples") or MIN_SAMPLES_PER_ARM
    )
    margin_v = margin if margin is not None else (
        (trial.get("metadata") or {}).get("margin") or DECISION_MARGIN
    )

    # Auto-abort runaway trials so they don't accumulate forever.
    if MAX_TRIAL_AGE_SEC and (_now() - int(trial.get("started_at") or 0)) > MAX_TRIAL_AGE_SEC:
        return abort_trial(trial_id, reason="max_age_reached", event_sink=event_sink)

    n_baseline = int(trial.get("n_baseline") or 0)
    n_variant = int(trial.get("n_variant") or 0)
    if n_baseline < min_n or n_variant < min_n:
        return None

    try:
        baseline = json.loads(trial.get("metric_baseline_json") or "{}")
        variant = json.loads(trial.get("metric_variant_json") or "{}")
    except json.JSONDecodeError:
        return None
    baseline_mean = baseline.get("mean")
    variant_mean = variant.get("mean")
    if baseline_mean is None or variant_mean is None:
        return None
    delta = float(variant_mean) - float(baseline_mean)
    if delta >= float(margin_v):
        decision = "variant_wins"
    elif delta <= -float(margin_v):
        decision = "baseline_wins"
    else:
        decision = "tie"
    return _apply_decision(trial_id, decision, event_sink=event_sink)


# ── manual abort / force decision ─────────────────────────


def abort_trial(
    trial_id: str,
    *,
    reason: str = "manual_abort",
    event_sink: EventSink | None = None,
) -> dict | None:
    """Stop a running trial, retire the variant, and revert the candidate to pending."""
    trial = trial_get(trial_id)
    if not trial or trial.get("state") != "running":
        return trial
    variant_id = trial.get("variant_overlay_id")
    if variant_id:
        try:
            overlay_retire(variant_id)
        except Exception:  # pragma: no cover
            logger.debug("variant retire failed", exc_info=True)
    now = _now()
    db = get_db()
    db.execute(
        """UPDATE evolution_trials
             SET state='reverted', decision='aborted', finished_at=?, decided_at=?,
                 metadata_json=COALESCE(
                     json_patch(IFNULL(metadata_json, '{}'), json_object('abort_reason', ?)),
                     metadata_json
                 )
             WHERE id=?""",
        (now, now, reason, trial_id),
    )
    db.commit()

    cand_id = trial.get("candidate_id")
    if cand_id:
        # Revert the candidate to pending so the user can decide what to do next.
        db.execute(
            "UPDATE evolution_candidates SET status='pending', reviewed_by=NULL, reviewed_at=NULL, applied_overlay_id=NULL WHERE id=?",
            (cand_id,),
        )
        db.commit()

    if event_sink is not None:
        cand = candidate_get(cand_id) if cand_id else None
        sess_id = (cand or {}).get("session_id") or ""
        try:
            event_sink(
                sess_id or "",
                "evolution.trial.reverted",
                {
                    "trial_id": trial_id,
                    "candidate_id": cand_id,
                    "surface": trial.get("surface"),
                    "reason": reason,
                },
            )
        except Exception:  # pragma: no cover
            logger.debug("trial.reverted emit failed", exc_info=True)
    return trial_get(trial_id)


def force_decision(
    trial_id: str,
    decision: str,
    *,
    reviewed_by: str = "user",
    event_sink: EventSink | None = None,
) -> dict | None:
    """Operator override that decides a trial regardless of sample count."""
    if decision not in ("variant_wins", "baseline_wins", "tie"):
        raise ValueError(f"unknown decision {decision!r}")
    return _apply_decision(
        trial_id, decision, reviewed_by=reviewed_by, event_sink=event_sink,
    )
