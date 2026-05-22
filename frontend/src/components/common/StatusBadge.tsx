export function StatusBadge({ status }: { status?: string | null }) {
  const label = status || 'idle'
  return <span className={`status ${label.toLowerCase()}`}>{label}</span>
}
