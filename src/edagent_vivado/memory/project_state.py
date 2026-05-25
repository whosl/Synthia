"""Merged project-scoped memory pipeline state (persona + L2)."""

from __future__ import annotations

from typing import Any

from edagent_vivado.repository.store import settings_get, settings_set


def project_memory_key(project_id: str) -> str:
    return f"memory_project:{project_id}"


def default_project_memory_state() -> dict[str, Any]:
    return {
        "last_persona_atom_count": 0,
        "persona_dirty": False,
        "last_l2_at": 0,
    }


def load_project_memory_state(project_id: str) -> dict[str, Any]:
    raw = settings_get(project_memory_key(project_id), default=None)
    state = default_project_memory_state()
    if isinstance(raw, dict):
        state.update(raw)
    return state


def merge_project_memory_state(project_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    """Atomic read-merge-write for shared persona/L2 settings."""
    state = load_project_memory_state(project_id)
    state.update(updates)
    settings_set(project_memory_key(project_id), state)
    return state
