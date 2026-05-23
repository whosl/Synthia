import { jsonBody, request } from './client'
import type { Session } from './types'

export function listSessions(params: { status?: string; limit?: number; project_id?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.status) qs.set('status', params.status)
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.project_id) qs.set('project_id', params.project_id)
  return request<{ sessions: Session[] }>(`/sessions${qs.size ? `?${qs}` : ''}`)
}

export function createSession(payload: {
  name?: string
  project_id: string
  manifest_path?: string
  metadata?: Record<string, unknown>
}) {
  return request<{ session: Session }>('/sessions', { method: 'POST', ...jsonBody(payload) })
}

export function getSession(id: string) {
  return request<{ session: Session }>(`/sessions/${id}`)
}

export function updateSession(id: string, payload: Partial<Pick<Session, 'name' | 'status'>>) {
  return request<{ session: Session }>(`/sessions/${id}`, { method: 'PATCH', ...jsonBody(payload) })
}

export function deleteSession(id: string, hard = false) {
  return request<{ ok: boolean }>(`/sessions/${id}${hard ? '?hard=true' : ''}`, { method: 'DELETE' })
}
