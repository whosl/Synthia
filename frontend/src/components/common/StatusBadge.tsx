import { clsx } from 'clsx'

export function StatusBadge({ status }: { status?: string }) {
  return <span className={clsx('status', (status || 'idle').toLowerCase())}>{status || 'idle'}</span>
}
