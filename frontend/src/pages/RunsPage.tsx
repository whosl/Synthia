import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { listRunsApi } from '../api/runs'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { formatTime } from '../lib/time'

export default function RunsPage() {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['runs-all'], queryFn: () => listRunsApi({ limit: 80 }) })
  const runs = q.data?.runs ?? []

  return (
    <div className="page">
      <PageStickyTop>
        <div className="page-header">
          <h1 className="page-title">{t('nav.runs')}</h1>
          <p className="page-subtitle">{t('runs.subtitle')}</p>
        </div>
      </PageStickyTop>
      <Panel title={t('runs.list')}>
        {runs.map((r) => (
          <div className="event-row" key={r.id}>
            <Link to={`/runs/${r.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>{r.name || r.id}</Link>
            <StatusBadge status={r.state} />
            <span className="muted mono">{r.session_id}</span>
            <span className="muted">{formatTime(r.started_at)}</span>
          </div>
        ))}
      </Panel>
    </div>
  )
}
