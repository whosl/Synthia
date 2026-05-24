import { X } from 'lucide-react'
import { Button } from '../common/Button'

export type MobileAction = {
  id: string
  label: string
  destructive?: boolean
  onSelect: () => void
}

export function MobileActionsMenu({
  title,
  actions,
  onClose,
}: {
  title: string
  actions: MobileAction[]
  onClose: () => void
}) {
  return (
    <div className="mobile-actions-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mobile-actions-sheet"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mobile-actions-head">
          <strong>{title}</strong>
          <Button className="ghost icon-btn" type="button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </Button>
        </div>
        <ul className="mobile-actions-list">
          {actions.map((action) => (
            <li key={action.id}>
              <button
                type="button"
                className={`mobile-actions-item${action.destructive ? ' destructive' : ''}`}
                onClick={() => {
                  action.onSelect()
                  onClose()
                }}
              >
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
