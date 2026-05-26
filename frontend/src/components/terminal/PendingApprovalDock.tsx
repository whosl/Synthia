import { useTranslation } from 'react-i18next'
import type { InteractionEntryPayload, TimelineEntry } from '../../timeline/types'
import { buildApprovalResponse } from '../../lib/approvalResponse'
import { ApprovalBlock } from './ApprovalBlock'

interface PendingApprovalDockProps {
  entries: TimelineEntry[]
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

export function PendingApprovalDock({ entries, onInteractionRespond }: PendingApprovalDockProps) {
  const { t } = useTranslation()

  if (!entries.length) return null

  return (
    <div
      className="approval-dock-anchor"
      role="region"
      aria-label={t('approval.dockRegion')}
      aria-live="polite"
    >
      {entries.map((entry) => {
        const p = entry.payload as InteractionEntryPayload
        return (
          <ApprovalBlock
            key={entry.key}
            id={entry.id}
            title={p.title}
            message={p.message}
            reason={p.reason}
            files={p.files || []}
            status="pending"
            onApprove={(iid, indices) =>
              onInteractionRespond?.(iid, buildApprovalResponse(p.files || [], indices))
            }
            onReject={(iid) => onInteractionRespond?.(iid, { approved: false })}
          />
        )
      })}
    </div>
  )
}
