import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

export function TimingCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as Record<string, number | null | undefined>
  const metrics = [
    { label: 'WNS', value: d.wns },
    { label: 'TNS', value: d.tns },
    { label: 'WHS', value: d.whs },
    { label: 'THS', value: d.ths },
  ]
  return (
    <div className="report-card">
      <div className="report-card-head">
        <span className="report-card-title">{t('reports.timing')}</span>
        <span className="muted mono" style={{ fontSize: 11 }}>{report.stage}</span>
      </div>
      <div className="report-metric-grid">
        {metrics.map((m) => (
          <div key={m.label} className="report-metric">
            <span className="report-metric-label">{m.label}</span>
            <span className={`report-metric-value ${typeof m.value === 'number' && m.value < 0 ? 'neg' : ''}`}>
              {m.value ?? '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
