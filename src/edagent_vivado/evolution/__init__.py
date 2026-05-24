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
]
