import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { request } from '../../api/client'
import { Panel } from '../../components/common/Panel'
import { StatusBadge } from '../../components/common/StatusBadge'

interface KbCandidate {
  id: string
  pattern?: string
  category?: string
  status?: string
  confidence?: number
}

export default function KbCandidatesPage() {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['kb-candidates'],
    queryFn: () => request<{ candidates: KbCandidate[] }>('/kb/candidates?status=pending&limit=50'),
  })
  const rows = q.data?.candidates ?? []

  return (
    <Panel title={t('knowledge.candidates')}>
      {rows.map((c) => (
        <div className="event-row" key={c.id}>
          <span className="mono">{c.id.slice(0, 8)}</span>
          <span>{c.pattern || c.category || '—'}</span>
          <StatusBadge status={c.status || 'pending'} />
        </div>
      ))}
      {!rows.length && <p className="muted">{t('knowledge.emptyCandidates')}</p>}
    </Panel>
  )
}
