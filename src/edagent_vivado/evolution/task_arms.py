"""Per-task A/B arm assignment passed through resolvers (SPEC §22 SE-PR5).

When a task is enrolled in a running ``evolution_trial``, the agent loop
deposits a mapping ``{surface: (arm, overlay_id, trial_id)}`` into a
ContextVar before invoking the agent. The :func:`overlays.active_overlay`
resolver reads that mapping and, for surfaces with an assignment, returns
the trial-specific overlay (the baseline active overlay when ``arm =
baseline`` or the shadow variant overlay when ``arm = variant``) instead of
the normal "latest active" lookup.

Using a ContextVar means async hops inside :mod:`asyncio` carry the
assignment cleanly, and threads spawned via ``run_in_executor`` inherit a
snapshot of the context — the exact behavior we need for LangChain tools
that run in worker threads.
"""

from __future__ import annotations

import contextvars
import logging
from typing import Iterable

logger = logging.getLogger(__name__)


# (arm, overlay_id, trial_id) — overlay_id can be None when no overlay yet exists.
ArmTuple = tuple[str, str | None, str]
ArmMap = dict[str, ArmTuple]

_arms_var: contextvars.ContextVar[ArmMap] = contextvars.ContextVar(
    "evolution_task_arms", default={}
)


def set_task_arms(arms: ArmMap) -> contextvars.Token:
    """Install an arm assignment for the current task. Returns a reset token."""
    return _arms_var.set(dict(arms or {}))


def reset_task_arms(token: contextvars.Token) -> None:
    try:
        _arms_var.reset(token)
    except (LookupError, ValueError):
        # ``reset`` is best-effort; an asyncio task tearing down may already
        # have lost the ContextVar binding.
        _arms_var.set({})


def clear_task_arms() -> None:
    _arms_var.set({})


def get_task_arm(surface: str) -> ArmTuple | None:
    arms = _arms_var.get()
    if not arms:
        return None
    return arms.get(surface)


def current_task_arms() -> ArmMap:
    return dict(_arms_var.get() or {})


def task_arms_summary(arms: ArmMap | None = None) -> list[dict]:
    """Serialisable form for events / metric_snapshots."""
    snapshot = arms if arms is not None else _arms_var.get()
    out: list[dict] = []
    for surface, (arm, overlay_id, trial_id) in (snapshot or {}).items():
        out.append({
            "surface": surface,
            "arm": arm,
            "overlay_id": overlay_id,
            "trial_id": trial_id,
        })
    return out


def known_surfaces(arms: ArmMap | None = None) -> Iterable[str]:
    snapshot = arms if arms is not None else _arms_var.get()
    return list((snapshot or {}).keys())
