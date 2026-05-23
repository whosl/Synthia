import { request } from './client'
import type { Message } from './types'

export function listMessages(sessionId: string, limit: number = 200) {
  const qs = new URLSearchParams()
  if (limit) qs.set('limit', String(limit))
  return request<{ messages: Message[] }>(`/sessions/${sessionId}/messages${qs.size ? `?${qs}` : ''}`)
}
