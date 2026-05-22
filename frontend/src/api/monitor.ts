import { request } from './client'
import type { Artifact, ContextPackage, ContextPackageItem, Problem, RetrievalAudit, RetrievalAuditItem, Run, SessionEvent, ToolCall, Usage } from './types'

export function listRuns(params: { session_id?: string; limit?: number } = {}) {
  const qs = new URLSearchParams()
  if (params.session_id) qs.set('session_id', params.session_id)
  if (params.limit) qs.set('limit', String(params.limit))
  return request<{ runs: Run[] }>(`/monitor/runs${qs.size ? `?${qs}` : ''}`)
}

export function getRun(runId: string) {
  return request<{ run: Run; toolcalls: ToolCall[]; usage: Usage[] }>(`/monitor/runs/${runId}`)
}

export function listRunToolcalls(runId: string) {
  return request<{ toolcalls: ToolCall[] }>(`/monitor/runs/${runId}/toolcalls`)
}

export function listRunUsage(runId: string) {
  return request<{ usage: Usage[] }>(`/monitor/runs/${runId}/usage`)
}

export function listRunEvents(runId: string) {
  return request<{ events: SessionEvent[] }>(`/monitor/runs/${runId}/events`)
}

export function listRunArtifacts(runId: string) {
  return request<{ artifacts: Artifact[] }>(`/monitor/runs/${runId}/artifacts`)
}

export function listRunProblems(runId: string) {
  return request<{ problems: Problem[] }>(`/monitor/runs/${runId}/problems`)
}

export function getRunContext(runId: string) {
  return request<{
    contexts: Array<{ package: ContextPackage; items: ContextPackageItem[] }>
    retrieval_audits: Array<{ audit: RetrievalAudit; items: RetrievalAuditItem[] }>
  }>(`/monitor/runs/${runId}/context`)
}

export function listSessionRuns(sessionId: string, limit = 50) {
  return request<{ runs: Run[] }>(`/monitor/sessions/${sessionId}/runs?limit=${limit}`)
}
