import { request } from './client'
import type { VivadoHealth } from './types'

export function getVivadoHealth() {
  return request<VivadoHealth>('/health/vivado')
}

export function listVivadoTargets() {
  return request<{ targets: Array<Record<string, unknown>> }>('/vivado/targets')
}

export function listVivadoCommands() {
  return request<{ commands: Array<Record<string, unknown>> }>('/vivado/commands')
}
