import type { SessionEvent } from '../../api/types'
import { PROTOCOL_VERSION, toCanonicalType } from './catalog'

export type CanonicalEventCategory =
  | 'TEXT_MESSAGE'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'REASONING_MESSAGE_CONTENT'
  | 'REASONING_MESSAGE_END'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'TOOL_CALL_RESULT'
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'CUSTOM'
  | 'RAW'

/** Normalized wire event (protocol v1). */
export interface EventEnvelope {
  protocolVersion: number
  wireType: string
  canonicalType: CanonicalEventCategory | string
  seq: number
  id: string
  sessionId: string
  taskId: string | null
  createdAt?: number
  payload: Record<string, unknown>
  /** Original row for handlers that need DB fields */
  raw: SessionEvent
}

export function toEventEnvelope(event: SessionEvent): EventEnvelope {
  const wireType = event.event_type
  const protocolVersion =
    (event as SessionEvent & { protocol_version?: number }).protocol_version ?? PROTOCOL_VERSION
  const canonicalType =
    (event as SessionEvent & { canonical_type?: string }).canonical_type
    ?? toCanonicalType(wireType)

  return {
    protocolVersion,
    wireType,
    canonicalType,
    seq: event.seq ?? 0,
    id: event.id,
    sessionId: event.session_id,
    taskId: (event.task_id ?? String(event.payload?.task_id ?? '')) || null,
    createdAt: event.created_at,
    payload: event.payload ?? {},
    raw: event,
  }
}
