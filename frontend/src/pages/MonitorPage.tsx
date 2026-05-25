import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { listRuns } from '../api/monitor'
import { EmptyState } from '../components/common/EmptyState'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { MonitorOverviewPanel } from '../components/monitor/MonitorOverviewPanel'
import { formatDuration, formatTime } from '../lib/time'

export default function MonitorPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({ queryKey: ['runs'], queryFn: () => listRuns({ limit: 100 }) })
  const runs = data?.runs ?? []
  return <div className="page">
    <PageStickyTop>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('monitor.title')}</h1>
          <p className="page-subtitle">{t('monitor.subtitle')}</p>
        </div>
      </div>
    </PageStickyTop>
    <MonitorOverviewPanel />
    <Panel title={t('monitor.recentRuns')}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('monitor.tableRun')}</th><th>{t('monitor.tableType')}</th><th>{t('monitor.tableStatus')}</th><th className="table-col-time">{t('monitor.tableStarted')}</th><th>{t('monitor.tableElapsed')}</th><th>{t('monitor.tableSession')}</th></tr></thead>
          <tbody>{runs.map((r) => <tr key={r.id}>
            <td><Link to={`/monitor/runs/${r.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>{r.name}</Link><div className="muted mono" style={{ fontSize: 11 }}>{r.id}</div></td>
            <td className="mono">{r.run_type}</td>
            <td><StatusBadge status={r.state} /></td>
            <td className="muted table-col-time">{formatTime(r.started_at)}</td>
            <td className="mono">{formatDuration(r.elapsed_ms)}</td>
            <td className="mono muted" style={{ fontSize: 11 }}>{r.session_id}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {!isLoading && !runs.length && <EmptyState title={t('monitor.noRuns')} detail={t('monitor.noRunsDetail')} />}
    </Panel>
  </div>
}
