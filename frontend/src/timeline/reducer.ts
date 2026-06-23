import type { Message, SessionEvent, Task, TranscriptTurnItem, TranscriptTurnRow } from '../api/types'
import { toEventEnvelope } from '../lib/events/envelope'
import { CHAT_ENTRY_KINDS } from '../lib/events/catalog'
import {
  cloneStateForEvent,
  insertEntriesBatch,
  insertEntry,
  removeKeys,
  setTimelineRebuildBatch,
  sortTimelineEntries,
  type ApplyEventOptions,
} from './context'
import { resolveTimelineEventHandler } from './handlers'
import type {
  AssistantTextPayload,
  CustomEntryPayload,
  ErrorEntryPayload,
  InteractionEntryPayload,
  ReasoningEntryPayload,
  SessionTimelineState,
  TimelineEntry,
  TimelineEntryKind,
  TimelineEntryPayload,
  ToolEntryPayload,
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

function assistantTextFromEvents(state: SessionTimelineState, taskId: string): string {
  return state.entries
    .filter((e) => e.kind === 'assistant_text' && e.taskId === taskId)
    .map((e) => (e.payload as AssistantTextPayload).text)
    .join('')
}

function shouldBackfillAssistantFromDb(state: SessionTimelineState, m: Message): boolean {
  if (!m.task_id || !m.content?.trim()) return false
  const fromEvents = assistantTextFromEvents(state, m.task_id)
  if (!fromEvents.trim()) return true
  // Event stream truncated mid-task — DB snapshot is longer
  return m.content.length > fromEvents.length + 20
}

/** Seq slot after turn work, before next user (event seq space, not Unix time). */
export function seqForAssistantBackfill(state: SessionTimelineState, taskId: string): number {
  const userEntry = state.entries.find((e) => e.kind === 'user' && e.taskId === taskId)
  if (!userEntry) {
    const maxInTask = state.entries
      .filter((e) => e.taskId === taskId)
      .reduce((max, e) => Math.max(max, e.seq), 0)
    return maxInTask + 1
  }
  let nextUserSeq = Infinity
  for (const e of state.entries) {
    if (e.kind === 'user' && e.seq > userEntry.seq) {
      nextUserSeq = Math.min(nextUserSeq, e.seq)
    }
  }
  let maxSeq = userEntry.seq
  for (const e of state.entries) {
    if (e.taskId === taskId && e.seq > userEntry.seq && e.seq < nextUserSeq) {
      maxSeq = Math.max(maxSeq, e.seq)
    }
  }
  return maxSeq + 0.01
}

function removeAssistantEntriesForTask(
  state: SessionTimelineState,
  taskId: string,
): SessionTimelineState {
  const entries = state.entries.filter(
    (e) => !(e.kind === 'assistant_text' && e.taskId === taskId),
  )
  const indexByKey: Record<string, number> = {}
  entries.forEach((e, i) => { indexByKey[e.key] = i })
  return { ...state, entries, indexByKey }
}

/** When event stream was truncated, backfill assistant text from messages table. */
export function mergeAssistantMessagesFromDb(
  state: SessionTimelineState,
  messages: Message[],
): SessionTimelineState {
  const toInsert: TimelineEntry[] = []
  let next = state
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.task_id || !m.content?.trim()) continue
    if (!shouldBackfillAssistantFromDb(next, m)) continue
    const key = `assistant:msg:${m.id}`
    if (next.indexByKey[key] !== undefined) continue
    if (assistantTextFromEvents(next, m.task_id).trim()) {
      next = removeAssistantEntriesForTask(next, m.task_id)
    }
    toInsert.push({
      key,
      id: key,
      seq: seqForAssistantBackfill(next, m.task_id),
      kind: 'assistant_text',
      taskId: m.task_id,
      createdAt: m.created_at,
      payload: {
        streamId: `msg:${m.id}`,
        text: m.content,
        partial: false,
      } satisfies AssistantTextPayload,
    })
  }
  return insertEntriesBatch(next, toInsert)
}

function sliceHasWork(entries: TimelineEntry[]): boolean {
  return entries.some((e) => e.kind === 'tool' || e.kind === 'reasoning' || e.kind === 'interaction' || e.kind === 'error')
}

function sliceHasTerminalError(entries: TimelineEntry[]): boolean {
  return entries.some((e) => {
    if (e.kind === 'error') return true
    if (e.kind === 'tool') {
      return (e.payload as { state?: string }).state === 'error'
    }
    return false
  })
}

/** Legacy sessions: tool-only turns with no assistant completion event. */
export function ensureEmptyTurnPlaceholders(
  state: SessionTimelineState,
  activeTaskId?: string | null,
): SessionTimelineState {
  const chat = getChatEntries(state)
  const toInsert: TimelineEntry[] = []
  const seenTasks = new Set<string>()
  for (let i = 0; i < chat.length; i++) {
    const user = chat[i]
    if (user.kind !== 'user') continue
    let slice: TimelineEntry[] = []
    if (user.taskId) {
      if (seenTasks.has(user.taskId)) continue
      seenTasks.add(user.taskId)
      slice = chat.filter((e) => e.kind !== 'user' && e.taskId === user.taskId)
    } else {
      let j = i + 1
      while (j < chat.length && chat[j].kind !== 'user') {
        slice.push(chat[j])
        j++
      }
    }
    if (!slice.length || !sliceHasWork(slice)) continue
    if (sliceHasTerminalError(slice)) continue
    const hasFinal = slice.some((e) => {
      if (e.kind !== 'assistant_text') return false
      return !(e.payload as AssistantTextPayload).partial
    })
    if (hasFinal) continue
    const taskId = slice.find((e) => e.taskId)?.taskId ?? user.taskId
    if (taskId && activeTaskId && taskId === activeTaskId) continue
    const key = `assistant:empty:${taskId || user.id}`
    if (state.indexByKey[key] !== undefined) continue
    const lastSeq = slice.reduce((max, e) => Math.max(max, e.seq), user.seq)
    toInsert.push({
      key,
      id: key,
      seq: lastSeq + 0.01,
      kind: 'assistant_text',
      taskId,
      createdAt: slice[slice.length - 1]?.createdAt ?? user.createdAt,
      payload: {
        streamId: key,
        text: '',
        partial: false,
        emptyTurn: true,
      } satisfies AssistantTextPayload,
    })
  }
  return insertEntriesBatch(state, toInsert)
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

function boolValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function textValue(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function turnItemPayload(item: TranscriptTurnItem): Record<string, unknown> {
  if (item.payload && typeof item.payload === 'object') return item.payload
  if (!item.payload_json) return {}
  try {
    const parsed = JSON.parse(item.payload_json)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { raw: item.payload_json }
  }
}

function normalizeTurnItemPayload(
  item: TranscriptTurnItem,
): { kind: TimelineEntryKind; payload: TimelineEntryPayload } | null {
  const raw = turnItemPayload(item)
  if (item.item_type === 'user') {
    return {
      kind: 'user',
      payload: {
        text: String(raw.text || ''),
        messageId: String(raw.message_id || raw.messageId || item.message_id || item.id),
      } satisfies UserEntryPayload,
    }
  }
  if (item.item_type === 'assistant_text') {
    return {
      kind: 'assistant_text',
      payload: {
        streamId: String(raw.stream_id || raw.streamId || item.stream_id || item.item_key),
        text: String(raw.text || ''),
        partial: boolValue(raw.partial),
        stopped: boolValue(raw.stopped),
        emptyTurn: boolValue(raw.empty_turn ?? raw.emptyTurn),
      } satisfies AssistantTextPayload,
    }
  }
  if (item.item_type === 'reasoning') {
    return {
      kind: 'reasoning',
      payload: {
        text: String(raw.text || raw.summary || ''),
        state: raw.state === 'running' || item.status === 'running' ? 'running' : 'done',
      } satisfies ReasoningEntryPayload,
    }
  }
  if (item.item_type === 'tool') {
    const state = String(raw.state || item.status || 'running') as ToolEntryPayload['state']
    return {
      kind: 'tool',
      payload: {
        toolcallId: String(raw.toolcall_id || raw.toolcallId || item.tool_call_id || item.id),
        name: String(raw.tool_name || raw.name || 'tool'),
        state: ['running', 'completed', 'error', 'rejected', 'stopped'].includes(state) ? state : 'completed',
        args: textValue(raw.args),
        result: textValue(raw.result ?? raw.output),
        error: textValue(raw.error ?? raw.message),
        startedAt: raw.started_at != null ? Number(raw.started_at) : undefined,
        startedAtMs: raw.started_at_ms != null ? Number(raw.started_at_ms) : undefined,
        elapsedMs: raw.elapsed_ms != null ? Number(raw.elapsed_ms) : undefined,
      } satisfies ToolEntryPayload,
    }
  }
  if (item.item_type === 'interaction') {
    return {
      kind: 'interaction',
      payload: {
        interaction_type: (raw.interaction_type || 'approval') as InteractionEntryPayload['interaction_type'],
        title: String(raw.title || ''),
        message: String(raw.message || ''),
        reason: String(raw.reason || ''),
        status: (raw.status || item.status || 'pending') as InteractionEntryPayload['status'],
        files: raw.files as InteractionEntryPayload['files'],
        fields: raw.fields as InteractionEntryPayload['fields'],
        response: raw.response as Record<string, unknown> | undefined,
      } satisfies InteractionEntryPayload,
    }
  }
  if (item.item_type === 'error') {
    return {
      kind: 'error',
      payload: {
        title: String(raw.title || 'Task failed'),
        message: String(raw.message || raw.error || raw.detail || ''),
        source: textValue(raw.source),
      } satisfies ErrorEntryPayload,
    }
  }
  if (item.item_type === 'custom') {
    return {
      kind: 'custom',
      payload: {
        uiKind: String(raw.ui_kind || raw.uiKind || raw.component || 'custom'),
        title: textValue(raw.title),
        data: (raw.data as Record<string, unknown>) ?? raw,
      } satisfies CustomEntryPayload,
    }
  }
  return null
}

function turnItemToTimelineEntry(item: TranscriptTurnItem): TimelineEntry | null {
  const normalized = normalizeTurnItemPayload(item)
  if (!normalized) return null
  return {
    key: item.item_key || `${item.item_type}:${item.id}`,
    id: item.item_key || item.id,
    seq: Number(item.seq || item.created_at || 0),
    kind: normalized.kind,
    taskId: item.task_id ?? null,
    createdAt: item.created_at,
    payload: normalized.payload,
  }
}

function shouldKeepTurnEntry(entry: TimelineEntry): boolean {
  if (entry.kind !== 'assistant_text') return true
  const payload = entry.payload as AssistantTextPayload
  return Boolean(payload.text.trim() || payload.partial || payload.stopped || payload.emptyTurn)
}

export function rebuildTimelineFromTurns(
  turns: TranscriptTurnRow[],
  pending: Record<string, unknown>[] = [],
  activeTask?: Task | null,
  lastEventSeq = 0,
): SessionTimelineState {
  const entries = turns.flatMap((turn) =>
    (turn.items || [])
      .map((item) => turnItemToTimelineEntry(item))
      .filter((entry): entry is TimelineEntry => Boolean(entry)),
  ).filter(shouldKeepTurnEntry)
  let state = insertEntriesBatch(emptyTimelineState(), entries)
  state.lastSeq = Math.max(lastEventSeq, entries.reduce((max, entry) => Math.max(max, entry.seq || 0), 0))
  state.tools = state.entries
    .filter((entry) => entry.kind === 'tool')
    .map((entry) => entry.payload as ToolEntryPayload)
  const activeStreams: Record<string, string> = {}
  for (const entry of state.entries) {
    if (entry.kind !== 'assistant_text' || !entry.taskId) continue
    const payload = entry.payload as AssistantTextPayload
    if (payload.partial && payload.streamId) {
      activeStreams[entry.taskId] = payload.streamId
    }
  }
  state.activeStreamByTask = activeStreams
  if (activeTask) {
    state.activeTaskId = activeTask.id
    state.taskState = activeTask.state
  }
  return mergePendingInteractions(state, pending)
}

/** Rebuild chat timeline from events + messages (user rows + assistant DB fallback). */
export function rebuildTimelineFromSources(
  events: SessionEvent[],
  messages: Message[],
  pending: Record<string, unknown>[],
  activeTask?: Task | null,
): SessionTimelineState {
  const sorted = [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))
  setTimelineRebuildBatch(true)
  let state = emptyTimelineState()
  try {
    for (const evt of sorted) {
      state = applyTimelineEvent(state, evt, { appendAssistantDelta: true, ignoreSeqGuard: true })
    }
    state = sortTimelineEntries(state)
    const userEntries: TimelineEntry[] = []
    for (const m of messages) {
      if (m.role !== 'user') continue
      const mid = m.id
      const key = `user:${mid}`
      if (state.indexByKey[key] !== undefined) continue
      userEntries.push({
        key,
        id: mid,
        seq: m.created_at || 0,
        kind: 'user',
        taskId: m.task_id ?? null,
        createdAt: m.created_at,
        payload: { text: m.content, messageId: mid },
      })
    }
    state = insertEntriesBatch(state, userEntries)
    state = mergeAssistantMessagesFromDb(state, messages)
    if (activeTask) {
      state.activeTaskId = activeTask.id
      state.taskState = activeTask.state
    }
    state = ensureEmptyTurnPlaceholders(state, activeTask?.id)
    state = mergePendingInteractions(state, pending)
    return sortTimelineEntries(state)
  } finally {
    setTimelineRebuildBatch(false)
  }
}

export function getChatEntries(state: SessionTimelineState): TimelineEntry[] {
  const kinds = new Set<string>(CHAT_ENTRY_KINDS)
  return state.entries.filter((e) => kinds.has(e.kind))
}
