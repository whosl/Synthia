/** Parse structured approval JSON from interaction.reason (stored as JSON string). */

export const APPROVAL_FIELD_ORDER = [
  'reason',
  'action',
  'manifest_path',
  'tcl_command',
  'script',
  'target_id',
  'files',
] as const

export const APPROVAL_FIELD_LABELS: Record<string, string> = {
  reason: '申请理由',
  action: '操作说明',
  manifest_path: 'Manifest',
  tcl_command: 'Tcl 命令',
  script: 'Tcl 脚本',
  target_id: '目标',
  files: '文件变更',
}

/** Legacy / duplicate keys — never shown (script/manifest already have dedicated rows). */
const DROPPED_KEYS = new Set(['details', 'message', '说明', 'description'])

const CANONICAL_KEYS = new Set<string>(APPROVAL_FIELD_ORDER)

function sanitizeApprovalObject(obj: Record<string, unknown>): Record<string, unknown> {
  const script = String(obj.script || obj.tcl_command || '').trim()
  const manifest = String(obj.manifest_path || '').trim()
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (DROPPED_KEYS.has(key)) continue
    const text = String(value ?? '').trim()
    if (!text) continue
    if (!CANONICAL_KEYS.has(key)) {
      if (script && text.length > 40 && text.includes(script.slice(0, Math.min(100, script.length)))) continue
      if (manifest && text.includes(manifest) && /^allow /i.test(text)) continue
      if ((script || manifest) && /^allow (running|executing)/i.test(text)) continue
    }
    out[key] = value
  }
  return out
}

export interface ApprovalDetailRow {
  key: string
  label: string
  value: string
  mono?: boolean
}

function formatValue(key: string, value: unknown): string {
  if (value == null) return ''
  if (key === 'files' && Array.isArray(value)) {
    return value
      .map((f) => {
        const row = f as Record<string, unknown>
        const path = String(row.path || '')
        const action = String(row.action || 'modify')
        const desc = row.description ? ` — ${row.description}` : ''
        return `${action}: ${path}${desc}`
      })
      .join('\n')
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value).trim()
}

export function parseApprovalPayload(
  reason?: string,
  _message?: string,
  legacyFiles?: Array<{ path: string; description?: string; action: string }>,
): ApprovalDetailRow[] {
  let obj: Record<string, unknown> = {}
  const raw = reason?.trim() || ''
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = sanitizeApprovalObject(parsed as Record<string, unknown>)
      } else {
        obj = { reason: raw }
      }
    } catch {
      obj = { reason: raw }
    }
  } else if (raw) {
    obj = { reason: raw }
  }

  if (legacyFiles?.length && !obj.files) {
    obj.files = legacyFiles.map((f) => ({
      path: f.path,
      action: f.action,
      description: f.description || '',
    }))
  }

  const rows: ApprovalDetailRow[] = []
  const seen = new Set<string>()

  const push = (key: string, value: unknown) => {
    if (DROPPED_KEYS.has(key)) return
    const text = formatValue(key, value)
    if (!text) return
    seen.add(key)
    rows.push({
      key,
      label: APPROVAL_FIELD_LABELS[key] || key,
      value: text,
      mono: key === 'tcl_command' || key === 'script' || key === 'manifest_path',
    })
  }

  for (const key of APPROVAL_FIELD_ORDER) {
    if (key in obj) push(key, obj[key])
  }
  for (const key of Object.keys(obj)) {
    if (!seen.has(key)) push(key, obj[key])
  }

  return rows
}
