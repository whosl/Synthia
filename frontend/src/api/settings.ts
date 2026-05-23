import { jsonBody, request } from './client'

export type ApprovalsState = {
  patch_approved: boolean
  vivado_execution_approved: boolean
}

export function getApprovals() {
  return request<ApprovalsState>('/settings/approvals')
}

export function getPatchApproval() {
  return request<{ approved: boolean }>('/settings/patch-approval')
}

export function setPatchApproval(approved: boolean) {
  return request<{ approved: boolean }>('/settings/patch-approval', { method: 'POST', ...jsonBody({ approved }) })
}

export function getVivadoApproval() {
  return request<{ approved: boolean }>('/settings/vivado-approval')
}

export function setVivadoApproval(approved: boolean) {
  return request<{ approved: boolean }>('/settings/vivado-approval', { method: 'POST', ...jsonBody({ approved }) })
}
