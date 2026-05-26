import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

export function UtilizationCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as Record<string, number | null | undefined>
  const metrics = [
    { label: 'LUT', value: d.lut },
    { label: 'FF', value: d.ff },
    { label: 'BRAM', value: d.bram },
    { label: 'DSP', value: d.dsp },
  ]
  return (
    <div className="report-card">
      <div className="report-card-head">
        <span className="report-card-title">{t('reports.utilization')}</span>
        <span className="muted mono" style={{ fontSize: 11 }}>{report.stage}</span>
      </div>
      <div className="report-metric-grid">
        {metrics.map((m) => (
          <div key={m.label} className="report-metric">
            <span className="report-metric-label">{m.label}</span>
            <span className="report-metric-value">{m.value ?? '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
