import { jsonBody, request } from './client'

export type ApprovalsState = {
  patch_approved: boolean
  vivado_execution_approved: boolean
}

export type ModelPreset = {
  id: string
  label: string
  model: string
}

export type ModelSettings = {
  provider: string
  base_url: string
  model: string
  reasoning_effort: string
  selected_preset: string
  has_api_key: boolean
  masked_api_key: string
  api_key_source: 'stored' | 'env' | 'none'
  presets: ModelPreset[]
  reasoning_efforts: string[]
}

export type SaveModelSettingsPayload = {
  provider: string
  base_url: string
  model: string
  reasoning_effort: string
  api_key?: string
  clear_api_key?: boolean
}

export function getApprovals() {
  return request<ApprovalsState>('/settings/approvals')
}

export function getModelSettings() {
  return request<ModelSettings>('/settings/model')
}

export function saveModelSettings(payload: SaveModelSettingsPayload) {
  return request<ModelSettings>('/settings/model', { method: 'POST', ...jsonBody(payload) })
}

export function selectModelPreset(preset_id: string, reasoning_effort?: string) {
  return request<ModelSettings>('/settings/model/preset', {
    method: 'POST',
    ...jsonBody({ preset_id, reasoning_effort }),
  })
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
