import type { TimelineEventHandler } from './types'
import {
  handleArtifactCreatedChat,
  handleCustomRunCard,
  handleIntentClassified,
  handleMissingInfoRequired,
  handlePatchProposed,
  handleRunOrchestrationEvent,
} from './chatOrchestration'
import {
  auditOnly,
  handleAssistantStreamCompleted,
  handleAssistantStreamOpened,
  handleCustomOrExtension,
  handleInteractionRequested,
  handleInteractionResolved,
  handleMessageAssistantCompleted,
  handleMessageAssistantDelta,
  handleMessageAssistantSnapshot,
  handleMessageAssistantStopped,
  handleMessageUserCreated,
  handleReasoningDelta,
  handleTaskCreatedOrStarted,
  handleTaskDone,
  handleTaskError,
  handleTaskStopped,
  handleTaskStopping,
  handleToolCompleted,
  handleToolError,
  handleToolStarted,
} from './builtin'

const builtinHandlers: Record<string, TimelineEventHandler> = {
  'message.user.created': handleMessageUserCreated,
  'task.created': handleTaskCreatedOrStarted,
  'task.started': handleTaskCreatedOrStarted,
  'task.stopping': handleTaskStopping,
  'task.stopped': handleTaskStopped,
  'task.done': handleTaskDone,
  'task.error': handleTaskError,
  'assistant.stream.opened': handleAssistantStreamOpened,
  'assistant.stream.completed': handleAssistantStreamCompleted,
  'message.assistant.snapshot': handleMessageAssistantSnapshot,
  'message.assistant.delta': handleMessageAssistantDelta,
  'message.assistant.completed': handleMessageAssistantCompleted,
  'message.assistant.stopped': handleMessageAssistantStopped,
  'reasoning.delta': handleReasoningDelta,
  'tool.started': handleToolStarted,
  'tool.completed': handleToolCompleted,
  'tool.error': handleToolError,
  'interaction.requested': handleInteractionRequested,
  'interaction.approved': handleInteractionResolved,
  'interaction.rejected': handleInteractionResolved,
  'interaction.responded': handleInteractionResolved,
  'intent.classified': handleIntentClassified,
  'missing_info_required': handleMissingInfoRequired,
  'artifact.created': handleArtifactCreatedChat,
  'patch.proposed': handlePatchProposed,
  'patch.proposal.created': handlePatchProposed,
  'run.created': handleRunOrchestrationEvent,
  'run.queued': handleRunOrchestrationEvent,
  'run.started': handleRunOrchestrationEvent,
  'run.succeeded': handleRunOrchestrationEvent,
  'run.failed': handleRunOrchestrationEvent,
  'run.cancelled': handleRunOrchestrationEvent,
  'custom.run': handleCustomRunCard,
}

const extensionHandlers = new Map<string, TimelineEventHandler>()

export function registerTimelineEventHandler(
  wireTypes: string | string[],
  handler: TimelineEventHandler,
): void {
  for (const t of Array.isArray(wireTypes) ? wireTypes : [wireTypes]) {
    extensionHandlers.set(t, handler)
  }
}

export function resolveTimelineEventHandler(wireType: string): TimelineEventHandler {
  if (extensionHandlers.has(wireType)) return extensionHandlers.get(wireType)!
  if (builtinHandlers[wireType]) return builtinHandlers[wireType]
  if (wireType.startsWith('custom.')) return handleCustomOrExtension
  return auditOnly
}

/** Wire types with explicit handlers (for SSE subscription discovery). */
export function getRegisteredWireEventTypes(): string[] {
  return [...new Set([...Object.keys(builtinHandlers), ...extensionHandlers.keys()])]
}
