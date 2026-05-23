import { request, streamUrl } from './client'
import type { SessionEvent } from './types'

export function normalizeEvent(event: SessionEvent): SessionEvent {
  if (event.payload) return event
  if (!event.payload_json) return { ...event, payload: {} }
  try { return { ...event, payload: JSON.parse(event.payload_json) } }
  catch { return { ...event, payload: { raw: event.payload_json } } }
}

export async function listEvents(sessionId: string, afterSeq = 0, limit = 500, recent = false) {
  const recentQ = recent ? '&recent=1' : ''
  const data = await request<{ events: SessionEvent[] }>(
    `/sessions/${sessionId}/events?after_seq=${afterSeq}&limit=${limit}${recentQ}`,
  )
  return { events: data.events.map(normalizeEvent) }
}

export function getSessionStreamUrl(sessionId: string, afterSeq = 0) {
  return streamUrl(`/sessions/${sessionId}/stream?after_seq=${afterSeq}`)
}
