import { request } from './client'

export interface ApprovalRow {
  id: string
  approval_type: string
  risk_level: string
  status: string
  payload?: Record<string, unknown>
  session_id?: string
  task_id?: string
  run_id?: string
  interaction_id?: string
  created_at?: number
  _source?: string
}

export function listApprovals(params: { status?: string; connector_id?: string; approval_type?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.status) qs.set('status', params.status)
  if (params.connector_id) qs.set('connector_id', params.connector_id)
  if (params.approval_type) qs.set('approval_type', params.approval_type)
  return request<{ approvals: ApprovalRow[] }>(`/approvals${qs.size ? `?${qs}` : ''}`)
}

export function getApproval(id: string) {
  return request<{ approval: ApprovalRow; patches: Array<Record<string, unknown>> }>(`/approvals/${id}`)
}

export function approveApproval(id: string, note = '') {
  return request(`/approvals/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ decided_by: 'user', note }),
  })
}

export function rejectApproval(id: string, note = '') {
  return request(`/approvals/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ decided_by: 'user', note }),
  })
}

export function applyPatch(patchId: string) {
  return request<{ patch_id: string; status: string; message: string }>(`/patches/${patchId}/apply`, {
    method: 'POST',
    body: '{}',
  })
}
