"""Canonical event catalog — keep in sync with frontend/src/lib/events/catalog.ts."""

from __future__ import annotations

PROTOCOL_VERSION = 1

# Lifecycle
LIFECYCLE_EVENTS = (
    "session.created",
    "session.updated",
    "session.archived",
    "task.created",
    "task.started",
    "task.stopping",
    "task.stopped",
    "task.done",
    "task.error",
    "run.started",
    "run.completed",
    "run.error",
)

# Chat / assistant stream
MESSAGE_EVENTS = (
    "message.user.created",
    "message.assistant.delta",
    "message.assistant.completed",
    "message.assistant.stopped",
    "message.assistant.snapshot",
    "assistant.stream.opened",
    "assistant.stream.completed",
    "reasoning.delta",
    "reasoning.summary",
)

# Tools & interactions
TOOL_EVENTS = (
    "tool.started",
    "tool.delta",
    "tool.completed",
    "tool.error",
)

INTERACTION_EVENTS = (
    "interaction.requested",
    "interaction.approved",
    "interaction.rejected",
    "interaction.responded",
)

# Monitor / EDA (audit-only in chat UI)
MONITOR_EVENTS = (
    "llm.started",
    "llm.usage",
    "llm.completed",
    "llm.error",
    "eda.started",
    "eda.log",
    "eda.problem_detected",
    "eda.completed",
    "eda.error",
    "vivado.command.started",
    "vivado.command.stdout",
    "vivado.command.stderr",
    "vivado.command.log",
    "vivado.command.completed",
    "vivado.command.error",
    "problem.detected",
    "kb.candidate.created",
    "artifact.created",
    "context.package.created",
    "memory.updated",
)

# Evolution / metrics / feedback / candidates / overlays / trials (SPEC §22.10)
EVOLUTION_EVENTS = (
    "evolution.metric.snapshot",
    "evolution.feedback.created",
    "evolution.signal.fired",
    "evolution.candidate.created",
    "evolution.candidate.updated",
    "evolution.candidate.approved",
    "evolution.candidate.rejected",
    "evolution.candidate.merged",
    "evolution.candidate.rolled_back",
    "evolution.overlay.applied",
    "evolution.overlay.retired",
    # SE-PR5 — A/B trial engine
    "evolution.trial.started",
    "evolution.trial.assigned",
    "evolution.trial.completed",
    "evolution.trial.reverted",
)

ALL_WIRE_EVENT_TYPES: tuple[str, ...] = (
    *LIFECYCLE_EVENTS,
    *MESSAGE_EVENTS,
    *TOOL_EVENTS,
    *INTERACTION_EVENTS,
    *MONITOR_EVENTS,
    *EVOLUTION_EVENTS,
)

# Legacy / internal type → AG-UI–style canonical category
CANONICAL_BY_WIRE_TYPE: dict[str, str] = {
    "message.user.created": "TEXT_MESSAGE",
    "message.assistant.delta": "TEXT_MESSAGE_CONTENT",
    "message.assistant.completed": "TEXT_MESSAGE_END",
    "message.assistant.stopped": "TEXT_MESSAGE_END",
    "message.assistant.snapshot": "TEXT_MESSAGE",
    "assistant.stream.opened": "TEXT_MESSAGE_START",
    "assistant.stream.completed": "TEXT_MESSAGE_END",
    "reasoning.delta": "REASONING_MESSAGE_CONTENT",
    "reasoning.summary": "REASONING_MESSAGE_END",
    "tool.started": "TOOL_CALL_START",
    "tool.delta": "TOOL_CALL_ARGS",
    "tool.completed": "TOOL_CALL_END",
    "tool.error": "RUN_ERROR",
    "interaction.requested": "TOOL_CALL_START",
    "interaction.approved": "TOOL_CALL_RESULT",
    "interaction.rejected": "TOOL_CALL_RESULT",
    "interaction.responded": "TOOL_CALL_RESULT",
    "task.started": "RUN_STARTED",
    "task.done": "RUN_FINISHED",
    "task.error": "RUN_ERROR",
    "task.stopped": "RUN_FINISHED",
    "task.stopping": "RUN_STARTED",
}
