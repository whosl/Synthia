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

// ── trials (SE-PR5) ────────────────────────────────────────

export type TrialState = 'running' | 'completed' | 'reverted'
export type TrialDecision = 'variant_wins' | 'baseline_wins' | 'tie' | 'aborted' | null

export interface EvolutionTrial {
  id: string
  candidate_id: string
  project_id: string
  surface: EvolutionSurface
  baseline_overlay_id?: string | null
  variant_overlay_id?: string | null
  state: TrialState
  started_at: number
  finished_at?: number | null
  n_baseline: number
  n_variant: number
  metric_baseline?: { scores?: number[]; mean?: number | null }
  metric_variant?: { scores?: number[]; mean?: number | null }
  decision?: TrialDecision
  decided_at?: number | null
  metadata?: Record<string, unknown>
}

export interface EvolutionTrialConfig {
  project_id: string | null
  trials: Record<EvolutionSurface, boolean>
  forbidden_surfaces: EvolutionSurface[]
  min_samples_per_arm: number
  decision_margin: number
}

export function getEvolutionConfig(projectId?: string) {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''
  return request<EvolutionTrialConfig>(`/evolution/config${qs}`)
}

export function setEvolutionTrialFlag(body: {
  project_id: string
  surface: EvolutionSurface
  enabled: boolean
}) {
  return request<{ project_id: string; surface: EvolutionSurface; enabled: boolean }>(
    `/evolution/config`,
    { method: 'POST', ...jsonBody(body) },
  )
}

export function listEvolutionTrials(
  params: {
    project_id?: string
    state?: TrialState | ''
    surface?: EvolutionSurface | ''
    limit?: number
  } = {},
) {
  const qs = new URLSearchParams()
  if (params.project_id) qs.set('project_id', params.project_id)
  if (params.state) qs.set('state', params.state)
  if (params.surface) qs.set('surface', params.surface)
  if (params.limit) qs.set('limit', String(params.limit))
  return request<{ trials: EvolutionTrial[]; filters: Record<string, string | null>; count: number }>(
    `/evolution/trials${qs.size ? `?${qs}` : ''}`,
  )
}

export function getEvolutionTrial(id: string) {
  return request<{ trial: EvolutionTrial }>(`/evolution/trials/${id}`)
}

export function decideEvolutionTrial(
  id: string,
  body: { decision: 'variant_wins' | 'baseline_wins' | 'tie'; reviewed_by?: string },
) {
  return request<{ trial: EvolutionTrial }>(
    `/evolution/trials/${id}/decide`,
    { method: 'POST', ...jsonBody(body) },
  )
}

export function abortEvolutionTrial(id: string, body: { reason?: string } = {}) {
  return request<{ trial: EvolutionTrial }>(
    `/evolution/trials/${id}/abort`,
    { method: 'POST', ...jsonBody(body) },
  )
}

// ── eval set placeholder (SE-PR6) ──────────────────────────

export type EvalRunState = 'placeholder' | 'queued' | 'running' | 'completed' | 'error'

export interface EvalSetDescriptor {
  name: string
  description: string
  case_count: number
  path: string
}

export interface EvalRun {
  id: string
  eval_set: string
  overlay_id?: string | null
  state: EvalRunState
  started_at?: number | null
  finished_at?: number | null
  total_cases?: number | null
  passed?: number | null
  failed?: number | null
  metric_summary?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export function listEvalSets() {
  return request<{ sets: EvalSetDescriptor[]; count: number; runner_implemented: boolean }>(
    `/evolution/eval/sets`,
  )
}

export function listEvalRuns(
  params: { eval_set?: string; state?: EvalRunState | ''; limit?: number } = {},
) {
  const qs = new URLSearchParams()
  if (params.eval_set) qs.set('eval_set', params.eval_set)
  if (params.state) qs.set('state', params.state)
  if (params.limit) qs.set('limit', String(params.limit))
  return request<{ runs: EvalRun[]; count: number; runner_implemented: boolean }>(
    `/evolution/eval/runs${qs.size ? `?${qs}` : ''}`,
  )
}

export function queueEvalRun(body: {
  eval_set: string
  project_id?: string | null
  overlay_id?: string | null
  note?: string
}) {
  return request<{ run: EvalRun; runner_implemented: boolean; note?: string }>(
    `/evolution/eval/run`,
    { method: 'POST', ...jsonBody(body) },
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
