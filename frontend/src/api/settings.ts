import { jsonBody, request } from './client'

export function getPatchApproval() {
  return request<{ approved: boolean }>('/settings/patch-approval')
}

export function setPatchApproval(approved: boolean) {
  return request<{ approved: boolean }>('/settings/patch-approval', { method: 'POST', ...jsonBody({ approved }) })
}
