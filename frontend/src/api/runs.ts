import { request } from './client'
import type { Run } from './types'

export function listRunsApi(params: { session_id?: string; limit?: number } = {}) {
  const qs = new URLSearchParams()
  if (params.session_id) qs.set('session_id', params.session_id)
  if (params.limit) qs.set('limit', String(params.limit))
  return request<{ runs: Run[]; count: number }>(`/runs${qs.size ? `?${qs}` : ''}`)
}

export function listRunSteps(runId: string) {
  return request<{ run_id: string; steps: Array<Record<string, unknown>> }>(`/runs/${runId}/steps`)
}

export function listRunPatches(runId: string) {
  return request<{ run_id: string; patches: Array<Record<string, unknown>> }>(`/runs/${runId}/patches`)
}
