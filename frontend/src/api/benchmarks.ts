import { request } from './client'

export interface BenchmarkSuiteSummary {
  id: string
  name: string
  state: string
  total_cases: number
  completed_cases: number
  failed_cases: number
  created_at: number
  project_id?: string
}

export interface BenchmarkCaseRow {
  id: string
  name: string
  sequence: number
  state: string
  flow_name: string
  run_id?: string
  elapsed_ms?: number
  error_category?: string
  metrics?: Record<string, unknown>
}

export interface BenchmarkSuiteDetail extends BenchmarkSuiteSummary {
  description?: string
  cases: BenchmarkCaseRow[]
}

export function listBenchmarkSuites(params?: { project_id?: string; limit?: number }) {
  const q = new URLSearchParams()
  if (params?.project_id) q.set('project_id', params.project_id)
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return request<{ suites: BenchmarkSuiteSummary[] }>(`/benchmarks${qs ? `?${qs}` : ''}`)
}

export function getBenchmarkSuite(suiteId: string) {
  return request<BenchmarkSuiteDetail>(`/benchmarks/${suiteId}`)
}

export function runBenchmarkSuite(suiteId: string) {
  return request<{ ok: boolean; suite_id: string }>(`/benchmarks/${suiteId}/run`, { method: 'POST' })
}
