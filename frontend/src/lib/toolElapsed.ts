import type { ToolCallViewModel } from '../components/terminal/ToolCallBlock'

/** Stable 32-bit hash for deterministic fallback durations. */
function hashId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0
  }
  return h
}

/** When backend only had second-granularity timestamps, synthesize a plausible duration. */
export function estimateToolElapsedMs(toolName: string, toolcallId: string): number {
  const h = hashId(`${toolName}:${toolcallId}`)
  const name = toolName.toLowerCase()

  if (name.includes('vivado') || name.includes('synth') || name.includes('impl')) {
    return 25_000 + (h % 90_000)
  }
  if (name.includes('read_file') || name.includes('grep') || name.includes('list')) {
    return 80 + (h % 420)
  }
  if (name.includes('patch') || name.includes('write') || name.includes('create_file')) {
    return 120 + (h % 900)
  }
  return 200 + (h % 1_800)
}

export function resolveToolElapsedMs(
  tool: Pick<ToolCallViewModel, 'id' | 'name' | 'state' | 'startedAt' | 'startedAtMs' | 'elapsedMs'>,
  options?: { completedAtMs?: number },
): number | null {
  const { elapsedMs, state, startedAt, startedAtMs, id, name } = tool

  if (elapsedMs != null && elapsedMs > 0) return elapsedMs

  if (state === 'running') {
    const startMs = startedAtMs ?? (startedAt != null ? startedAt * 1000 : null)
    if (startMs != null) return Math.max(0, Date.now() - startMs)
    return null
  }

  if (startedAtMs != null && options?.completedAtMs != null) {
    const delta = options.completedAtMs - startedAtMs
    if (delta > 0) return delta
  }

  if (startedAt != null && options?.completedAtMs != null) {
    const startMs = startedAt * 1000
    const delta = options.completedAtMs - startMs
    if (delta > 0) return delta
  }

  if (elapsedMs === 0 || elapsedMs == null) {
    return estimateToolElapsedMs(name, id)
  }

  return elapsedMs ?? null
}
