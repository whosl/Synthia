import type { Message, SessionEvent, Task } from '../api/types'
import { toEventEnvelope } from '../lib/events/envelope'
import { CHAT_ENTRY_KINDS } from '../lib/events/catalog'
import {
  cloneStateForEvent,
  insertEntry,
  type ApplyEventOptions,
} from './context'
import { resolveTimelineEventHandler } from './handlers'
import type {
  InteractionEntryPayload,
  SessionTimelineState,
  TimelineEntry,
  UserEntryPayload,
} from './types'
import { emptyTimelineState } from './types'

export type { ApplyEventOptions } from './context'
export { registerTimelineEventHandler } from './handlers'

export function applyTimelineEvent(
  state: SessionTimelineState,
  event: SessionEvent,
  options: ApplyEventOptions = {},
): SessionTimelineState {
  if (
    !options.ignoreSeqGuard
    && event.event_type !== 'message.user.created'
    && event.seq
    && event.seq <= state.lastSeq
  ) {
    return state
  }

  const envelope = toEventEnvelope(event)
  const payload = event.payload || {}
  const ctx = {
    state: cloneStateForEvent(state, event),
    envelope,
    event,
    payload,
    text: String(payload.text || ''),
    taskId: event.task_id || String(payload.task_id || '') || null,
    options,
  }

  const handler = resolveTimelineEventHandler(event.event_type)
  return handler(ctx)
}

/** Optimistic user bubble before server ack (negative seq → sorts before confirmed messages). */
export function applyOptimisticUser(
  state: SessionTimelineState,
  text: string,
): SessionTimelineState {
  const optimisticId = `optimistic-user:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const entry: TimelineEntry = {
    key: optimisticId,
    id: optimisticId,
    seq: -(Date.now()),
    kind: 'user',
    taskId: null,
    createdAt: Math.floor(Date.now() / 1000),
    payload: { text, messageId: optimisticId } satisfies UserEntryPayload,
  }
  return insertEntry(state, entry)
}

export function mergePendingInteractions(
  state: SessionTimelineState,
  pending: Record<string, unknown>[],
): SessionTimelineState {
  let next = state
  for (const raw of pending) {
    const iid = String(raw.id || raw.interaction_id || '')
    if (!iid) continue
    const key = `interaction:${iid}`
    if (next.indexByKey[key] !== undefined) {
      const existing = next.entries[next.indexByKey[key]].payload as InteractionEntryPayload
      if (existing.status === 'pending') continue
    }
    const taskId = String(raw.task_id || '') || null
    const interactionPayload: InteractionEntryPayload = {
      interaction_type: (raw.interaction_type as 'approval' | 'input_request') || 'approval',
      title: String(raw.title || ''),
      message: String(raw.message || ''),
      reason: String(raw.reason || ''),
      status: 'pending',
      files: raw.files as InteractionEntryPayload['files'],
      fields: raw.fields as InteractionEntryPayload['fields'],
    }
    const entry: TimelineEntry = {
      key,
      id: iid,
      seq: Number(raw.created_at) || next.lastSeq + 1,
      kind: 'interaction',
      taskId,
      createdAt: Number(raw.created_at) || undefined,
      payload: interactionPayload,
    }
    next = insertEntry(next, entry)
  }
  return next
}

/** Rebuild chat timeline from events (canonical). Messages table supplies user rows only; assistant text comes from events. */
export function rebuildTimelineFromSources(
  events: SessionEvent[],
  messages: Message[],
  pending: Record<string, unknown>[],
  activeTask?: Task | null,
): SessionTimelineState {
  const sorted = [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))
  let state = emptyTimelineState()
  for (const evt of sorted) {
    state = applyTimelineEvent(state, evt, { appendAssistantDelta: true, ignoreSeqGuard: true })
  }
  for (const m of messages) {
    if (m.role !== 'user') continue
    const mid = m.id
    const key = `user:${mid}`
    if (state.indexByKey[key] !== undefined) continue
    const entry: TimelineEntry = {
      key,
      id: mid,
      seq: m.created_at || 0,
      kind: 'user',
      taskId: m.task_id ?? null,
      createdAt: m.created_at,
      payload: { text: m.content, messageId: mid },
    }
    state = insertEntry(state, entry)
  }
  state = mergePendingInteractions(state, pending)
  if (activeTask) {
    state.activeTaskId = activeTask.id
    state.taskState = activeTask.state
  }
  return state
}

export function getChatEntries(state: SessionTimelineState): TimelineEntry[] {
  const kinds = new Set<string>(CHAT_ENTRY_KINDS)
  return state.entries.filter((e) => kinds.has(e.kind))
}
