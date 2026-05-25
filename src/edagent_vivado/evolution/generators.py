"""Evolution candidate generators (SPEC §22.6 + §22.8).

Each generator inspects one or more signals (problems / metric_snapshots /
feedback / interactions) and, when a threshold is crossed, writes a
``pending`` row into ``evolution_candidates``. Generators **never apply**
overlays; SE-PR4 will provide the review UI / approve / merge endpoints.

All generators share a few invariants:

- Each invocation is idempotent: if a pending candidate with the same
  ``signal_source.signal_key`` already exists for the project + surface,
  the generator returns the existing row instead of creating a duplicate.
- Generators are wrapped in ``try / except`` by the dispatcher; an
  individual generator failure must not block the others.
- Each emits ``evolution.signal.fired`` (informational) and
  ``evolution.candidate.created`` (when a new row is produced).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Iterable

from edagent_vivado.evolution.aggregator import latest_snapshot
from edagent_vivado.evolution.candidates import candidate_create
from edagent_vivado.evolution.feedback import feedback_thumb_rolling
from edagent_vivado.evolution.overlays import (
    SURFACE_FLOW_TEMPLATE,
    SURFACE_KB,
    SURFACE_PROMPT,
    SURFACE_ROUTING,
)
from edagent_vivado.repository.db import get_db

logger = logging.getLogger(__name__)

EventSink = Callable[..., Any]

# Thresholds (kept here, not in SPEC, so we can tune without spec churn).
RECURRENCE_MIN_SESSIONS = 3
RECURRENCE_LOOKBACK_DAYS = 30

REPEATED_FAILURE_MIN_SAMPLE = 5
REPEATED_FAILURE_THRESHOLD = 0.4  # first_run_success rate below this fires

NEGATIVE_FEEDBACK_LOOKBACK = 10
NEGATIVE_FEEDBACK_MIN_NEGATIVES = 3

APPROVAL_DROP_MIN_SAMPLE = 5
APPROVAL_DROP_THRESHOLD = 0.5

# SE-PR7: routing drift — keyword vs tool-actually-used mismatch.
ROUTING_LOOKBACK_TASKS = 20
ROUTING_MIN_MISMATCHES = 3
ROUTING_KEYWORDS: dict[str, list[str]] = {
    "timing": [
        "wns", "tns", "slack", "clock period", "setup violation",
        "hold violation", "max_delay", "min_delay", "false_path",
    ],
    "constraint": [
        "xdc", "pin assignment", "io_standard", "pblock", "loc ",
        "set_property pin", "create_clock", "set_input_delay",
        "set_output_delay",
    ],
    "synthesis": [
        "synth_design", "elaboration", "[synth ", "read_verilog",
        "read_vhdl", "module not found",
    ],
}
ROUTING_TOOL_TO_SPECIALIST: dict[str, str] = {
    "parse_timing_tool": "timing",
    "parse_utilization_tool": "constraint",
    "parse_vivado_log_tool": "synthesis",
    "match_error_cases_tool": "synthesis",
    "run_vivado_synth_tool": "synthesis",
    "run_vivado_impl_tool": "constraint",
    "run_vivado_flow_tool": "synthesis",
}

# SE-PR7: flow_template reuse — detect recurring Vivado scripts a project
# keeps issuing ad-hoc that ought to be codified as a reusable template.
FLOW_TEMPLATE_LOOKBACK_TASKS = 40
FLOW_TEMPLATE_MIN_OCCURRENCES = 3
FLOW_TEMPLATE_MIN_LINES = 3
FLOW_TEMPLATE_MAX_LINES = 200


# ── shared helpers ────────────────────────────────────────────


def _existing_pending_candidate(
    *,
    surface: str,
    project_id: str | None,
    signal_key: str,
) -> dict | None:
    """Return an open candidate that blocks re-generation, or None.

    A candidate blocks re-generation when:
      - status='pending' (waiting for user) OR status='trialing' (in A/B); OR
      - status='rejected' AND metadata_json.suppressed_until > now()

    Uses sqlite's ``json_extract`` so the dedup semantics live in SQL.
    """
    import time as _time

    db = get_db()
    now = int(_time.time())
    if project_id:
        row = db.execute(
            """SELECT * FROM evolution_candidates
                 WHERE surface=? AND project_id=?
                   AND json_extract(signal_source_json, '$.signal_key')=?
                   AND (
                         status IN ('pending', 'trialing')
                         OR (
                             status='rejected'
                             AND CAST(IFNULL(json_extract(metadata_json, '$.suppressed_until'), 0) AS INTEGER) > ?
                         )
                   )
                 ORDER BY created_at DESC LIMIT 1""",
            (surface, project_id, signal_key, now),
        ).fetchone()
    else:
        row = db.execute(
            """SELECT * FROM evolution_candidates
                 WHERE surface=?
                   AND (project_id IS NULL OR project_id='')
                   AND json_extract(signal_source_json, '$.signal_key')=?
                   AND (
                         status IN ('pending', 'trialing')
                         OR (
                             status='rejected'
                             AND CAST(IFNULL(json_extract(metadata_json, '$.suppressed_until'), 0) AS INTEGER) > ?
                         )
                   )
                 ORDER BY created_at DESC LIMIT 1""",
            (surface, signal_key, now),
        ).fetchone()
    return dict(row) if row else None


def _emit(
    event_sink: EventSink | None,
    *,
    session_id: str,
    event_type: str,
    payload: dict,
    task_id: str = "",
    run_id: str = "",
) -> None:
    if event_sink is None or not session_id:
        return
    try:
        event_sink(session_id, event_type, payload, task_id=task_id, run_id=run_id)
    except Exception as exc:  # pragma: no cover
        logger.debug("event emit failed (%s): %s", event_type, exc)


def _signal_fired(
    event_sink: EventSink | None,
    *,
    session_id: str,
    name: str,
    project_id: str | None,
    detail: dict,
    task_id: str = "",
) -> None:
    _emit(
        event_sink,
        session_id=session_id,
        event_type="evolution.signal.fired",
        payload={
            "signal": name,
            "project_id": project_id,
            "detail": detail,
        },
        task_id=task_id,
    )


def _candidate_created(
    event_sink: EventSink | None,
    *,
    session_id: str,
    candidate: dict,
    task_id: str = "",
) -> None:
    _emit(
        event_sink,
        session_id=session_id,
        event_type="evolution.candidate.created",
        payload={
            "candidate_id": candidate["id"],
            "surface": candidate.get("surface"),
            "title": candidate.get("title"),
            "scope": candidate.get("scope"),
            "project_id": candidate.get("project_id"),
            "created_by": candidate.get("created_by"),
        },
        task_id=task_id,
    )


# ── 1. recurrence (problems.normalized_signature) ─────────────


def _signature_recurrence_rows(
    project_id: str | None,
    *,
    min_sessions: int,
    lookback_days: int,
) -> list[dict]:
    """Find normalized_signature values that appear in >= min_sessions distinct sessions."""
    cutoff = 0
    if lookback_days:
        import time as _t

        cutoff = int(_t.time()) - lookback_days * 86_400
    db = get_db()
    if project_id:
        rows = db.execute(
            """SELECT normalized_signature AS sig,
                      COUNT(DISTINCT session_id) AS sessions_n,
                      COUNT(*) AS occurrences,
                      MAX(message) AS sample_message,
                      MAX(category) AS sample_category,
                      MAX(severity) AS sample_severity
                 FROM problems
                WHERE project_id=? AND normalized_signature IS NOT NULL
                  AND normalized_signature != '' AND detected_at >= ?
                GROUP BY normalized_signature
                HAVING sessions_n >= ?
                ORDER BY sessions_n DESC, occurrences DESC""",
            (project_id, cutoff, min_sessions),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT normalized_signature AS sig,
                      COUNT(DISTINCT session_id) AS sessions_n,
                      COUNT(*) AS occurrences,
                      MAX(message) AS sample_message,
                      MAX(category) AS sample_category,
                      MAX(severity) AS sample_severity
                 FROM problems
                WHERE normalized_signature IS NOT NULL
                  AND normalized_signature != '' AND detected_at >= ?
                GROUP BY normalized_signature
                HAVING sessions_n >= ?
                ORDER BY sessions_n DESC, occurrences DESC""",
            (cutoff, min_sessions),
        ).fetchall()
    return [dict(r) for r in rows]


def gen_recurrence(
    *,
    project_id: str | None,
    session_id: str = "",
    task_id: str = "",
    event_sink: EventSink | None = None,
) -> list[dict]:
    """Generate KB candidates for problem signatures recurring across sessions."""
    fired: list[dict] = []
    rows = _signature_recurrence_rows(
        project_id,
        min_sessions=RECURRENCE_MIN_SESSIONS,
        lookback_days=RECURRENCE_LOOKBACK_DAYS,
    )
    for row in rows:
        sig = row.get("sig") or ""
        if not sig:
            continue
        signal_key = f"recurrence:{sig[:120]}"
        existing = _existing_pending_candidate(
            surface=SURFACE_KB, project_id=project_id, signal_key=signal_key,
        )
        _signal_fired(
            event_sink,
            session_id=session_id,
            name="recurrence",
            project_id=project_id,
            detail={
                "signature": sig,
                "sessions_n": row.get("sessions_n"),
                "occurrences": row.get("occurrences"),
                "category": row.get("sample_category"),
                "severity": row.get("sample_severity"),
                "deduped": existing is not None,
            },
            task_id=task_id,
        )
        if existing:
            fired.append(existing)
            continue
        cand = candidate_create(
            surface=SURFACE_KB,
            scope="project" if project_id else "global",
            project_id=project_id,
            session_id=session_id or None,
            title=f"Recurring Vivado signature: {sig[:80]}",
            rationale=(
                f"Signature observed in {row.get('sessions_n')} sessions / "
                f"{row.get('occurrences')} occurrences over the last "
                f"{RECURRENCE_LOOKBACK_DAYS} days."
            ),
            signal_source={
                "signal": "recurrence",
                "signal_key": signal_key,
                "normalized_signature": sig,
                "sessions_n": row.get("sessions_n"),
                "occurrences": row.get("occurrences"),
                "sample_message": (row.get("sample_message") or "")[:500],
                "sample_category": row.get("sample_category"),
                "sample_severity": row.get("sample_severity"),
            },
            confidence=min(0.95, 0.4 + 0.1 * float(row.get("sessions_n") or 0)),
            created_by="recurrence_generator",
            candidate_type="kb_case",
            metadata={"generator_version": 1},
        )
        _candidate_created(event_sink, session_id=session_id, candidate=cand, task_id=task_id)
        fired.append(cand)
    return fired


# ── 2. repeated_failure (rolling first_run_success) ──────────


def gen_repeated_failure(
    *,
    project_id: str | None,
    session_id: str = "",
    task_id: str = "",
    event_sink: EventSink | None = None,
) -> list[dict]:
    """Fire when rolling_10 first_run_success rate drops below threshold."""
    if not project_id:
        return []
    snap = latest_snapshot(project_id=project_id, scope="project", window="rolling_10")
    if not snap:
        return []
    metrics = snap.get("metrics") or {}
    sample_size = int(metrics.get("sample_size") or 0)
    rate = metrics.get("first_run_success")
    if sample_size < REPEATED_FAILURE_MIN_SAMPLE or rate is None:
        return []
    try:
        rate_f = float(rate)
    except (TypeError, ValueError):
        return []
    if rate_f >= REPEATED_FAILURE_THRESHOLD:
        return []

    signal_key = "repeated_failure:rolling_10"
    detail = {
        "first_run_success": round(rate_f, 3),
        "threshold": REPEATED_FAILURE_THRESHOLD,
        "sample_size": sample_size,
        "snapshot_id": snap.get("id"),
    }
    existing = _existing_pending_candidate(
        surface=SURFACE_PROMPT, project_id=project_id, signal_key=signal_key,
    )
    _signal_fired(
        event_sink,
        session_id=session_id,
        name="repeated_failure",
        project_id=project_id,
        detail={**detail, "deduped": existing is not None},
        task_id=task_id,
    )
    if existing:
        return [existing]
    cand = candidate_create(
        surface=SURFACE_PROMPT,
        scope="project",
        project_id=project_id,
        session_id=session_id or None,
        title="High first-run failure rate — suggest project-specific debug guidance",
        rationale=(
            f"Project first_run_success={rate_f:.0%} over rolling_10 (sample={sample_size}). "
            f"A prompt overlay could surface project-specific failure patterns earlier."
        ),
        signal_source={
            "signal": "repeated_failure",
            "signal_key": signal_key,
            **detail,
        },
        confidence=max(0.35, min(0.85, 0.4 + (REPEATED_FAILURE_THRESHOLD - rate_f) * 1.5)),
        created_by="repeated_failure_generator",
        candidate_type="prompt_overlay",
        metadata={"generator_version": 1, "suggested_overlay_mode": "append"},
    )
    _candidate_created(event_sink, session_id=session_id, candidate=cand, task_id=task_id)
    return [cand]


# ── 3. negative_feedback (project-scope thumbs) ───────────────


def _project_thumb_rolling(project_id: str, *, limit: int) -> dict:
    """Aggregate thumbs over the last N feedback rows for an entire project."""
    rows = get_db().execute(
        """SELECT f.user_thumb FROM feedback f
             JOIN sessions s ON f.session_id = s.id
            WHERE s.project_id=? AND f.user_thumb IS NOT NULL
            ORDER BY f.created_at DESC LIMIT ?""",
        (project_id, limit),
    ).fetchall()
    counts = {"+1": 0, "0": 0, "-1": 0}
    for row in rows:
        try:
            v = int(row["user_thumb"])
        except (TypeError, ValueError):
            continue
        key = {1: "+1", 0: "0", -1: "-1"}.get(v)
        if key:
            counts[key] += 1
    total = sum(counts.values())
    return {
        "counts": counts,
        "total": total,
        "negatives": counts["-1"],
        "negative_rate": (counts["-1"] / total) if total else 0.0,
    }


def gen_negative_feedback(
    *,
    project_id: str | None,
    session_id: str = "",
    task_id: str = "",
    event_sink: EventSink | None = None,
) -> list[dict]:
    """Fire when rolling thumbs in the project carry >= N negatives."""
    if not project_id:
        # No project-bound session — fall back to session-only aggregation.
        if not session_id:
            return []
        summary = feedback_thumb_rolling(session_id, limit=NEGATIVE_FEEDBACK_LOOKBACK)
        scope_label = "session"
    else:
        summary = _project_thumb_rolling(project_id, limit=NEGATIVE_FEEDBACK_LOOKBACK)
        scope_label = "project"

    negatives = int(summary.get("negatives") or 0)
    if negatives < NEGATIVE_FEEDBACK_MIN_NEGATIVES:
        return []

    signal_key = f"negative_feedback:{scope_label}"
    existing = _existing_pending_candidate(
        surface=SURFACE_PROMPT, project_id=project_id, signal_key=signal_key,
    )
    detail = {
        "negatives": negatives,
        "lookback": NEGATIVE_FEEDBACK_LOOKBACK,
        "scope": scope_label,
        "counts": summary.get("counts"),
        "negative_rate": round(summary.get("negative_rate") or 0.0, 3),
    }
    _signal_fired(
        event_sink,
        session_id=session_id,
        name="negative_feedback",
        project_id=project_id,
        detail={**detail, "deduped": existing is not None},
        task_id=task_id,
    )
    if existing:
        return [existing]
    cand = candidate_create(
        surface=SURFACE_PROMPT,
        scope="project" if project_id else "session",
        project_id=project_id,
        session_id=session_id or None,
        title="User dissatisfaction trend — review prompt tone / structure",
        rationale=(
            f"{negatives} negative thumbs in the last {NEGATIVE_FEEDBACK_LOOKBACK} "
            f"feedback rows ({scope_label} scope). Consider revising the system prompt."
        ),
        signal_source={
            "signal": "negative_feedback",
            "signal_key": signal_key,
            **detail,
        },
        confidence=min(0.85, 0.45 + 0.05 * negatives),
        created_by="negative_feedback_generator",
        candidate_type="prompt_overlay",
        metadata={"generator_version": 1, "suggested_overlay_mode": "append"},
    )
    _candidate_created(event_sink, session_id=session_id, candidate=cand, task_id=task_id)
    return [cand]


# ── 4. approval_drop (rolling approval_pass_rate) ────────────


def gen_approval_drop(
    *,
    project_id: str | None,
    session_id: str = "",
    task_id: str = "",
    event_sink: EventSink | None = None,
) -> list[dict]:
    """Fire when rolling_10 approval_pass_rate drops below threshold."""
    if not project_id:
        return []
    snap = latest_snapshot(project_id=project_id, scope="project", window="rolling_10")
    if not snap:
        return []
    metrics = snap.get("metrics") or {}
    sample_size = int(metrics.get("sample_size") or 0)
    rate = metrics.get("approval_pass_rate")
    if sample_size < APPROVAL_DROP_MIN_SAMPLE or rate is None:
        return []
    try:
        rate_f = float(rate)
    except (TypeError, ValueError):
        return []
    if rate_f >= APPROVAL_DROP_THRESHOLD:
        return []

    signal_key = "approval_drop:rolling_10"
    detail = {
        "approval_pass_rate": round(rate_f, 3),
        "threshold": APPROVAL_DROP_THRESHOLD,
        "sample_size": sample_size,
        "approval_rejected": metrics.get("approval_rejected"),
        "approval_completed": metrics.get("approval_completed"),
        "snapshot_id": snap.get("id"),
    }
    existing = _existing_pending_candidate(
        surface=SURFACE_PROMPT, project_id=project_id, signal_key=signal_key,
    )
    _signal_fired(
        event_sink,
        session_id=session_id,
        name="approval_drop",
        project_id=project_id,
        detail={**detail, "deduped": existing is not None},
        task_id=task_id,
    )
    if existing:
        return [existing]
    cand = candidate_create(
        surface=SURFACE_PROMPT,
        scope="project",
        project_id=project_id,
        session_id=session_id or None,
        title="Approvals being rejected — tighten approval_request wording",
        rationale=(
            f"approval_pass_rate={rate_f:.0%} over rolling_10 (sample={sample_size}). "
            f"Agent may be requesting actions the user keeps refusing."
        ),
        signal_source={
            "signal": "approval_drop",
            "signal_key": signal_key,
            **detail,
        },
        confidence=max(0.4, min(0.85, 0.45 + (APPROVAL_DROP_THRESHOLD - rate_f) * 1.5)),
        created_by="approval_drop_generator",
        candidate_type="prompt_overlay",
        metadata={"generator_version": 1, "suggested_overlay_mode": "append"},
    )
    _candidate_created(event_sink, session_id=session_id, candidate=cand, task_id=task_id)
    return [cand]


# ── 5. routing_drift (SE-PR7) ─────────────────────────────────


def _classify_question(question: str) -> set[str]:
    """Return the set of specialist categories the question keywords match."""
    q = (question or "").lower()
    hits: set[str] = set()
    for specialist, keywords in ROUTING_KEYWORDS.items():
        if any(kw in q for kw in keywords):
            hits.add(specialist)
    return hits


def _recent_task_signals(project_id: str, lookback: int) -> list[dict]:
    """Return last N tasks for the project with their first user message + tools used."""
    db = get_db()
    rows = db.execute(
        """SELECT t.id AS task_id, t.session_id AS session_id
             FROM tasks t
             JOIN sessions s ON t.session_id = s.id
            WHERE s.project_id = ?
            ORDER BY t.started_at DESC
            LIMIT ?""",
        (project_id, lookback),
    ).fetchall()
    out: list[dict] = []
    for row in rows:
        msg = db.execute(
            """SELECT content FROM messages
                WHERE task_id=? AND role='user'
                ORDER BY created_at ASC LIMIT 1""",
            (row["task_id"],),
        ).fetchone()
        if not msg:
            continue
        tools = db.execute(
            """SELECT DISTINCT tool_name FROM tool_calls
                WHERE task_id=? AND state IN ('completed','rejected')""",
            (row["task_id"],),
        ).fetchall()
        out.append({
            "task_id": row["task_id"],
            "session_id": row["session_id"],
            "question": str(msg["content"] or ""),
            "tools": [r["tool_name"] for r in tools],
        })
    return out


def gen_routing_drift(
    *,
    project_id: str | None,
    session_id: str = "",
    task_id: str = "",
    event_sink: EventSink | None = None,
) -> list[dict]:
    """Propose a routing overlay when keyword/tool-use evidence points at the wrong specialist.

    Heuristic: for each task in the last ROUTING_LOOKBACK_TASKS, identify which
    specialists the **question keywords** point at and which specialists the
    **tools actually used** point at. When ≥ROUTING_MIN_MISMATCHES tasks in
    the same project flag the same specialist via question keywords but the
    tools never matched that specialist, propose a routing rule overlay.
    """
    if not project_id:
        return []
    samples = _recent_task_signals(project_id, ROUTING_LOOKBACK_TASKS)
    if len(samples) < ROUTING_MIN_MISMATCHES:
        return []

    # Bucket: specialist -> [(task_id, question_snippet) ...] where keywords
    # pointed at that specialist but no tool corroborated it.
    mismatches: dict[str, list[dict]] = {s: [] for s in ROUTING_KEYWORDS}
    for sample in samples:
        keyword_specialists = _classify_question(sample["question"])
        tool_specialists: set[str] = set()
        for tool_name in sample["tools"]:
            mapped = ROUTING_TOOL_TO_SPECIALIST.get(tool_name)
            if mapped:
                tool_specialists.add(mapped)
        for specialist in keyword_specialists:
            if specialist not in tool_specialists:
                mismatches[specialist].append({
                    "task_id": sample["task_id"],
                    "snippet": sample["question"][:120],
                })

    fired: list[dict] = []
    for specialist, items in mismatches.items():
        if len(items) < ROUTING_MIN_MISMATCHES:
            continue
        signal_key = f"routing_drift:{specialist}"
        existing = _existing_pending_candidate(
            surface=SURFACE_ROUTING, project_id=project_id, signal_key=signal_key,
        )
        detail = {
            "specialist": specialist,
            "mismatches": len(items),
            "lookback": ROUTING_LOOKBACK_TASKS,
            "samples": items[:5],
            "keywords": ROUTING_KEYWORDS[specialist],
        }
        _signal_fired(
            event_sink, session_id=session_id, name="routing_drift",
            project_id=project_id,
            detail={**detail, "deduped": existing is not None},
            task_id=task_id,
        )
        if existing:
            fired.append(existing)
            continue
        # The default routing overlay body just adds a rule that pushes the
        # specialist keywords toward that specialist. SE-PR4 default_payload
        # for routing was empty; this generator supplies the real content.
        payload_body = {
            "weights": {},
            "rules": [
                {
                    "if_contains_any": ROUTING_KEYWORDS[specialist],
                    "route_to": specialist,
                },
            ],
        }
        cand = candidate_create(
            surface=SURFACE_ROUTING,
            scope="project",
            project_id=project_id,
            session_id=session_id or None,
            title=f"Route {specialist}-flavoured questions to the {specialist} specialist",
            rationale=(
                f"{len(items)} task(s) out of the last {ROUTING_LOOKBACK_TASKS} carried "
                f"{specialist} keywords but the resulting tool calls never matched "
                f"that specialist. A routing rule keyed on the keywords would have "
                f"shortened the path on those tasks."
            ),
            signal_source={
                "signal": "routing_drift",
                "signal_key": signal_key,
                **detail,
                "suggested_payload": payload_body,
            },
            confidence=min(0.85, 0.4 + 0.05 * len(items)),
            created_by="routing_drift_generator",
            candidate_type="routing_overlay",
            metadata={"generator_version": 1, "suggested_payload": payload_body},
        )
        _candidate_created(event_sink, session_id=session_id, candidate=cand, task_id=task_id)
        fired.append(cand)
    return fired


# ── 6. flow_template_reuse (SE-PR7) ──────────────────────────


_TCL_COMMENT = (";", "#")


def _normalize_tcl_script(script: str) -> tuple[str, list[str]]:
    """Strip whitespace + comments. Returns (normalized, leading_commands)."""
    lines: list[str] = []
    leading_cmds: list[str] = []
    for raw in (script or "").splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith(_TCL_COMMENT):
            continue
        lines.append(stripped)
        if len(leading_cmds) < 4:
            first_token = stripped.split(None, 1)[0]
            leading_cmds.append(first_token.lower())
    return "\n".join(lines), leading_cmds


def _flow_name_for(commands: list[str]) -> str:
    """Heuristic: classify a normalized Tcl script into a flow bucket."""
    cmd_set = {c.lower() for c in commands}
    if "synth_design" in cmd_set:
        return "synth"
    if cmd_set & {"opt_design", "place_design", "route_design"}:
        return "impl"
    if cmd_set & {"report_timing_summary", "report_timing"}:
        return "report_timing"
    if cmd_set & {"report_utilization"}:
        return "report_utilization"
    if cmd_set & {"report_drc"}:
        return "report_drc"
    return "custom"


def _recent_script_toolcalls(project_id: str, lookback: int) -> list[dict]:
    """Return recent run_vivado_script_tool calls with their script body."""
    db = get_db()
    rows = db.execute(
        """SELECT tc.id AS tcid, tc.task_id AS task_id, tc.input_summary AS input_summary,
                  tc.output_summary AS output_summary, tc.state AS state
             FROM tool_calls tc
             JOIN tasks t ON tc.task_id = t.id
             JOIN sessions s ON t.session_id = s.id
            WHERE s.project_id = ? AND tc.tool_name = 'run_vivado_script_tool'
              AND tc.state = 'completed'
            ORDER BY tc.started_at DESC
            LIMIT ?""",
        (project_id, lookback),
    ).fetchall()
    out: list[dict] = []
    for row in rows:
        raw = row["input_summary"] or ""
        if not isinstance(raw, str) or not raw.strip().startswith("{"):
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        script = payload.get("script")
        if not isinstance(script, str) or not script.strip():
            continue
        # Tag with execution success to avoid recommending broken scripts.
        outcome = ""
        out_raw = row["output_summary"] or ""
        if isinstance(out_raw, str) and out_raw.strip().startswith("{"):
            try:
                outcome = str(json.loads(out_raw).get("edagent_outcome") or "")
            except json.JSONDecodeError:
                outcome = ""
        if outcome and outcome != "execution_succeeded":
            continue
        out.append({"tool_call_id": row["tcid"], "script": script})
    return out


def gen_flow_template_reuse(
    *,
    project_id: str | None,
    session_id: str = "",
    task_id: str = "",
    event_sink: EventSink | None = None,
) -> list[dict]:
    """Propose a flow_template overlay when the same script body recurs.

    Looks at the last FLOW_TEMPLATE_LOOKBACK_TASKS successful
    ``run_vivado_script_tool`` invocations for the project, normalises each
    script (strip whitespace + comments), and when the same normalised body
    shows up at least FLOW_TEMPLATE_MIN_OCCURRENCES times suggests turning it
    into a reusable Tcl flow template.
    """
    if not project_id:
        return []
    scripts = _recent_script_toolcalls(project_id, FLOW_TEMPLATE_LOOKBACK_TASKS)
    if len(scripts) < FLOW_TEMPLATE_MIN_OCCURRENCES:
        return []

    buckets: dict[str, dict] = {}
    for entry in scripts:
        norm, leading = _normalize_tcl_script(entry["script"])
        line_count = len(norm.splitlines())
        if line_count < FLOW_TEMPLATE_MIN_LINES or line_count > FLOW_TEMPLATE_MAX_LINES:
            continue
        flow_name = _flow_name_for(leading)
        key = f"{flow_name}:{hash(norm) & 0xFFFFFFFF:08x}"
        if key not in buckets:
            buckets[key] = {
                "flow_name": flow_name,
                "normalized": norm,
                "leading": leading,
                "count": 0,
                "samples": [],
            }
        buckets[key]["count"] += 1
        buckets[key]["samples"].append(entry["tool_call_id"])

    fired: list[dict] = []
    for key, bucket in buckets.items():
        if bucket["count"] < FLOW_TEMPLATE_MIN_OCCURRENCES:
            continue
        flow_name = bucket["flow_name"]
        signal_key = f"flow_template_reuse:{key}"
        existing = _existing_pending_candidate(
            surface=SURFACE_FLOW_TEMPLATE, project_id=project_id, signal_key=signal_key,
        )
        detail = {
            "flow_name": flow_name,
            "occurrences": bucket["count"],
            "lookback": FLOW_TEMPLATE_LOOKBACK_TASKS,
            "sample_tool_call_ids": bucket["samples"][:5],
            "leading_commands": bucket["leading"],
            "line_count": len(bucket["normalized"].splitlines()),
        }
        _signal_fired(
            event_sink, session_id=session_id, name="flow_template_reuse",
            project_id=project_id,
            detail={**detail, "deduped": existing is not None},
            task_id=task_id,
        )
        if existing:
            fired.append(existing)
            continue
        # Default overlay payload supplies the actual templated body.
        payload_body = {
            "templates": {
                flow_name: bucket["normalized"] + "\n",
            },
        }
        cand = candidate_create(
            surface=SURFACE_FLOW_TEMPLATE,
            scope="project",
            project_id=project_id,
            session_id=session_id or None,
            title=f"Promote recurring `{flow_name}` Tcl script to a reusable template",
            rationale=(
                f"The same {flow_name} Tcl body was executed {bucket['count']} times "
                f"in the last {FLOW_TEMPLATE_LOOKBACK_TASKS} successful "
                f"run_vivado_script_tool invocations for this project. "
                f"Codify it as a flow_template so future runs share the same path."
            ),
            signal_source={
                "signal": "flow_template_reuse",
                "signal_key": signal_key,
                **detail,
                "suggested_payload": payload_body,
            },
            confidence=min(0.85, 0.4 + 0.05 * bucket["count"]),
            created_by="flow_template_reuse_generator",
            candidate_type="flow_template_overlay",
            metadata={"generator_version": 1, "suggested_payload": payload_body},
        )
        _candidate_created(event_sink, session_id=session_id, candidate=cand, task_id=task_id)
        fired.append(cand)
    return fired


# ── dispatcher ────────────────────────────────────────────────


GeneratorFn = Callable[..., list[dict]]

GENERATORS: tuple[tuple[str, GeneratorFn], ...] = (
    ("recurrence", gen_recurrence),
    ("repeated_failure", gen_repeated_failure),
    ("negative_feedback", gen_negative_feedback),
    ("approval_drop", gen_approval_drop),
    ("routing_drift", gen_routing_drift),
    ("flow_template_reuse", gen_flow_template_reuse),
)


def run_generators(
    *,
    project_id: str | None,
    session_id: str = "",
    task_id: str = "",
    event_sink: EventSink | None = None,
    only: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Run every generator. Per-generator failures are isolated."""
    out: dict[str, Any] = {"created": [], "errors": {}}
    allowed = set(only) if only is not None else None
    for name, fn in GENERATORS:
        if allowed is not None and name not in allowed:
            continue
        try:
            results = fn(
                project_id=project_id,
                session_id=session_id,
                task_id=task_id,
                event_sink=event_sink,
            )
            for cand in results or []:
                out["created"].append({"generator": name, "candidate_id": cand.get("id")})
        except Exception as exc:  # pragma: no cover
            logger.exception("generator %s failed: %s", name, exc)
            out["errors"][name] = str(exc)
    return out
