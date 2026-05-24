const AVATAR_PALETTE = [
  { bg: '#ea580c', fg: '#fff' },
  { bg: '#1a1a1a', fg: '#fff' },
  { bg: '#2563eb', fg: '#fff' },
  { bg: '#7c3aed', fg: '#fff' },
  { bg: '#0d9488', fg: '#fff' },
  { bg: '#be123c', fg: '#fff' },
] as const

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function sessionInitials(name: string): string {
  const trimmed = (name || '').trim()
  if (!trimmed) return '??'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const a = parts[0]![0] ?? ''
    const b = parts[1]![0] ?? ''
    return `${a}${b}`.toUpperCase()
  }
  const word = parts[0]!
  if (/[\u4e00-\u9fff]/.test(word)) return word.slice(0, 2)
  return word.slice(0, 2).toUpperCase()
}

export function sessionAvatarColors(seed: string, muted = false) {
  if (muted) return { background: 'var(--border)', color: 'var(--muted)' }
  const palette = AVATAR_PALETTE[hashString(seed) % AVATAR_PALETTE.length]!
  return { background: palette.bg, color: palette.fg }
}

export function isSessionRunning(status?: string | null): boolean {
  return status === 'running' || status === 'stopping'
}
