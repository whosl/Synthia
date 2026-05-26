import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { listRunsApi } from '../api/runs'
import { listReportTrends, listRunReports } from '../api/connectors'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { TimingCard } from '../components/reports/TimingCard'
import { TrendLine } from '../components/reports/TrendLine'
import type { ParsedReportRow } from '../api/connectors'

export default function ReportsPage() {
  const { t } = useTranslation()
  const runsQ = useQuery({ queryKey: ['runs-reports'], queryFn: () => listRunsApi({ limit: 20 }) })
  const runId = runsQ.data?.runs?.[0]?.id ?? ''
  const sessionId = runsQ.data?.runs?.[0]?.session_id ?? ''
  const reportsQ = useQuery({
    queryKey: ['reports-explorer', runId],
    queryFn: () => listRunReports(runId),
    enabled: Boolean(runId),
  })
  const trendsQ = useQuery({
    queryKey: ['reports-trends', sessionId],
    queryFn: () =>
      listReportTrends({
        report_type: 'timing_summary',
        metric: 'wns',
        session_id: sessionId || undefined,
        limit: 15,
      }),
    enabled: Boolean(sessionId) || Boolean(runId),
  })
  const reports = (reportsQ.data?.reports ?? []) as ParsedReportRow[]
  const trendPoints = (trendsQ.data?.points ?? []).map((p) => ({
    label: p.label,
    value: p.value,
    run_id: p.run_id,
    created_at: p.created_at,
  }))

  return (
    <div className="page">
      <PageStickyTop>
        <div className="page-header">
          <h1 className="page-title">{t('nav.reports')}</h1>
          <p className="page-subtitle">{t('reports.explorerSubtitle')}</p>
        </div>
      </PageStickyTop>
      <Panel title={t('reports.recentRun')}>
        {runId ? (
          <Link to={`/runs/${runId}`} className="mono" style={{ color: 'var(--accent)' }}>{runId}</Link>
        ) : (
          <p className="muted">{t('reports.empty')}</p>
        )}
      </Panel>
      <div style={{ marginTop: 16 }}>
        <Panel title={t('reports.trendWns')}>
          <TrendLine
            points={trendPoints}
            emptyLabel={t('reports.trendEmpty')}
          />
        </Panel>
      </div>
      {reports.length > 0 && (
        <div className="structured-reports-grid" style={{ marginTop: 16 }}>
          {reports.map((r) =>
            r.report_type === 'timing_summary' ? (
              <TimingCard key={r.id} report={r} />
            ) : (
              <div key={r.id} className="report-card">
                <span className="report-card-title mono">{r.report_type}</span>
                <pre className="mono muted" style={{ fontSize: 11 }}>{JSON.stringify(r.data, null, 2)}</pre>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}
