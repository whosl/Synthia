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
from edagent_vivado.evolution.candidates import (
    candidate_create,
    candidate_get,
    candidate_list,
    candidate_update_status,
)
from edagent_vivado.evolution.collector import collect_task_metrics
from edagent_vivado.evolution.feedback import (
    feedback_create,
    feedback_list_for_session,
    feedback_list_for_task,
    feedback_thumb_for_task,
    feedback_thumb_rolling,
)
from edagent_vivado.evolution.generators import (
    GENERATORS,
    gen_approval_drop,
    gen_flow_template_reuse,
    gen_negative_feedback,
    gen_recurrence,
    gen_repeated_failure,
    gen_routing_drift,
    run_generators,
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
    overlay_create,
    overlay_get,
    overlay_list,
    overlay_retire,
    overlay_activate,
    overlay_retire_active_for,
)
from edagent_vivado.evolution.workflows import (
    approve_candidate,
    reject_candidate,
    merge_candidate,
    rollback_candidate,
    retire_overlay,
)
from edagent_vivado.evolution.trial_config import (
    is_trial_enabled,
    project_trial_config,
    set_trial_enabled,
)
from edagent_vivado.evolution.trials import (
    abort_trial,
    active_trial_for,
    assign_arms_for_task,
    force_decision,
    maybe_decide_trial,
    record_snapshot as record_trial_snapshot,
    start_trial,
    trial_get,
    trial_list,
    MIN_SAMPLES_PER_ARM,
    DECISION_MARGIN,
    TRIAL_FORBIDDEN_SURFACES,
)
from edagent_vivado.evolution.task_arms import (
    clear_task_arms,
    current_task_arms,
    get_task_arm,
    reset_task_arms,
    set_task_arms,
    task_arms_summary,
)
from edagent_vivado.evolution.eval_set import (
    EvalCase,
    EvalSet,
    EvalSetError,
    default_eval_set_dir,
    discover_eval_sets,
    get_eval_set,
    load_eval_set,
)
from edagent_vivado.evolution.eval_runs import (
    enqueue_eval_run,
    eval_run_create,
    eval_run_get,
    eval_run_list,
    get_eval_set_dto,
    list_eval_sets_dto,
)
from edagent_vivado.evolution.sandbox import (
    AstWhitelistVisitor,
    SandboxError,
    cache_size as sandbox_cache_size,
    clear_tool_cache as clear_sandbox_cache,
    load_tool as load_evolved_tool,
    validate_source as validate_evolved_tool_source,
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
    # SE-PR3
    "candidate_create",
    "candidate_get",
    "candidate_list",
    "candidate_update_status",
    "GENERATORS",
    "gen_approval_drop",
    "gen_flow_template_reuse",
    "gen_negative_feedback",
    "gen_recurrence",
    "gen_repeated_failure",
    "gen_routing_drift",
    "run_generators",
    # SE-PR4
    "overlay_create",
    "overlay_get",
    "overlay_list",
    "overlay_retire",
    "overlay_activate",
    "overlay_retire_active_for",
    "approve_candidate",
    "reject_candidate",
    "merge_candidate",
    "rollback_candidate",
    "retire_overlay",
    # SE-PR5
    "is_trial_enabled",
    "set_trial_enabled",
    "project_trial_config",
    "start_trial",
    "trial_get",
    "trial_list",
    "active_trial_for",
    "assign_arms_for_task",
    "maybe_decide_trial",
    "abort_trial",
    "force_decision",
    "record_trial_snapshot",
    "MIN_SAMPLES_PER_ARM",
    "DECISION_MARGIN",
    "TRIAL_FORBIDDEN_SURFACES",
    "set_task_arms",
    "reset_task_arms",
    "clear_task_arms",
    "get_task_arm",
    "current_task_arms",
    "task_arms_summary",
    # SE-PR6 — eval set placeholder
    "EvalCase",
    "EvalSet",
    "EvalSetError",
    "default_eval_set_dir",
    "discover_eval_sets",
    "load_eval_set",
    "get_eval_set",
    "enqueue_eval_run",
    "eval_run_create",
    "eval_run_get",
    "eval_run_list",
    "get_eval_set_dto",
    "list_eval_sets_dto",
    # SE-PR8 — tool sandbox
    "SandboxError",
    "AstWhitelistVisitor",
    "validate_evolved_tool_source",
    "load_evolved_tool",
    "sandbox_cache_size",
    "clear_sandbox_cache",
]
