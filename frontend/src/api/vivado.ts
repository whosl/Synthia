import { request } from './client'
import type { VivadoHealth } from './types'

export function getVivadoHealth() {
  return request<VivadoHealth>('/health/vivado')
}

export function listVivadoTargets() {
  return request<{ targets: Array<Record<string, unknown>> }>('/vivado/targets')
}

export interface VivadoCommandRow {
  id: string
  command?: string
  command_text?: string
  command_type?: string
  status?: string
  state?: string
  started_at?: number
  finished_at?: number
  elapsed_ms?: number
  exit_code?: number
  error?: string
}

export function listVivadoCommands(sessionId?: string) {
  const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
  return request<{ commands: VivadoCommandRow[] }>(`/vivado/commands${q}`)
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

export function runVivadoScript(script: string, autoApproved = true) {
  return request<{
    ok: boolean
    exit_code?: number
    stdout?: string
    stderr?: string
    elapsed_sec?: number
    error?: string
    requires_approval?: boolean
  }>('/vivado/commands/script', {
    method: 'POST',
    body: JSON.stringify({ script, auto_approved: autoApproved }),
    headers: { 'Content-Type': 'application/json' },
  })
}

export function formatVivadoTime(ts?: number) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
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
