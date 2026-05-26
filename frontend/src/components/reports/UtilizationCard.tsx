import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

interface SiteRow {
  used: number
  available: number
  util_pct: number
}

interface UtilData {
  lut?: number | null
  ff?: number | null
  bram?: number | null
  dsp?: number | null
  uram?: number | null
  lut_pct?: number | null
  ff_pct?: number | null
  bram_pct?: number | null
  dsp_pct?: number | null
  uram_pct?: number | null
  sites?: Record<string, SiteRow>
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${Number(v).toFixed(2)}%`
}

export function UtilizationCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as UtilData
  const metrics = [
    { label: 'LUT', used: d.lut, pct: d.lut_pct },
    { label: 'FF', used: d.ff, pct: d.ff_pct },
    { label: 'BRAM', used: d.bram, pct: d.bram_pct },
    { label: 'DSP', used: d.dsp, pct: d.dsp_pct },
  ]
  if (d.uram != null || d.uram_pct != null) {
    metrics.push({ label: 'URAM', used: d.uram, pct: d.uram_pct })
  }
  const sites = Object.entries(d.sites || {})
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
            <span className={`report-metric-value ${typeof m.pct === 'number' && m.pct > 85 ? 'neg' : ''}`}>
              {fmtPct(m.pct)}
            </span>
            <span className="muted mono" style={{ fontSize: 10 }}>{m.used ?? '—'}</span>
          </div>
        ))}
      </div>
      {sites.length > 0 ? (
        <table className="report-table" style={{ marginTop: 8 }}>
          <thead><tr><th>{t('reports.siteType', { defaultValue: 'Site type' })}</th><th>Used</th><th>Available</th><th>Util%</th></tr></thead>
          <tbody>
            {sites.slice(0, 8).map(([name, row]) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                <td>{row.used}</td>
                <td>{row.available}</td>
                <td className={row.util_pct > 85 ? 'is-violated' : ''}>{row.util_pct.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}
