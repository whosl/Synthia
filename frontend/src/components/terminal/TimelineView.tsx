import type { AuditLogItem } from '../../timeline/types'
import { formatAuditTitle } from '../../lib/agentDisplay'
import { formatTime } from '../../lib/time'

export function TimelineView({ items }: { items: AuditLogItem[] }) {
  return <div>{items.map((item) => <div key={`${item.id}-${item.seq}`} className={`timeline-row ${item.state || ''}`}>
    <div className="timeline-time">{formatTime(item.createdAt)}</div>
    <div><div className="timeline-title">{formatAuditTitle(item.title)}</div>{item.detail && <div className="timeline-detail">{item.detail}</div>}</div>
    <div className="muted mono">#{item.seq}</div>
  </div>)}</div>
}
