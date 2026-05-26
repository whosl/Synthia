import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { request } from '../api/client'
import type { ParsedReportRow } from '../api/connectors'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { DrcCard } from '../components/reports/DrcCard'
import { MethodologyCard } from '../components/reports/MethodologyCard'
import { TimingCard } from '../components/reports/TimingCard'
import { UtilizationCard } from '../components/reports/UtilizationCard'

function getReport(runId: string, reportId: string) {
  return request<{ run_id: string; report: ParsedReportRow }>(`/runs/${runId}/reports/${reportId}`)
}

export default function ReportDetailPage() {
  const { t } = useTranslation()
  const { reportId = '' } = useParams()
  const [search] = useSearchParams()
  const runId = search.get('run_id') || ''

  const q = useQuery({
    queryKey: ['report-detail', runId, reportId],
    queryFn: () => getReport(runId, reportId),
    enabled: Boolean(runId && reportId),
  })
  const report = q.data?.report

  return (
    <div className="page">
      <PageStickyTop>
        <div className="page-header">
          <div>
            <h1 className="page-title">{t('reports.detailTitle')}</h1>
            <p className="page-subtitle mono">{reportId}</p>
          </div>
          {runId && (
            <Link to={`/runs/${runId}`} style={{ color: 'var(--accent)', fontSize: 13 }}>
              {t('reports.backToRun')}
            </Link>
          )}
        </div>
      </PageStickyTop>
      {q.isLoading ? (
        <p className="muted">{t('reports.loading')}</p>
      ) : !report ? (
        <p className="muted">{t('reports.notFound')}</p>
      ) : (
        <Panel title={`${report.report_type} · ${report.stage}`}>
          {report.report_type === 'timing_summary' && <TimingCard report={report} />}
          {report.report_type === 'utilization' && <UtilizationCard report={report} />}
          {report.report_type === 'drc' && <DrcCard report={report} />}
          {report.report_type === 'methodology' && <MethodologyCard report={report} />}
          {!['timing_summary', 'utilization', 'drc', 'methodology'].includes(report.report_type) && (
            <pre className="mono muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(report.data, null, 2)}
            </pre>
          )}
        </Panel>
      )}
    </div>
  )
}
