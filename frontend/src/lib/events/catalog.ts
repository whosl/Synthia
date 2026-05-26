/**
 * Wire event catalog — keep in sync with src/edagent_vivado/events/catalog.py
 */
export const PROTOCOL_VERSION = 1

export const LIFECYCLE_EVENTS = [
  'session.created',
  'session.updated',
  'session.archived',
  'task.created',
  'task.started',
  'task.stopping',
  'task.stopped',
  'task.done',
  'task.error',
  'task.plan.generated',
  'run.started',
  'run.completed',
  'run.error',
] as const

export const MESSAGE_EVENTS = [
  'message.user.created',
  'message.assistant.delta',
  'message.assistant.completed',
  'message.assistant.stopped',
  'message.assistant.snapshot',
  'assistant.stream.opened',
  'assistant.stream.completed',
  'reasoning.delta',
  'reasoning.summary',
] as const

export const TOOL_EVENTS = [
  'tool.started',
  'tool.delta',
  'tool.completed',
  'tool.error',
] as const

export const INTERACTION_EVENTS = [
  'interaction.requested',
  'interaction.approved',
  'interaction.rejected',
  'interaction.responded',
] as const

export const CONNECTOR_EVENTS = [
  'run.step.started',
  'run.step.completed',
  'run.step.failed',
  'connector.health.checked',
  'connector.capability.invoked',
  'report.parsed.created',
  'patch.proposal.created',
  'patch.proposal.applied',
  'patch.proposal.rejected',
] as const

export const MONITOR_EVENTS = [
  'llm.started',
  'llm.usage',
  'llm.completed',
  'llm.error',
  'eda.started',
  'eda.log',
  'eda.problem_detected',
  'eda.completed',
  'eda.error',
  'vivado.command.started',
  'vivado.command.stdout',
  'vivado.command.stderr',
  'vivado.command.log',
  'vivado.command.completed',
  'vivado.command.error',
  'problem.detected',
  'kb.candidate.created',
  'artifact.created',
  'context.package.created',
  'memory.updated',
] as const

/** All event types the backend may emit on SSE (used for subscriptions). */
export const ALL_WIRE_EVENT_TYPES: readonly string[] = [
  ...LIFECYCLE_EVENTS,
  ...MESSAGE_EVENTS,
  ...TOOL_EVENTS,
  ...INTERACTION_EVENTS,
  ...CONNECTOR_EVENTS,
  ...MONITOR_EVENTS,
]

export const CANONICAL_BY_WIRE_TYPE: Record<string, string> = {
  'message.user.created': 'TEXT_MESSAGE',
  'message.assistant.delta': 'TEXT_MESSAGE_CONTENT',
  'message.assistant.completed': 'TEXT_MESSAGE_END',
  'message.assistant.stopped': 'TEXT_MESSAGE_END',
  'message.assistant.snapshot': 'TEXT_MESSAGE',
  'assistant.stream.opened': 'TEXT_MESSAGE_START',
  'assistant.stream.completed': 'TEXT_MESSAGE_END',
  'reasoning.delta': 'REASONING_MESSAGE_CONTENT',
  'reasoning.summary': 'REASONING_MESSAGE_END',
  'tool.started': 'TOOL_CALL_START',
  'tool.delta': 'TOOL_CALL_ARGS',
  'tool.completed': 'TOOL_CALL_END',
  'tool.error': 'RUN_ERROR',
  'interaction.requested': 'TOOL_CALL_START',
  'interaction.approved': 'TOOL_CALL_RESULT',
  'interaction.rejected': 'TOOL_CALL_RESULT',
  'interaction.responded': 'TOOL_CALL_RESULT',
  'task.started': 'RUN_STARTED',
  'task.done': 'RUN_FINISHED',
  'task.error': 'RUN_ERROR',
  'task.stopped': 'RUN_FINISHED',
  'task.stopping': 'RUN_STARTED',
}

export function toCanonicalType(wireType: string): string {
  if (wireType.startsWith('custom.')) return 'CUSTOM'
  return CANONICAL_BY_WIRE_TYPE[wireType] ?? 'RAW'
}

/** Chat-visible timeline entry kinds */
export const CHAT_ENTRY_KINDS = [
  'user',
  'assistant_text',
  'reasoning',
  'tool',
  'interaction',
  'custom',
] as const
