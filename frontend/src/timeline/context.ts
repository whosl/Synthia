import type { SessionEvent } from '../api/types'
import type { EventEnvelope } from '../lib/events/envelope'
import type {
  AssistantTextPayload,
  AuditLogItem,
  InteractionEntryPayload,
  ReasoningEntryPayload,
  SessionTimelineState,
  TimelineEntry,
  ToolEntryPayload,
  UserEntryPayload,
} from './types'
import { assistantEntryKey } from './streamId'

export type ApplyEventOptions = {
  appendAssistantDelta?: boolean
  ignoreSeqGuard?: boolean
}

export interface TimelineHandlerContext {
  state: SessionTimelineState
  envelope: EventEnvelope
  event: SessionEvent
  payload: Record<string, unknown>
  text: string
  taskId: string | null
  options: ApplyEventOptions
}

export function pushAudit(
  state: SessionTimelineState,
  event: SessionEvent,
  title: string,
  detail?: string,
  auditState?: string,
) {
  const item: AuditLogItem = {
    id: event.id,
    seq: event.seq,
    type: event.event_type,
    title,
    detail,
    state: auditState,
    createdAt: event.created_at,
  }
  state.auditLog.push(item)
}

export function upsertToolList(tools: ToolEntryPayload[], tool: ToolEntryPayload): ToolEntryPayload[] {
  const idx = tools.findIndex((t) => t.toolcallId === tool.toolcallId)
  if (idx < 0) return [...tools, tool]
  const next = [...tools]
  next[idx] = tool
  return next
}

export function eventTimeMs(createdAt: number | undefined): number {
  if (!createdAt) return Date.now()
  return createdAt > 1e12 ? createdAt : createdAt * 1000
}

export function toolStartedAtMs(payload: Record<string, unknown>, event: SessionEvent): number | undefined {
  if (payload.started_at_ms != null) return Number(payload.started_at_ms)
  if (payload.started_at != null) return Number(payload.started_at) * 1000
  if (event.created_at) return eventTimeMs(event.created_at)
  return undefined
}

export function insertEntry(state: SessionTimelineState, entry: TimelineEntry): SessionTimelineState {
  const entries = [...state.entries, entry].sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key))
  const indexByKey: Record<string, number> = {}
  entries.forEach((e, i) => { indexByKey[e.key] = i })
  return { ...state, entries, indexByKey }
}

export function updateEntry(
  state: SessionTimelineState,
  key: string,
  updater: (entry: TimelineEntry) => TimelineEntry,
): SessionTimelineState {
  const idx = state.indexByKey[key]
  if (idx === undefined) return state
  const entries = [...state.entries]
  entries[idx] = updater(entries[idx])
  return { ...state, entries }
}

export function appendAssistantDelta(
  state: SessionTimelineState,
  taskId: string,
  streamId: string,
  text: string,
  event: SessionEvent,
): SessionTimelineState {
  const key = assistantEntryKey(streamId)
  const idx = state.indexByKey[key]
  let next: SessionTimelineState = {
    ...state,
    activeStreamByTask: { ...state.activeStreamByTask, [taskId]: streamId },
  }
  if (idx !== undefined) {
    next = updateEntry(next, key, (e) => {
      const p = e.payload as AssistantTextPayload
      return { ...e, payload: { ...p, text: p.text + text, partial: true } }
    })
  } else {
    const entry: TimelineEntry = {
      key,
      id: key,
      seq: event.seq || next.lastSeq,
      kind: 'assistant_text',
      taskId,
      createdAt: event.created_at,
      payload: { streamId, text, partial: true } satisfies AssistantTextPayload,
    }
    next = insertEntry(next, entry)
  }
  return next
}

export function removeKeys(state: SessionTimelineState, predicate: (key: string) => boolean): SessionTimelineState {
  const entries = state.entries.filter((e) => !predicate(e.key))
  const indexByKey: Record<string, number> = {}
  entries.forEach((e, i) => { indexByKey[e.key] = i })
  return { ...state, entries, indexByKey }
}

export function cloneStateForEvent(state: SessionTimelineState, event: SessionEvent): SessionTimelineState {
  return {
    ...state,
    entries: [...state.entries],
    indexByKey: { ...state.indexByKey },
    auditLog: [...state.auditLog],
    tools: [...state.tools],
    activeStreamByTask: { ...state.activeStreamByTask },
    legacySegmentByTask: { ...state.legacySegmentByTask },
    lastSeq: Math.max(state.lastSeq, event.seq || 0),
  }
}

export type { UserEntryPayload, AssistantTextPayload, ReasoningEntryPayload, ToolEntryPayload, InteractionEntryPayload }
