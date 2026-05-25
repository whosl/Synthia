"""Per-project trial opt-in (SPEC §22 SE-PR5).

The actual flag lives in the SE-PR1 ``settings`` table under keys like::

    evolution.trial.prompt.<project_id> = True

We deliberately use the global settings table rather than a project metadata
column so the schema stays additive and a future ``global`` scope can use the
same code path with ``project_id = "global"``.

SPEC §22.2 forbids trials on the ``tool`` surface; :func:`set_trial_enabled`
refuses to set the flag for that surface so the engine never gets a chance to
shadow-apply a tool overlay.
"""

from __future__ import annotations

import logging

from edagent_vivado.evolution.overlays import SURFACES
from edagent_vivado.evolution.trials import TRIAL_FORBIDDEN_SURFACES

logger = logging.getLogger(__name__)


def _key(project_id: str, surface: str) -> str:
    return f"evolution.trial.{surface}.{project_id or 'global'}"


def is_trial_enabled(project_id: str | None, surface: str) -> bool:
    if not project_id or surface in TRIAL_FORBIDDEN_SURFACES:
        return False
    try:
        from edagent_vivado.repository.store import settings_get

        return bool(settings_get(_key(project_id, surface), False))
    except Exception:  # pragma: no cover
        logger.debug("settings_get failed for %s", _key(project_id, surface), exc_info=True)
        return False


def set_trial_enabled(project_id: str, surface: str, enabled: bool) -> bool:
    """Enable or disable A/B trials for (project, surface). Tool surface refused."""
    if surface in TRIAL_FORBIDDEN_SURFACES:
        raise ValueError(f"surface {surface!r} cannot enable A/B trials (SPEC §22.2)")
    if surface not in SURFACES:
        raise ValueError(f"unknown surface {surface!r}")
    from edagent_vivado.repository.store import settings_set

    settings_set(_key(project_id, surface), bool(enabled))
    return bool(enabled)


def project_trial_config(project_id: str) -> dict[str, bool]:
    """Return the per-surface trial flags for one project."""
    out: dict[str, bool] = {}
    for surface in SURFACES:
        if surface in TRIAL_FORBIDDEN_SURFACES:
            out[surface] = False
            continue
        out[surface] = is_trial_enabled(project_id, surface)
    return out
