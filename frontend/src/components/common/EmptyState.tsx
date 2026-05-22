import { Inbox } from 'lucide-react'

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return <div className="empty">
    <Inbox size={36} style={{ color: 'var(--subtle)', marginBottom: 12 }} />
    <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{title}</div>
    {detail && <div style={{ fontSize: '12.5px' }}>{detail}</div>}
  </div>
}
