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

export function isSessionRunning(status?: string | null): boolean {
  return status === 'running' || status === 'stopping'
}
