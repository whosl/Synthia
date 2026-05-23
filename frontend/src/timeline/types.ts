import type { Task } from '../api/types'

/** Canonical chat timeline entry — ordered only by `seq`. */
export type TimelineEntryKind =
  | 'user'
  | 'assistant_text'
  | 'reasoning'
  | 'tool'
  | 'interaction'

export interface UserEntryPayload {
  text: string
  messageId: string
}

export interface AssistantTextPayload {
  streamId: string
  text: string
  partial?: boolean
  stopped?: boolean
}

export interface ReasoningEntryPayload {
  text: string
  state: 'running' | 'done'
}

export interface ToolEntryPayload {
  toolcallId: string
  name: string
  state: 'running' | 'completed' | 'error' | 'rejected' | 'stopped'
  args?: string
  result?: string
  startedAt?: number
  elapsedMs?: number
}

export interface InteractionEntryPayload {
  interaction_type: 'approval' | 'input_request'
  title: string
  message: string
  reason?: string
  status: 'pending' | 'approved' | 'rejected' | 'responded'
  files?: Array<{ path: string; content: string; description?: string; action: string }>
  fields?: Array<{
    id: string
    label: string
    field_type: string
    options?: Array<{ value: string; label: string }>
    placeholder?: string
    recommendations?: string[]
    required?: boolean
  }>
  response?: Record<string, unknown>
}

export type TimelineEntryPayload =
  | UserEntryPayload
  | AssistantTextPayload
  | ReasoningEntryPayload
  | ToolEntryPayload
  | InteractionEntryPayload

export interface TimelineEntry {
  /** Stable key for upsert (user:id, assistant:taskId, tool:id, …) */
  key: string
  id: string
  seq: number
  kind: TimelineEntryKind
  taskId: string | null
  createdAt?: number
  payload: TimelineEntryPayload
}

export interface AuditLogItem {
  id: string
  seq?: number
  type: string
  title: string
  detail?: string
  state?: string
  createdAt?: number
}

export interface SessionTimelineState {
  entries: TimelineEntry[]
  indexByKey: Record<string, number>
  lastSeq: number
  activeTaskId: string | null
  taskState?: Task['state']
  auditLog: AuditLogItem[]
  /** Flat tool list for debug drawer (latest state per tool id). */
  tools: ToolEntryPayload[]
  /** Latest stream_id from assistant.stream.opened (per task). */
  activeStreamByTask: Record<string, string>
  /** Legacy replay only: segment counter when events lack stream_id. */
  legacySegmentByTask: Record<string, number>
}

export const emptyTimelineState = (): SessionTimelineState => ({
  entries: [],
  indexByKey: {},
  lastSeq: 0,
  activeTaskId: null,
  auditLog: [],
  tools: [],
  activeStreamByTask: {},
  legacySegmentByTask: {},
})
