import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { listRunReports } from '../../api/connectors'
import { Panel } from '../common/Panel'
import { BitstreamCard } from './BitstreamCard'
import { DrcCard } from './DrcCard'
import { ImplSummaryCard } from './ImplSummaryCard'
import { MethodologyCard } from './MethodologyCard'
import { TimingCard } from './TimingCard'
import { UtilizationCard } from './UtilizationCard'

const REPORT_ORDER: Record<string, number> = {
  impl_summary: 0,
  timing_summary: 1,
  utilization: 2,
  drc: 3,
  methodology: 4,
  bitstream: 5,
  log_summary: 6,
}

export function StructuredReportsPanel({ runId }: { runId: string }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['run-reports', runId],
    queryFn: () => listRunReports(runId),
    enabled: Boolean(runId),
  })
  const reports = [...(q.data?.reports ?? [])].sort((a, b) => {
    const ra = REPORT_ORDER[a.report_type] ?? 99
    const rb = REPORT_ORDER[b.report_type] ?? 99
    return ra - rb
  })

  return (
    <Panel title={t('reports.structuredTitle')}>
      {q.isLoading ? (
        <p className="muted" style={{ fontSize: 13 }}>{t('reports.loading')}</p>
      ) : reports.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>{t('reports.empty')}</p>
      ) : (
        <div className="structured-reports-grid">
          {reports.map((r) => {
            const detail = (
              <Link
                to={`/reports/${r.id}?run_id=${encodeURIComponent(runId)}`}
                className="muted"
                style={{ fontSize: 11, display: 'block', marginTop: 6 }}
              >
                {t('reports.viewDetail')}
              </Link>
            )
            if (r.report_type === 'impl_summary') {
              return <div key={r.id}><ImplSummaryCard report={r} />{detail}</div>
            }
            if (r.report_type === 'timing_summary') {
              return <div key={r.id}><TimingCard report={r} />{detail}</div>
            }
            if (r.report_type === 'utilization') {
              return <div key={r.id}><UtilizationCard report={r} />{detail}</div>
            }
            if (r.report_type === 'drc') {
              return <div key={r.id}><DrcCard report={r} />{detail}</div>
            }
            if (r.report_type === 'methodology') {
              return <div key={r.id}><MethodologyCard report={r} />{detail}</div>
            }
            if (r.report_type === 'bitstream') {
              return <div key={r.id}><BitstreamCard report={r} />{detail}</div>
            }
            return (
              <div key={r.id} className="report-card">
                <div className="report-card-head">
                  <span className="report-card-title mono">{r.report_type}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{r.stage}</span>
                </div>
                <pre className="mono muted" style={{ fontSize: 11, margin: 0, maxHeight: 120, overflow: 'auto' }}>
                  {JSON.stringify(r.data, null, 2)}
                </pre>
                {detail}
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
