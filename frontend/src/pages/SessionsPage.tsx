import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { listSessions } from '../api/sessions'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { formatTime } from '../lib/time'

export default function SessionsPage() {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['sessions-all'], queryFn: () => listSessions({ limit: 100 }) })
  const sessions = q.data?.sessions ?? []

  return (
    <div className="page">
      <PageStickyTop>
        <div className="page-header">
          <h1 className="page-title">{t('nav.sessions')}</h1>
          <p className="page-subtitle">{t('sessions.subtitle')}</p>
        </div>
      </PageStickyTop>
      <Panel title={t('sessions.list')}>
        {sessions.length === 0 ? (
          <p className="muted">{t('sessions.empty')}</p>
        ) : (
          sessions.map((s) => (
            <div className="event-row" key={s.id}>
              <Link to={`/term?session=${s.id}`} style={{ fontWeight: 600, color: 'var(--accent)' }}>
                {s.name || s.id}
              </Link>
              <StatusBadge status={s.status} />
              <span className="muted">{formatTime(s.updated_at)}</span>
            </div>
          ))
        )}
      </Panel>
    </div>
  )
}
