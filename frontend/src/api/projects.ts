import { jsonBody, request } from './client'
import type { Project } from './types'

export function listProjects(params: { status?: string; limit?: number; include_archived?: boolean } = {}) {
  const qs = new URLSearchParams()
  if (params.status) qs.set('status', params.status)
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.include_archived) qs.set('include_archived', 'true')
  return request<{ projects: Project[] }>(`/projects${qs.size ? `?${qs}` : ''}`)
}

export function getProject(id: string) {
  return request<{ project: Project }>(`/projects/${id}`)
}

export type CreateProjectPayload = {
  name: string
  root_path: string
  manifest_path: string
  xpr_path?: string
  part?: string
  board_part?: string
  top_module?: string
  target_language?: string
  simulator?: string
  metadata?: Record<string, unknown>
}

export function createProject(payload: CreateProjectPayload) {
  return request<{ project: Project }>('/projects', { method: 'POST', ...jsonBody(payload) })
}

export function updateProject(
  id: string,
  payload: Partial<CreateProjectPayload> & { status?: string },
) {
  return request<{ project: Project }>(`/projects/${id}`, { method: 'PATCH', ...jsonBody(payload) })
}

export function deleteProject(id: string, hard = false) {
  return request<{ ok: boolean }>(`/projects/${id}${hard ? '?hard=true' : ''}`, { method: 'DELETE' })
}

export function listMigrationConflicts(limit = 100) {
  return request<{ sessions: import('./types').Session[]; count: number }>(`/migration/conflicts?limit=${limit}`)
}

export function resolveMigration(sessionId: string, projectId: string) {
  return request<{ session: import('./types').Session }>(
    `/migration/sessions/${sessionId}/resolve`,
    { method: 'POST', ...jsonBody({ project_id: projectId }) },
  )
}

export function listProjectSessions(projectId: string, params: { limit?: number } = {}) {
  const qs = new URLSearchParams()
  if (params.limit) qs.set('limit', String(params.limit))
  return request<{ sessions: import('./types').Session[] }>(
    `/projects/${projectId}/sessions${qs.size ? `?${qs}` : ''}`,
  )
}

export function createProjectSession(projectId: string, payload: { name?: string; metadata?: Record<string, unknown> }) {
  return request<{ session: import('./types').Session }>(
    `/projects/${projectId}/sessions`,
    { method: 'POST', ...jsonBody(payload) },
  )
}
