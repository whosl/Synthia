import type { SessionEvent } from '../api/types'
import type { SessionTimelineState } from './types'

export function assistantEntryKey(streamId: string): string {
  return `assistant:${streamId}`
}

/** Resolve stream id for delta events (payload stream_id, else legacy segment counter). */
export function resolveStreamId(
  state: SessionTimelineState,
  event: SessionEvent,
  taskId: string,
): string {
  const payload = event.payload || {}
  const explicit = String(payload.stream_id || '')
  if (explicit) return explicit

  const seg = taskId ? (state.legacySegmentByTask[taskId] ?? 0) : 0
  return `${taskId}:legacy:${seg}`
}

export function resolveStreamIdForCompletion(
  state: SessionTimelineState,
  event: SessionEvent,
  taskId: string,
): string {
  const payload = event.payload || {}
  const explicit = String(payload.stream_id || '')
  if (explicit) return explicit
  if (taskId && state.activeStreamByTask[taskId]) return state.activeStreamByTask[taskId]
  return resolveStreamId(state, event, taskId)
}

export function completeAssistantStream(
  state: SessionTimelineState,
  streamId: string,
  opts: { stopped?: boolean } = {},
): SessionTimelineState {
  const key = assistantEntryKey(streamId)
  const idx = state.indexByKey[key]
  if (idx === undefined) return state
  const entries = [...state.entries]
  const prev = entries[idx].payload as { streamId: string; text: string; partial?: boolean; stopped?: boolean }
  entries[idx] = {
    ...entries[idx],
    payload: {
      ...prev,
      partial: false,
      stopped: opts.stopped ?? prev.stopped,
    },
  }
  return { ...state, entries }
}
