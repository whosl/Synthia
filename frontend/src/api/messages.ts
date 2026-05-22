import { request } from './client'
import type { Message } from './types'

export function listMessages(sessionId: string, params: { before?: number; limit?: number } = {}) {
  const qs = new URLSearchParams()
  if (params.before) qs.set('before', String(params.before))
  if (params.limit) qs.set('limit', String(params.limit))
  return request<{ messages: Message[] }>(`/sessions/${sessionId}/messages${qs.size ? `?${qs}` : ''}`)
}
