"""Self-evolution subsystem (SPEC §22).

SE-PR1 ships:
- Schema for evolution_candidates / overlays / evolution_trials / feedback / metric_snapshots / eval_runs.
- Resolver indirection for the five evolution surfaces (kb / prompt / tool / flow_template / routing).
- All resolvers default to baseline behavior; no overlay is active until later PRs.

Later PRs (SE-PR2..8) will add:
- feedback channel + post-task metric_snapshots
- candidate generators (recurrence / repeated-failure / negative-feedback / approval-drop)
- review UI + approve/reject/merge/rollback APIs
- A/B trial engine (opt-in per surface)
- eval set runner
- routing overlay
- sandboxed tool surface
"""

from edagent_vivado.evolution.aggregator import (
    aggregate_rolling,
    latest_snapshot,
    snapshot_series,
)
from edagent_vivado.evolution.collector import collect_task_metrics
from edagent_vivado.evolution.feedback import (
    feedback_create,
    feedback_list_for_session,
    feedback_list_for_task,
    feedback_thumb_for_task,
    feedback_thumb_rolling,
)
from edagent_vivado.evolution.overlays import (
    SURFACES,
    SURFACE_KB,
    SURFACE_PROMPT,
    SURFACE_TOOL,
    SURFACE_FLOW_TEMPLATE,
    SURFACE_ROUTING,
    resolve_prompt,
    resolve_tools,
    resolve_flow_template,
    resolve_routing,
    active_overlay,
)

__all__ = [
    "SURFACES",
    "SURFACE_KB",
    "SURFACE_PROMPT",
    "SURFACE_TOOL",
    "SURFACE_FLOW_TEMPLATE",
    "SURFACE_ROUTING",
    "resolve_prompt",
    "resolve_tools",
    "resolve_flow_template",
    "resolve_routing",
    "active_overlay",
    # SE-PR2
    "collect_task_metrics",
    "aggregate_rolling",
    "latest_snapshot",
    "snapshot_series",
    "feedback_create",
    "feedback_list_for_session",
    "feedback_list_for_task",
    "feedback_thumb_for_task",
    "feedback_thumb_rolling",
]
