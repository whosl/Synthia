import { request, streamUrl } from './client'
import type { SessionEvent } from './types'
import { PROTOCOL_VERSION } from '../lib/events/catalog'

export function normalizeEvent(event: SessionEvent): SessionEvent {
  let base = event
  if (!event.payload && event.payload_json) {
    try {
      base = { ...event, payload: JSON.parse(event.payload_json) }
    } catch {
      base = { ...event, payload: { raw: event.payload_json } }
    }
  } else if (!event.payload) {
    base = { ...event, payload: {} }
  }
  const protocol_version = base.protocol_version ?? PROTOCOL_VERSION
  const canonical_type =
    base.canonical_type
    ?? (base.event_type.startsWith('custom.') ? 'CUSTOM' : undefined)
  return {
    ...base,
    protocol_version,
    ...(canonical_type ? { canonical_type } : {}),
  }
}

export async function listEvents(sessionId: string, afterSeq = 0, limit = 500, recent = false) {
  const recentQ = recent ? '&recent=1' : ''
  const data = await request<{ events: SessionEvent[] }>(
    `/sessions/${sessionId}/events?after_seq=${afterSeq}&limit=${limit}${recentQ}`,
  )
  return { events: data.events.map(normalizeEvent) }
}

export async function fetchEventProtocol(): Promise<{ protocol_version: number; wire_event_types: string[] }> {
  return request('/events/protocol')
}

export function getSessionStreamUrl(sessionId: string, afterSeq = 0) {
  return streamUrl(`/sessions/${sessionId}/stream?after_seq=${afterSeq}`)
}
