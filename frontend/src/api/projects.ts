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

export type ProjectSummary = {
  project: Project
  kb: { sources: number; chunks: number }
  kb_recent_sources: Array<{ id: string; title: string; path?: string; source_type?: string }>
  sessions: { active: number; archived: number }
  vivado_health: {
    target_id?: string
    reachable?: boolean
    host?: string
    version?: string | null
    error?: string
    checked_at?: number
  }
}

export function getProjectSummary(id: string) {
  return request<ProjectSummary>(`/projects/${id}/summary`)
}

export function reindexProject(id: string) {
  return request<{ indexed_sources: number; chunks: number; project_id: string }>(
    `/projects/${id}/reindex`,
    { method: 'POST' },
  )
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
  source_globs?: string[]
  constraint_globs?: string[]
  tcl_globs?: string[]
  default_vivado_target_id?: string
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

export function deleteProject(id: string, hard = false, confirmName?: string) {
  const qs = new URLSearchParams()
  if (hard) qs.set('hard', 'true')
  if (confirmName) qs.set('confirm', confirmName)
  const q = qs.size ? `?${qs}` : ''
  return request<{ ok: boolean }>(`/projects/${id}${q}`, { method: 'DELETE' })
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

export function listProjectSessions(
  projectId: string,
  params: { limit?: number; include_archived?: boolean } = {},
) {
  const qs = new URLSearchParams()
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.include_archived) qs.set('include_archived', 'true')
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

export type ScanProjectResult = {
  root: string
  is_likely_fpga_project: boolean
  xpr_files: string[]
  rtl_files: string[]
  sv_files: string[]
  vhd_files: string[]
  xdc_files: string[]
  ip_files: string[]
  bd_files: string[]
  candidate_top_modules: string[]
  detected_part: string
}

export function importXpr(xpr_path: string, auto_register = true) {
  return request<{
    ok: boolean
    project_id?: string
    manifest_path?: string
    project?: Project
    warnings?: string[]
  }>('/projects/import-xpr', { method: 'POST', ...jsonBody({ xpr_path, auto_register }) })
}

export function scanProject(root_path: string) {
  return request<ScanProjectResult>('/projects/scan', { method: 'POST', ...jsonBody({ root_path }) })
}

export function createProjectFromWizard(payload: {
  name: string
  location: string
  part?: string
  board_part?: string
  top_module?: string
  target_language?: string
  rtl_sources?: string[]
  xdc_sources?: string[]
  tb_sources?: string[]
  copy_sources?: boolean
}) {
  return request<{ ok: boolean; project_id: string; manifest_path: string; project: Project }>(
    '/projects/from-wizard',
    { method: 'POST', ...jsonBody(payload) },
  )
}

export function getProjectHealth(projectId: string) {
  return request<{ project_id: string; status: string; detail: string; last_check_at: number }>(
    `/projects/${projectId}/health`,
  )
}

export function syncProjectXpr(projectId: string) {
  return request<{ ok: boolean; manifest_path?: string; warnings?: string[] }>(
    `/projects/${projectId}/sync-xpr`,
    { method: 'POST' },
  )
}
