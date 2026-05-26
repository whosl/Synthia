import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { listRunsApi } from '../api/runs'
import { getProjectTrend, listReportTrends, listRunReports } from '../api/connectors'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { ImplSummaryCard } from '../components/reports/ImplSummaryCard'
import { TimingCard } from '../components/reports/TimingCard'
import { UtilizationCard } from '../components/reports/UtilizationCard'
import { DrcCard } from '../components/reports/DrcCard'
import { MethodologyCard } from '../components/reports/MethodologyCard'
import { BitstreamCard } from '../components/reports/BitstreamCard'
import { TrendLine } from '../components/reports/TrendLine'
import type { ParsedReportRow } from '../api/connectors'

const PROJECT_METRICS: Array<{ id: string; label: string; fmt?: (n: number) => string }> = [
  { id: 'wns_ns', label: 'WNS (ns)' },
  { id: 'whs_ns', label: 'WHS (ns)' },
  { id: 'lut_pct', label: 'LUT %' },
  { id: 'ff_pct', label: 'FF %' },
  { id: 'bram_pct', label: 'BRAM %' },
  { id: 'dsp_pct', label: 'DSP %' },
  { id: 'drc_error_count', label: 'DRC errors' },
]

export default function ReportsPage() {
  const { t } = useTranslation()
  const runsQ = useQuery({ queryKey: ['runs-reports'], queryFn: () => listRunsApi({ limit: 20 }) })
  const latestRun = runsQ.data?.runs?.[0]
  const runId = latestRun?.id ?? ''
  const sessionId = latestRun?.session_id ?? ''
  const projectId = (latestRun?.project_id as string | null | undefined) ?? ''

  const reportsQ = useQuery({
    queryKey: ['reports-explorer', runId],
    queryFn: () => listRunReports(runId),
    enabled: Boolean(runId),
  })
  const sessionTrendQ = useQuery({
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
  const projectTrendQ = useQuery({
    queryKey: ['project-trend', projectId],
    queryFn: () => getProjectTrend(projectId, 10),
    enabled: Boolean(projectId),
  })

  const [selectedMetric, setSelectedMetric] = useState('wns_ns')
  const projectTrendPoints = useMemo(() => {
    const series = projectTrendQ.data?.series ?? []
    return series
      .map((row) => {
        const raw = row.metrics?.[selectedMetric]
        const num = typeof raw === 'number' ? raw : raw === true ? 1 : raw === false ? 0 : Number(raw)
        return { label: row.name.slice(0, 8), value: Number.isFinite(num) ? num : null, run_id: row.run_id }
      })
      .filter((p): p is { label: string; value: number; run_id: string } => p.value != null)
  }, [projectTrendQ.data, selectedMetric])

  const reports = (reportsQ.data?.reports ?? []) as ParsedReportRow[]
  const sessionPoints = (sessionTrendQ.data?.points ?? []).map((p) => ({
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
      <div className="dashboard-grid" style={{ marginTop: 16 }}>
        <Panel
          title={t('reports.projectTrend', { defaultValue: 'Project trend' })}
          actions={
            <select
              value={selectedMetric}
              onChange={(e) => setSelectedMetric(e.target.value)}
              style={{ fontSize: 12 }}
            >
              {PROJECT_METRICS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          }
        >
          {projectId ? (
            <TrendLine
              points={projectTrendPoints}
              emptyLabel={t('reports.trendEmpty')}
            />
          ) : (
            <p className="muted" style={{ fontSize: 12 }}>
              {t('reports.noProject', { defaultValue: 'No project association on latest run.' })}
            </p>
          )}
        </Panel>
        <Panel title={t('reports.trendWns')}>
          <TrendLine points={sessionPoints} emptyLabel={t('reports.trendEmpty')} />
        </Panel>
      </div>
      {reports.length > 0 && (
        <div className="structured-reports-grid" style={{ marginTop: 16 }}>
          {reports.map((r) => {
            if (r.report_type === 'impl_summary') return <ImplSummaryCard key={r.id} report={r} />
            if (r.report_type === 'timing_summary') return <TimingCard key={r.id} report={r} />
            if (r.report_type === 'utilization') return <UtilizationCard key={r.id} report={r} />
            if (r.report_type === 'drc') return <DrcCard key={r.id} report={r} />
            if (r.report_type === 'methodology') return <MethodologyCard key={r.id} report={r} />
            if (r.report_type === 'bitstream') return <BitstreamCard key={r.id} report={r} />
            return (
              <div key={r.id} className="report-card">
                <span className="report-card-title mono">{r.report_type}</span>
                <pre className="mono muted" style={{ fontSize: 11 }}>{JSON.stringify(r.data, null, 2)}</pre>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
