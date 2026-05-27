/** Extract diff text from approval / patch payloads stored as JSON in reason. */

export interface PatchDiffInfo {
  path: string
  diff: string
  changes: Array<{ path: string; diff_text?: string }>
}

export function extractPatchDiffFromReason(reason?: string): PatchDiffInfo | null {
  const raw = reason?.trim() || ''
  if (!raw.startsWith('{')) return null
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const diff = String(obj.diff || '')
    const path = String(obj.file_path || '')
    const changes = Array.isArray(obj.changes)
      ? (obj.changes as Array<Record<string, unknown>>).map((c) => ({
          path: String(c.path || ''),
          diff_text: String(c.diff_text || ''),
        }))
      : []
    if (!diff && !changes.some((c) => c.diff_text)) return null
    return { path, diff, changes }
  } catch {
    return null
  }
}
