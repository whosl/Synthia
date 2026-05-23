import { request } from './client'

export interface KbCase {
  id?: string
  pattern: string
  category: string
  likely_causes: string[]
  suggested_actions: string[]
  source?: string
}

export function listLegacyErrorKb() {
  return request<{ cases: KbCase[] }>('/kb/cases')
}

export interface KbCandidate {
  id: string
  title: string
  source_run_id?: string
  source_session_id?: string
  source_problem_id?: string
  pattern?: string
  category?: string
  likely_causes?: string[]
  suggested_actions?: string[]
  confidence?: number
  status: string
  created_at?: number
}

export function listKbCandidates() {
  return request<{ candidates: KbCandidate[] }>('/kb/candidates')
}

export function approveKbCandidate(id: string) {
  return request(`/kb/candidates/${id}/approve`, { method: 'POST' })
}

export function rejectKbCandidate(id: string) {
  return request(`/kb/candidates/${id}/reject`, { method: 'POST' })
}

export function mergeKbCandidate(id: string) {
  return request(`/kb/candidates/${id}/merge`, { method: 'POST' })
}
