"""Overlay resolution (SPEC §22.3).

An *overlay* is an active tuning layer for one evolution *surface*, scoped to
a project (or globally). Resolvers below are the single entry points the rest
of the codebase calls; in SE-PR1 they simply return the baseline. SE-PR4 will
make these actually consult the ``overlays`` table; nothing else needs to
change because callers already go through the resolver.
"""

from __future__ import annotations

import json
import logging
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
      1. project-scope active overlay
      2. global-scope active overlay
      3. None (= baseline)

    SE-PR1 is read-only and never returns anything; subsequent PRs flip this on.
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

    Overlay payload schema (SE-PR8+):
        {
            "disabled": ["tool_name", ...],
            "additional_tool_ids": ["evolved-<id>", ...]
        }

    SE-PR1 only honors the ``disabled`` filter; the ``additional_tool_ids``
    side requires the sandbox loader from SE-PR8 before it does anything.
    """
    overlay = active_overlay(SURFACE_TOOL, project_id)
    if not overlay:
        return list(base_tools)
    payload = overlay.get("payload") or {}
    disabled = {str(name) for name in (payload.get("disabled") or [])}
    if not disabled:
        return list(base_tools)
    out: list[Any] = []
    for tool in base_tools:
        name = getattr(tool, "name", None) or getattr(tool, "__name__", None) or ""
        if name in disabled:
            logger.info("evolution: tool %s disabled by overlay %s", name, overlay.get("id"))
            continue
        out.append(tool)
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
    return payload
