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

export function runVivadoTcl(command: string, autoApproved = true) {
  return request<{
    ok: boolean
    exit_code?: number
    stdout?: string
    stderr?: string
    elapsed_sec?: number
    error?: string
    requires_approval?: boolean
  }>('/vivado/commands/tcl', {
    method: 'POST',
    body: JSON.stringify({ command, auto_approved: autoApproved }),
    headers: { 'Content-Type': 'application/json' },
  })
}
