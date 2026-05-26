import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

interface CriticalPath {
  slack_ns?: number
  status?: string
  source?: string
  destination?: string
  path_group?: string
  logic_levels?: number | null
}

interface TimingData {
  wns?: number | null
  tns?: number | null
  whs?: number | null
  ths?: number | null
  met_setup?: boolean
  met_hold?: boolean
  violated_path_count?: number
  critical_paths?: CriticalPath[]
}

function fmt(value: number | null | undefined): string {
  if (value == null) return '—'
  return Number(value).toFixed(3)
}

export function TimingCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as TimingData
  const metrics = [
    { label: 'WNS', value: d.wns },
    { label: 'TNS', value: d.tns },
    { label: 'WHS', value: d.whs },
    { label: 'THS', value: d.ths },
  ]
  const paths = (d.critical_paths || []).slice(0, 5)
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
              {fmt(m.value)}
            </span>
          </div>
        ))}
      </div>
      <div className="report-meta-row">
        <span className={`pill ${d.met_setup === false ? 'neg' : 'ok'}`}>
          {t('reports.setupMet', { defaultValue: 'Setup' })}: {d.met_setup === false ? '✗' : '✓'}
        </span>
        <span className={`pill ${d.met_hold === false ? 'neg' : 'ok'}`}>
          {t('reports.holdMet', { defaultValue: 'Hold' })}: {d.met_hold === false ? '✗' : '✓'}
        </span>
        {d.violated_path_count ? (
          <span className="pill neg">
            {t('reports.violatedPaths', { defaultValue: 'Violated' })}: {d.violated_path_count}
          </span>
        ) : null}
      </div>
      {paths.length > 0 ? (
        <table className="report-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>{t('reports.slack', { defaultValue: 'Slack' })}</th>
              <th>{t('reports.source', { defaultValue: 'Source' })}</th>
              <th>{t('reports.destination', { defaultValue: 'Destination' })}</th>
              <th>{t('reports.group', { defaultValue: 'Group' })}</th>
              <th>{t('reports.levels', { defaultValue: 'Lvl' })}</th>
            </tr>
          </thead>
          <tbody>
            {paths.map((p, i) => (
              <tr key={i} className={p.status === 'violated' ? 'is-violated' : ''}>
                <td className="mono">{fmt(p.slack_ns)}</td>
                <td><code>{p.source}</code></td>
                <td><code>{p.destination}</code></td>
                <td>{p.path_group}</td>
                <td>{p.logic_levels ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}
