import type { ToolCallViewModel } from '../components/terminal/ToolCallBlock'
import { resolveToolElapsedMs } from './toolElapsed'

export type ToolOutcome =
  | 'execution_succeeded'
  | 'execution_failed'
  | 'user_rejected'
  | 'queued'
  | 'timeout'
  | 'unknown'

export interface ParsedToolOutcome {
  outcome: ToolOutcome
  summary: string
  scope?: string
  error?: string
  stderr?: string
  stage?: string
  elapsedSec?: number
  success?: boolean
}

const VIVADO_TOOL_RE = /^run_vivado_/i

const STAGE_PATTERNS: Array<{ re: RegExp; stage: string }> = [
  { re: /\bread_verilog\b/i, stage: 'read_verilog' },
  { re: /\bread_vhdl\b/i, stage: 'read_vhdl' },
  { re: /\bsynth_design\b/i, stage: 'synth_design' },
  { re: /\bopt_design\b/i, stage: 'opt_design' },
  { re: /\bplace_design\b/i, stage: 'place_design' },
  { re: /\broute_design\b/i, stage: 'route_design' },
  { re: /\bwrite_bitstream\b/i, stage: 'write_bitstream' },
]

export function isVivadoToolName(name: string): boolean {
  return VIVADO_TOOL_RE.test(name)
}

export function parseToolOutcome(result?: string): ParsedToolOutcome {
  const text = (result || '').trim()
  if (!text) return { outcome: 'unknown', summary: '' }
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>
      const outcome = String(data.edagent_outcome || 'unknown') as ToolOutcome
      const stderr = String(data.stderr || '')
      const error = String(data.error || data.summary || '')
      const blob = `${stderr}\n${error}`
      return {
        outcome,
        summary: String(data.summary || error || stderr || text).slice(0, 500),
        scope: data.scope != null ? String(data.scope) : undefined,
        error: error || undefined,
        stderr: stderr || undefined,
        stage: inferStage(blob),
        elapsedSec: numOrUndef(data.elapsed_sec ?? data.elapsedSec),
        success: data.success === true,
      }
    } catch {
      /* fall through */
    }
  }
  const upper = text.toUpperCase()
  if (upper.startsWith('QUEUED_FOR_APPROVAL')) return { outcome: 'queued', summary: text }
  if (upper.startsWith('TIMEOUT')) return { outcome: 'timeout', summary: text }
  if (upper.includes('USER DECLINED') || upper.startsWith('REJECTED')) {
    return { outcome: 'user_rejected', summary: text }
  }
  return { outcome: 'unknown', summary: text }
}

function numOrUndef(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function inferStage(blob: string): string | undefined {
  for (const { re, stage } of STAGE_PATTERNS) {
    if (re.test(blob)) return stage
  }
  const vivadoErr = blob.match(/\[Vivado[^\]]*\]\s*(\d+-+\d+)/i)
  if (vivadoErr) return vivadoErr[1]
  return undefined
}

export function extractVivadoErrorLine(blob: string): string {
  const lines = blob.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const errLine = lines.find((l) =>
    /\[Common\s+\d+-\d+\]/i.test(l)
    || /ERROR:/i.test(l)
    || /error:/i.test(l),
  )
  if (errLine) return errLine.slice(0, 280)
  return lines.find((l) => l.length > 8)?.slice(0, 280) || blob.slice(0, 280)
}

export function suggestFailureAction(tool: ToolCallViewModel, parsed: ParsedToolOutcome): string {
  if (tool.state === 'rejected' || parsed.outcome === 'user_rejected') {
    return 'Re-run after approving Vivado execution in Controls'
  }
  const blob = `${parsed.error || ''}\n${parsed.stderr || ''}\n${parsed.summary}`.toLowerCase()
  if (blob.includes('file not found') || blob.includes('no such file')) {
    return 'Check missing RTL source path in the manifest'
  }
  if (blob.includes('read_verilog') || parsed.stage === 'read_verilog') {
    return 'Verify RTL paths in eda.yaml and remote workspace sync'
  }
  if (blob.includes('timing') || blob.includes('setup')) {
    return 'Review timing constraints and clock definitions'
  }
  return 'Expand tool details below or open Vivado log in the right panel'
}

export interface ToolFailureCardModel {
  toolId: string
  title: string
  stage?: string
  error: string
  elapsedMs?: number
  action: string
  toolName: string
}

export function buildFailureCard(tool: ToolCallViewModel): ToolFailureCardModel | null {
  const parsed = parseToolOutcome(tool.result)
  const isFail =
    tool.state === 'error'
    || tool.state === 'rejected'
    || tool.state === 'stopped'
    || parsed.outcome === 'execution_failed'
    || parsed.outcome === 'user_rejected'
  if (!isFail && !(isVivadoToolName(tool.name) && parsed.success === false)) {
    return null
  }

  const scope = parsed.scope || ''
  const vivado = isVivadoToolName(tool.name)
  let title = 'Tool failed'
  if (tool.state === 'rejected' || parsed.outcome === 'user_rejected') {
    title = vivado ? 'Vivado run declined' : 'Action declined'
  } else if (scope === 'vivado_synth' || tool.name.includes('synth')) {
    title = 'Synthesis Failed'
  } else if (scope === 'vivado_impl' || tool.name.includes('impl')) {
    title = 'Implementation Failed'
  } else if (scope === 'vivado_flow' || tool.name.includes('flow')) {
    title = 'Vivado Flow Failed'
  } else if (vivado) {
    title = 'Vivado step failed'
  } else if (tool.state === 'stopped') {
    title = 'Tool stopped'
  }

  const blob = `${parsed.error || ''}\n${parsed.stderr || ''}\n${tool.result || ''}`
  const error = extractVivadoErrorLine(blob) || parsed.summary || tool.error || 'Execution failed'

  return {
    toolId: tool.id,
    title,
    stage: parsed.stage || inferStage(blob),
    error,
    elapsedMs: tool.elapsedMs,
    action: suggestFailureAction(tool, parsed),
    toolName: tool.name,
  }
}

export function isSuccessfulTool(tool: ToolCallViewModel): boolean {
  if (tool.state === 'running') return false
  if (tool.state === 'error' || tool.state === 'rejected' || tool.state === 'stopped') return false
  const parsed = parseToolOutcome(tool.result)
  if (parsed.outcome === 'execution_failed' || parsed.outcome === 'user_rejected') return false
  return tool.state === 'completed'
}

export function pickPrimaryFailure(tools: ToolCallViewModel[]): ToolFailureCardModel | null {
  const cards = tools.map(buildFailureCard).filter((c): c is ToolFailureCardModel => Boolean(c))
  if (!cards.length) return null
  const vivadoSynth = cards.find((c) => c.title.toLowerCase().includes('synthesis'))
  if (vivadoSynth) return vivadoSynth
  const vivado = cards.find((c) => isVivadoToolName(c.toolName))
  if (vivado) return vivado
  return cards[0]
}

export interface ToolGroupSummary {
  completed: number
  errors: number
  running: number
  rejected: number
  elapsedSec: number
  tail?: string
}

export function buildToolGroupSummary(
  tools: ToolCallViewModel[],
  primaryFailure: ToolFailureCardModel | null,
): ToolGroupSummary {
  let completed = 0
  let errors = 0
  let running = 0
  let rejected = 0
  for (const t of tools) {
    if (t.state === 'running') running++
    else if (t.state === 'rejected') rejected++
    else if (t.state === 'error' || t.state === 'stopped') errors++
    else if (isSuccessfulTool(t)) completed++
    else errors++
  }
  let tail: string | undefined
  if (primaryFailure?.stage) {
    tail = `Vivado failed at ${primaryFailure.stage}`
  } else if (primaryFailure) {
    tail = primaryFailure.title
  }
  return {
    completed,
    errors,
    running,
    rejected,
    elapsedSec: computeToolGroupElapsedSec(tools),
    tail,
  }
}

/** Wall-clock span when timestamps exist; otherwise sum of per-tool elapsed. */
export function computeToolGroupElapsedSec(tools: ToolCallViewModel[]): number {
  const now = Date.now()
  const starts: number[] = []
  const ends: number[] = []
  let sumMs = 0

  for (const t of tools) {
    const startMs = t.startedAtMs ?? (t.startedAt != null ? t.startedAt * 1000 : null)
    if (startMs != null) starts.push(startMs)

    const completedAtMs = t.state === 'running' ? now : t.completedAtMs
    if (completedAtMs != null) ends.push(completedAtMs)

    const ms = resolveToolElapsedMs(t, { completedAtMs })
    if (ms != null && ms > 0) sumMs += ms
  }

  if (starts.length > 0 && ends.length > 0) {
    const spanMs = Math.max(...ends) - Math.min(...starts)
    if (spanMs > 0) return Math.round(spanMs / 1000)
  }

  return Math.round(sumMs / 1000)
}

export function formatToolGroupSummaryLine(s: ToolGroupSummary): string {
  const line = `${s.completed} tools completed in ${s.elapsedSec} s`
  if (s.running > 0) return `${line} · ${s.running} running`
  return line
}

export function toolEntryToViewModel(
  payload: {
    toolcallId: string
    name: string
    state: ToolCallViewModel['state']
    args?: string
    result?: string
    startedAt?: number
    startedAtMs?: number
    elapsedMs?: number
  },
  entryCreatedAt?: number,
): ToolCallViewModel {
  const at = entryCreatedAt ?? 0
  const createdMs = at > 1e12 ? at : at * 1000
  return {
    id: payload.toolcallId,
    name: payload.name,
    state: payload.state,
    args: payload.args,
    result: payload.result,
    startedAt: payload.startedAt ?? entryCreatedAt,
    startedAtMs: payload.startedAtMs ?? createdMs,
    elapsedMs: payload.elapsedMs,
    completedAtMs: payload.state !== 'running' ? createdMs : undefined,
  }
}
