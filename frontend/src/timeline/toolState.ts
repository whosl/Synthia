/** Map tool result JSON / event payload to UI state. */
export function toolStateFromCompletion(
  result: string,
  payloadState?: unknown,
): 'running' | 'completed' | 'error' | 'rejected' {
  if (payloadState === 'rejected' || payloadState === 'error' || payloadState === 'completed') {
    return payloadState
  }
  const text = (result || '').trim()
  if (!text.startsWith('{')) return 'completed'
  try {
    const parsed = JSON.parse(text) as { edagent_outcome?: string }
    if (parsed.edagent_outcome === 'user_rejected') return 'rejected'
    if (parsed.edagent_outcome === 'execution_failed') return 'error'
  } catch {
    /* ignore */
  }
  return 'completed'
}
