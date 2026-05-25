import type { Message, SessionEvent, Task } from '../api/types'
import { toEventEnvelope } from '../lib/events/envelope'
import { CHAT_ENTRY_KINDS } from '../lib/events/catalog'
import {
  cloneStateForEvent,
  insertEntry,
  removeKeys,
  type ApplyEventOptions,
} from './context'
import { resolveTimelineEventHandler } from './handlers'
import type {
  AssistantTextPayload,
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

/** Drop optimistic user bubbles after send failure or server ack. */
export function removeOptimisticUserEntries(state: SessionTimelineState): SessionTimelineState {
  return removeKeys(state, (k) => k.startsWith('optimistic-user:'))
}

function taskHasCompleteAssistant(state: SessionTimelineState, taskId: string): boolean {
  return state.entries.some((e) => {
    if (e.kind !== 'assistant_text' || e.taskId !== taskId) return false
    const p = e.payload as AssistantTextPayload
    return !p.partial
  })
}

/** When event stream was truncated, backfill assistant text from messages table. */
export function mergeAssistantMessagesFromDb(
  state: SessionTimelineState,
  messages: Message[],
): SessionTimelineState {
  let next = state
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.task_id || !m.content?.trim()) continue
    if (taskHasCompleteAssistant(next, m.task_id)) continue
    const key = `assistant:msg:${m.id}`
    if (next.indexByKey[key] !== undefined) continue
    const entry: TimelineEntry = {
      key,
      id: key,
      seq: m.created_at || next.lastSeq,
      kind: 'assistant_text',
      taskId: m.task_id,
      createdAt: m.created_at,
      payload: {
        streamId: `msg:${m.id}`,
        text: m.content,
        partial: false,
      } satisfies AssistantTextPayload,
    }
    next = insertEntry(next, entry)
  }
  return next
}

function sliceHasWork(entries: TimelineEntry[]): boolean {
  return entries.some((e) => e.kind === 'tool' || e.kind === 'reasoning' || e.kind === 'interaction')
}

/** Legacy sessions: tool-only turns with no assistant completion event. */
export function ensureEmptyTurnPlaceholders(state: SessionTimelineState): SessionTimelineState {
  const chat = getChatEntries(state)
  let next = state
  for (let i = 0; i < chat.length; i++) {
    const user = chat[i]
    if (user.kind !== 'user') continue
    const slice: TimelineEntry[] = []
    let j = i + 1
    while (j < chat.length && chat[j].kind !== 'user') {
      slice.push(chat[j])
      j++
    }
    if (!slice.length || !sliceHasWork(slice)) continue
    const hasFinal = slice.some((e) => {
      if (e.kind !== 'assistant_text') return false
      return !(e.payload as AssistantTextPayload).partial
    })
    if (hasFinal) continue
    const taskId = slice.find((e) => e.taskId)?.taskId ?? user.taskId
    const key = `assistant:empty:${taskId || user.id}`
    if (next.indexByKey[key] !== undefined) continue
    const lastSeq = slice.reduce((max, e) => Math.max(max, e.seq), user.seq)
    const entry: TimelineEntry = {
      key,
      id: key,
      seq: lastSeq + 1,
      kind: 'assistant_text',
      taskId,
      createdAt: slice[slice.length - 1]?.createdAt ?? user.createdAt,
      payload: {
        streamId: key,
        text: '',
        partial: false,
        emptyTurn: true,
      } satisfies AssistantTextPayload,
    }
    next = insertEntry(next, entry)
  }
  return next
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

/** Rebuild chat timeline from events + messages (user rows + assistant DB fallback). */
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
  state = mergeAssistantMessagesFromDb(state, messages)
  state = ensureEmptyTurnPlaceholders(state)
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
