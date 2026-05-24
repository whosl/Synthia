import { jsonBody, request } from './client'

// ── types ──────────────────────────────────────────────────

export type EvolutionSurface = 'kb' | 'prompt' | 'tool' | 'flow_template' | 'routing'

export type EvolutionCandidateStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'merged'
  | 'rolled_back'
  | 'trialing'

export type EvolutionScope = 'session' | 'project' | 'global'

export interface EvolutionCandidate {
  id: string
  scope: EvolutionScope
  project_id?: string | null
  session_id?: string | null
  surface: EvolutionSurface
  candidate_type?: string
  title: string
  rationale?: string | null
  signal_source?: Record<string, unknown>
  signal_source_json?: string | null
  diff_artifact_id?: string | null
  baseline_artifact_id?: string | null
  confidence?: number | null
  status: EvolutionCandidateStatus
  created_by: string
  created_at: number
  reviewed_by?: string | null
  reviewed_at?: number | null
  applied_overlay_id?: string | null
  metadata?: Record<string, unknown>
  metadata_json?: string | null
}

export interface EvolutionOverlay {
  id: string
  scope: 'project' | 'global'
  project_id?: string | null
  surface: EvolutionSurface
  name?: string | null
  state: 'active' | 'shadow' | 'retired'
  payload?: Record<string, unknown>
  payload_json?: string | null
  source_candidate_id?: string | null
  parent_overlay_id?: string | null
  created_at: number
  retired_at?: number | null
  metadata?: Record<string, unknown>
  metadata_json?: string | null
}

// ── candidates ─────────────────────────────────────────────

export function listEvolutionCandidates(
  params: {
    status?: EvolutionCandidateStatus | ''
    surface?: EvolutionSurface | ''
    project_id?: string
    limit?: number
  } = {},
) {
  const qs = new URLSearchParams()
  if (params.status !== undefined) qs.set('status', params.status)
  if (params.surface) qs.set('surface', params.surface)
  if (params.project_id) qs.set('project_id', params.project_id)
  if (params.limit) qs.set('limit', String(params.limit))
  return request<{
    candidates: EvolutionCandidate[]
    filters: Record<string, string | null>
    count: number
  }>(`/evolution/candidates${qs.size ? `?${qs}` : ''}`)
}

export function getEvolutionCandidate(id: string) {
  return request<{ candidate: EvolutionCandidate }>(`/evolution/candidates/${id}`)
}

export function approveEvolutionCandidate(
  id: string,
  body: { reviewed_by?: string; payload?: Record<string, unknown> } = {},
) {
  return request<{ candidate: EvolutionCandidate; overlay_id?: string }>(
    `/evolution/candidates/${id}/approve`,
    { method: 'POST', ...jsonBody(body) },
  )
}

export function rejectEvolutionCandidate(
  id: string,
  body: { reviewed_by?: string; suppress_days?: number; reason?: string } = {},
) {
  return request<{ candidate: EvolutionCandidate }>(
    `/evolution/candidates/${id}/reject`,
    { method: 'POST', ...jsonBody(body) },
  )
}

export function mergeEvolutionCandidate(id: string, body: { reviewed_by?: string } = {}) {
  return request<{ candidate: EvolutionCandidate }>(
    `/evolution/candidates/${id}/merge`,
    { method: 'POST', ...jsonBody(body) },
  )
}

export function rollbackEvolutionCandidate(
  id: string,
  body: { reviewed_by?: string; reason?: string } = {},
) {
  return request<{ candidate: EvolutionCandidate }>(
    `/evolution/candidates/${id}/rollback`,
    { method: 'POST', ...jsonBody(body) },
  )
}

// ── overlays ───────────────────────────────────────────────

export function listEvolutionOverlays(
  params: {
    project_id?: string
    surface?: EvolutionSurface | ''
    state?: 'active' | 'shadow' | 'retired' | ''
    scope?: 'project' | 'global' | ''
    limit?: number
  } = {},
) {
  const qs = new URLSearchParams()
  if (params.project_id) qs.set('project_id', params.project_id)
  if (params.surface) qs.set('surface', params.surface)
  if (params.state) qs.set('state', params.state)
  if (params.scope) qs.set('scope', params.scope)
  if (params.limit) qs.set('limit', String(params.limit))
  return request<{
    overlays: EvolutionOverlay[]
    filters: Record<string, string | null>
    count: number
  }>(`/evolution/overlays${qs.size ? `?${qs}` : ''}`)
}

export function retireEvolutionOverlay(id: string) {
  return request<{ overlay: EvolutionOverlay }>(
    `/evolution/overlays/${id}/retire`,
    { method: 'POST' },
  )
}

// ── on-demand generator trigger ────────────────────────────

export function runEvolutionGenerators(
  body: {
    project_id?: string
    session_id?: string
    task_id?: string
    only?: string[]
  } = {},
) {
  return request<{
    project_id: string | null
    created: Array<{ generator: string; candidate_id: string }>
    errors: Record<string, string>
  }>(`/evolution/generators/run`, { method: 'POST', ...jsonBody(body) })
}
