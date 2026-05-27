import { request } from './client'

export interface PatchChangeRow {
  path: string
  action: string
  file_category: string
  diff_text?: string
  before_text?: string
  after_text?: string
}

export interface PatchRecord {
  id: string
  session_id: string
  title: string
  rationale: string
  risk_level: string
  state: string
  status?: string
  changes: PatchChangeRow[]
  risk_assessment?: Record<string, unknown>
  spawned_run_id?: string
  approval_id?: string
}

export function proposePatch(body: {
  session_id: string
  title: string
  rationale?: string
  changes: Array<Record<string, unknown>>
  project_id?: string
  run_id?: string
  task_id?: string
}) {
  return request<{ patch: PatchRecord; risk_assessment: Record<string, unknown> }>(
    '/patches/propose',
    { method: 'POST', body: JSON.stringify(body) },
  )
}

export function getPatch(patchId: string) {
  return request<{ patch: PatchRecord; audits: Array<Record<string, unknown>> }>(
    `/patches/${patchId}`,
  )
}

export function approvePatch(patchId: string, reason = '', reviewerId = 'user') {
  return request<{ patch: PatchRecord }>(`/patches/${patchId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ reason, reviewer_id: reviewerId }),
  })
}

export function rejectPatch(patchId: string, reason = '', reviewerId = 'user') {
  return request<{ patch: PatchRecord }>(`/patches/${patchId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason, reviewer_id: reviewerId }),
  })
}

export function revertPatch(patchId: string) {
  return request<{ patch: PatchRecord }>(`/patches/${patchId}/revert`, {
    method: 'POST',
    body: '{}',
  })
}
