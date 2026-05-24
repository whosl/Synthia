"""Overlay resolution + admin CRUD (SPEC §22.3, §22.5).

An *overlay* is an active tuning layer for one evolution *surface*, scoped to
a project (or globally). The :func:`resolve_*` entry points are read by the
agent / supervisor / tcl_templates layer and ALWAYS fall back to baseline.
The :func:`overlay_create` / :func:`overlay_retire` admin helpers live here so
they share the same payload conventions.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Sequence

logger = logging.getLogger(__name__)

SURFACE_KB = "kb"
SURFACE_PROMPT = "prompt"
SURFACE_TOOL = "tool"
SURFACE_FLOW_TEMPLATE = "flow_template"
SURFACE_ROUTING = "routing"

SURFACES: tuple[str, ...] = (
    SURFACE_KB,
    SURFACE_PROMPT,
    SURFACE_TOOL,
    SURFACE_FLOW_TEMPLATE,
    SURFACE_ROUTING,
)


def active_overlay(surface: str, project_id: str | None) -> dict | None:
    """Return the active overlay row for (surface, project_id) or None.

    Order of precedence (SPEC §22.5):
      1. A/B trial arm assignment from the current task (SE-PR5).
      2. project-scope active overlay.
      3. global-scope active overlay.
      4. None (= baseline).

    SE-PR1 was a no-op; SE-PR4 lit up (2)+(3); SE-PR5 adds (1) on top so the
    A/B engine can route a single task to either baseline or variant without
    touching any caller of this resolver.
    """
    if surface not in SURFACES:
        raise ValueError(f"Unknown evolution surface: {surface!r}")

    try:
        from edagent_vivado.repository.db import get_db
    except Exception:
        return None

    try:
        db = get_db()
    except Exception:
        return None

    # ── (1) trial arm assignment from contextvar ──────────────
    try:
        from edagent_vivado.evolution.task_arms import get_task_arm

        arm = get_task_arm(surface)
    except Exception:  # pragma: no cover
        arm = None
    if arm is not None:
        _arm_label, overlay_id, _trial_id = arm
        if overlay_id:
            row = db.execute("SELECT * FROM overlays WHERE id=?", (overlay_id,)).fetchone()
            if row:
                out = dict(row)
                try:
                    out["payload"] = json.loads(out.get("payload_json") or "{}")
                except (json.JSONDecodeError, TypeError):
                    out["payload"] = {}
                # Mark for downstream observability.
                meta_raw = out.get("metadata_json") or "{}"
                try:
                    meta = json.loads(meta_raw)
                except (json.JSONDecodeError, TypeError):
                    meta = {}
                meta.setdefault("_trial_arm", _arm_label)
                meta.setdefault("_trial_id", _trial_id)
                out["metadata"] = meta
                return out
        # arm=baseline with no overlay → fall through (no baseline yet exists)

    try:
        rows: list[Any] = []
        if project_id:
            rows = list(
                db.execute(
                    """SELECT * FROM overlays
                         WHERE surface=? AND state='active' AND scope='project' AND project_id=?
                         ORDER BY created_at DESC LIMIT 1""",
                    (surface, project_id),
                )
            )
        if not rows:
            rows = list(
                db.execute(
                    """SELECT * FROM overlays
                         WHERE surface=? AND state='active' AND scope='global'
                         ORDER BY created_at DESC LIMIT 1""",
                    (surface,),
                )
            )
        if not rows:
            return None
        row = dict(rows[0])
        try:
            row["payload"] = json.loads(row.get("payload_json") or "{}")
        except (json.JSONDecodeError, TypeError):
            row["payload"] = {}
        return row
    except Exception as exc:
        # Resolver must never raise — evolution is an additive layer.
        logger.debug("overlay lookup failed for surface=%s project=%s: %s", surface, project_id, exc)
        return None


def resolve_prompt(base_prompt: str, project_id: str | None = None) -> str:
    """Return the effective system prompt for an agent run.

    Overlay payload schema (SE-PR3+):
        {
            "mode": "prepend|append|replace",
            "text": "..."
        }
    """
    overlay = active_overlay(SURFACE_PROMPT, project_id)
    if not overlay:
        return base_prompt
    payload = overlay.get("payload") or {}
    mode = str(payload.get("mode") or "append").lower()
    extra = str(payload.get("text") or "").strip()
    if not extra:
        return base_prompt
    if mode == "replace":
        return extra
    if mode == "prepend":
        return f"{extra}\n\n{base_prompt}"
    return f"{base_prompt}\n\n{extra}"


def resolve_tools(base_tools: Sequence[Any], project_id: str | None = None) -> list[Any]:
    """Filter / extend the agent tool registry for a given project.

    Overlay payload schema (SE-PR8):

    .. code-block:: json

        {
          "disabled": ["tool_name", ...],
          "additional_tools": [
            {"name": "summarise_xdc", "source": "from langchain_core.tools import tool\\n@tool\\ndef summarise_xdc(...)..."}
          ]
        }

    ``disabled`` strips named tools from the baseline registry.
    ``additional_tools`` runs each source through
    :mod:`edagent_vivado.evolution.sandbox` (AST whitelist + restricted
    exec) and appends the resulting LangChain tool. Any source that fails
    validation is logged and skipped so a single bad evolved tool can never
    break the agent boot. Loaded tools are cached by sha256 of the source.
    """
    overlay = active_overlay(SURFACE_TOOL, project_id)
    if not overlay:
        return list(base_tools)
    payload = overlay.get("payload") or {}
    disabled = {str(name) for name in (payload.get("disabled") or [])}
    additional = payload.get("additional_tools") or []
    if not disabled and not additional:
        return list(base_tools)

    out: list[Any] = []
    for tool in base_tools:
        name = getattr(tool, "name", None) or getattr(tool, "__name__", None) or ""
        if name in disabled:
            logger.info("evolution: tool %s disabled by overlay %s", name, overlay.get("id"))
            continue
        out.append(tool)

    if isinstance(additional, list):
        try:
            from edagent_vivado.evolution.sandbox import SandboxError, load_tool
        except Exception:  # pragma: no cover
            SandboxError = ValueError  # type: ignore[assignment]
            load_tool = None  # type: ignore[assignment]
        if load_tool is not None:
            for entry in additional:
                if not isinstance(entry, dict):
                    continue
                source = entry.get("source")
                declared = entry.get("name")
                if not isinstance(source, str) or not isinstance(declared, str):
                    continue
                try:
                    out.append(load_tool(source, declared_name=declared))
                except SandboxError as exc:  # type: ignore[misc]
                    logger.warning(
                        "evolution: evolved tool %s rejected (%s)", declared, exc,
                    )
                except Exception:  # pragma: no cover
                    logger.exception("evolution: evolved tool %s load failed", declared)
    return out


def resolve_flow_template(
    flow_name: str,
    project_id: str | None = None,
) -> str | None:
    """Return a project-specific Tcl flow template body, or None for built-in.

    Overlay payload schema (SE-PR3+):
        {
            "templates": {
                "synth": "..tcl body..",
                "impl":  "..tcl body.."
            }
        }
    """
    overlay = active_overlay(SURFACE_FLOW_TEMPLATE, project_id)
    if not overlay:
        return None
    payload = overlay.get("payload") or {}
    templates = payload.get("templates") or {}
    body = templates.get(flow_name)
    if isinstance(body, str) and body.strip():
        return body
    return None


def resolve_routing(project_id: str | None = None) -> dict | None:
    """Return supervisor routing overrides (weights / rules) for a project.

    Overlay payload schema (SE-PR7+):
        {
            "weights": {"synthesis": 1.0, "timing": 0.7, "constraint": 0.7},
            "rules": [
                {"if_contains_any": ["wns", "tns"], "route_to": "timing"}
            ]
        }
    """
    overlay = active_overlay(SURFACE_ROUTING, project_id)
    if not overlay:
        return None
    payload = overlay.get("payload") or {}
    if not isinstance(payload, dict) or not payload:
        return None
    weights = payload.get("weights") or {}
    rules = payload.get("rules") or []
    if not weights and not rules:
        return None
    return payload


# ── admin CRUD (used by SE-PR4 workflows) ─────────────────────


def _uid() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> int:
    return int(time.time())


def overlay_create(
    *,
    surface: str,
    payload: dict,
    scope: str = "project",
    project_id: str | None = None,
    name: str | None = None,
    state: str = "active",
    source_candidate_id: str | None = None,
    parent_overlay_id: str | None = None,
    metadata: dict | None = None,
) -> dict:
    """Insert a new overlay row. Caller is responsible for retiring conflicts."""
    if surface not in SURFACES:
        raise ValueError(f"Unknown evolution surface: {surface!r}")
    if scope not in ("project", "global"):
        raise ValueError(f"overlay scope must be project|global, got {scope!r}")
    if state not in ("active", "shadow", "retired"):
        raise ValueError(f"overlay state must be active|shadow|retired, got {state!r}")
    if scope == "project" and not project_id:
        raise ValueError("project-scope overlay requires project_id")

    from edagent_vivado.repository.db import get_db

    oid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        """INSERT INTO overlays(
              id, scope, project_id, surface, name, state, payload_json,
              source_candidate_id, parent_overlay_id, created_at, metadata_json
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (
            oid, scope, project_id if scope == "project" else None, surface,
            name or f"{surface}-{oid}",
            state, json.dumps(payload or {}),
            source_candidate_id, parent_overlay_id, now,
            json.dumps(metadata or {}),
        ),
    )
    db.commit()
    return overlay_get(oid)  # type: ignore[return-value]


def overlay_get(oid: str) -> dict | None:
    from edagent_vivado.repository.db import get_db

    row = get_db().execute("SELECT * FROM overlays WHERE id=?", (oid,)).fetchone()
    return _decode(row) if row else None


def overlay_list(
    *,
    project_id: str | None = None,
    surface: str | None = None,
    state: str | None = None,
    scope: str | None = None,
    limit: int = 200,
) -> list[dict]:
    from edagent_vivado.repository.db import get_db

    q = "SELECT * FROM overlays WHERE 1=1"
    params: list[Any] = []
    if state:
        q += " AND state=?"
        params.append(state)
    if surface:
        q += " AND surface=?"
        params.append(surface)
    if scope:
        q += " AND scope=?"
        params.append(scope)
    if project_id:
        q += " AND project_id=?"
        params.append(project_id)
    q += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = get_db().execute(q, params).fetchall()
    return [_decode(r) for r in rows]


def overlay_retire(oid: str) -> dict | None:
    """Mark an overlay retired. Resolvers immediately stop returning it."""
    from edagent_vivado.repository.db import get_db

    db = get_db()
    db.execute(
        "UPDATE overlays SET state='retired', retired_at=? WHERE id=?",
        (_now(), oid),
    )
    db.commit()
    return overlay_get(oid)


def overlay_activate(oid: str) -> dict | None:
    """Re-activate a retired overlay (used by rollback to parent)."""
    from edagent_vivado.repository.db import get_db

    db = get_db()
    db.execute(
        "UPDATE overlays SET state='active', retired_at=NULL WHERE id=?",
        (oid,),
    )
    db.commit()
    return overlay_get(oid)


def overlay_retire_active_for(
    *,
    surface: str,
    project_id: str | None,
    scope: str = "project",
) -> dict | None:
    """Retire the currently active overlay for (surface, scope, project), if any.

    Returns the retired row or None when nothing was active.
    """
    from edagent_vivado.repository.db import get_db

    if scope == "project":
        if not project_id:
            return None
        row = get_db().execute(
            """SELECT * FROM overlays
                 WHERE surface=? AND state='active' AND scope='project' AND project_id=?
                 ORDER BY created_at DESC LIMIT 1""",
            (surface, project_id),
        ).fetchone()
    else:
        row = get_db().execute(
            """SELECT * FROM overlays
                 WHERE surface=? AND state='active' AND scope='global'
                 ORDER BY created_at DESC LIMIT 1""",
            (surface,),
        ).fetchone()
    if not row:
        return None
    return overlay_retire(dict(row)["id"])


def _decode(row) -> dict:
    out = dict(row)
    try:
        out["payload"] = json.loads(out.get("payload_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        out["payload"] = {}
    try:
        out["metadata"] = json.loads(out.get("metadata_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        out["metadata"] = {}
    return out
