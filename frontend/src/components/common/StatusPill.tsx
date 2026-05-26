import { Check, Circle, Loader2, Pause, X } from 'lucide-react'
import type { ComponentType } from 'react'

export type StatusKind =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'needs_approval'
  | 'cancelled'
  | 'unknown'

const META: Record<
  StatusKind,
  { label: string; icon: ComponentType<{ size?: number; className?: string }>; tone: string }
> = {
  queued: { label: 'queued', icon: Circle, tone: 'muted' },
  running: { label: 'running', icon: Loader2, tone: 'accent' },
  succeeded: { label: 'succeeded', icon: Check, tone: 'success' },
  failed: { label: 'failed', icon: X, tone: 'error' },
  needs_approval: { label: 'needs approval', icon: Pause, tone: 'warning' },
  cancelled: { label: 'cancelled', icon: X, tone: 'muted' },
  unknown: { label: 'unknown', icon: Circle, tone: 'muted' },
}

export function StatusPill({ status, label }: { status: StatusKind; label?: string }) {
  const meta = META[status] ?? META.unknown
  const Icon = meta.icon
  const isRunning = status === 'running'
  return (
    <span className={`status-pill tone-${meta.tone}${isRunning ? ' pulse' : ''}`}>
      <Icon size={11} className={isRunning ? 'status-pill-spin' : undefined} />
      <span>{label || meta.label}</span>
    </span>
  )
}
