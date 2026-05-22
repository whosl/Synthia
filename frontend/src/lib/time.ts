export function formatTime(ts?: number | null): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
}

export function formatRelative(ts?: number | null): string {
  if (!ts) return '—'
  const diff = Math.max(0, Date.now() / 1000 - ts)
  if (diff < 60) return `${Math.floor(diff)}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function formatDuration(ms?: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
}

export function formatNumber(n?: number | null): string {
  if (n == null) return '0'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function classForStatus(status?: string) {
  if (!status) return 'status idle'
  return `status ${status.toLowerCase()}`
}
