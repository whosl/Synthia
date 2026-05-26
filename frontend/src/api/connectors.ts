import { request } from './client'

export interface ConnectorSummary {
  connector_id: string
  tool_name: string
  supported_versions: string[]
  status: string
  version?: string
  capabilities_count: number
}

export interface ConnectorCapability {
  capability_id: string
  display_name: string
  stage: string
  risk_level: string
  requires_approval: boolean
  outputs: string[]
}

export interface ParsedReportRow {
  id: string
  run_id: string
  step_id?: string
  connector_id: string
  report_type: string
  stage: string
  data?: Record<string, unknown>
  created_at?: number
}

export function listConnectors() {
  return request<{ connectors: ConnectorSummary[] }>('/connectors')
}

export function getConnector(connectorId: string) {
  return request<{
    connector: Record<string, unknown>
    environment: { reachable: boolean; version: string; target_type: string; target_id: string } | null
  }>(`/connectors/${connectorId}`)
}

export function connectorHealthCheck(connectorId: string) {
  return request<{
    connector_id: string
    reachable: boolean
    version: string
    target_type: string
    environment: Record<string, unknown>
  }>(`/connectors/${connectorId}/health-check`, { method: 'POST', body: '{}' })
}

export function listConnectorCapabilities(connectorId: string) {
  return request<{ connector_id: string; capabilities: ConnectorCapability[] }>(
    `/connectors/${connectorId}/capabilities`,
  )
}

export function listRunReports(runId: string, reportType?: string) {
  const qs = reportType ? `?report_type=${encodeURIComponent(reportType)}` : ''
  return request<{ run_id: string; reports: ParsedReportRow[] }>(`/runs/${runId}/reports${qs}`)
}

export interface ReportTrendPoint {
  report_id: string
  run_id: string
  label: string
  metric: string
  value: number
  created_at?: number
}

export function listReportTrends(params: {
  report_type?: string
  session_id?: string
  metric?: string
  limit?: number
} = {}) {
  const qs = new URLSearchParams()
  if (params.report_type) qs.set('report_type', params.report_type)
  if (params.session_id) qs.set('session_id', params.session_id)
  if (params.metric) qs.set('metric', params.metric)
  if (params.limit) qs.set('limit', String(params.limit))
  return request<{
    report_type: string
    metric: string
    points: ReportTrendPoint[]
  }>(`/reports/trends${qs.size ? `?${qs}` : ''}`)
}
