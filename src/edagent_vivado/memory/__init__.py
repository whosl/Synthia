"""Synthia memory system — Phase A canvas, Phase B atoms, Phase C scenarios/persona, Phase D evolution link."""

from edagent_vivado.memory.atoms import extract_atoms_from_session, list_atoms_for_project
from edagent_vivado.memory.canvas import (
    archive_active_canvas_for_task,
    build_canvas_for_prompt,
    get_active_canvas,
    list_canvas_history,
    update_task_canvas,
)
from edagent_vivado.memory.personas import (
    build_project_persona,
    ensure_project_persona_for_session,
    get_project_persona,
    load_project_persona_text,
    mark_project_persona_dirty,
    rebuild_persona_if_dirty,
)
from edagent_vivado.memory.pipeline import get_memory_pipeline, on_message
from edagent_vivado.memory.refs import read_ref, write_ref
from edagent_vivado.memory.evolution_link import record_direct_approval, record_overlay_config_atom, record_trial_outcome
from edagent_vivado.memory.scenarios import aggregate_scenarios, list_scenarios_for_project

__all__ = [
    "update_task_canvas",
    "archive_active_canvas_for_task",
    "get_active_canvas",
    "list_canvas_history",
    "build_canvas_for_prompt",
    "write_ref",
    "read_ref",
    "extract_atoms_from_session",
    "list_atoms_for_project",
    "aggregate_scenarios",
    "list_scenarios_for_project",
    "build_project_persona",
    "get_project_persona",
    "load_project_persona_text",
    "ensure_project_persona_for_session",
    "mark_project_persona_dirty",
    "rebuild_persona_if_dirty",
    "get_memory_pipeline",
    "on_message",
    "record_overlay_config_atom",
    "record_trial_outcome",
    "record_direct_approval",
]
