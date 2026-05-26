import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

interface Issue {
  severity?: string
  category?: string
  message?: string
}

interface ImplSummaryData {
  ok?: boolean
  issues?: Issue[]
  timing?: {
    wns_ns?: number | null
    whs_ns?: number | null
    met_setup?: boolean
    met_hold?: boolean
    violated_paths?: number
  }
  utilization?: {
    lut_pct?: number | null
    ff_pct?: number | null
    bram_pct?: number | null
    dsp_pct?: number | null
  }
  drc?: {
    clean?: boolean
    error_count?: number
    warning_count?: number
  }
  methodology?: { count?: number }
  log?: { error_count?: number; critical_warning_count?: number }
  bitstream?: { found?: boolean; count?: number; primary_bit?: string }
}

function fmtNs(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${Number(v).toFixed(3)} ns`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${Number(v).toFixed(1)}%`
}

export function ImplSummaryCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as ImplSummaryData
  const issues = d.issues ?? []
  const okBadgeClass = d.ok ? 'kpi-success' : 'kpi-danger'
  return (
    <div className="report-card report-card--summary">
      <div className="report-card-head">
        <span className="report-card-title">{t('reports.implSummary', { defaultValue: 'Impl Summary' })}</span>
        <span className="muted mono" style={{ fontSize: 11 }}>{report.stage}</span>
      </div>
      <div className="kpi-row">
        <div className={`kpi ${okBadgeClass}`}>
          <span className="kpi-label">{t('reports.overall', { defaultValue: 'Overall' })}</span>
          <span className="kpi-value">{d.ok ? 'PASS' : 'FAIL'}</span>
        </div>
        {d.timing ? (
          <div className={`kpi ${d.timing.met_setup === false ? 'kpi-danger' : 'kpi-success'}`}>
            <span className="kpi-label">WNS</span>
            <span className="kpi-value">{fmtNs(d.timing.wns_ns)}</span>
          </div>
        ) : null}
        {d.utilization ? (
          <div className="kpi">
            <span className="kpi-label">LUT</span>
            <span className="kpi-value">{fmtPct(d.utilization.lut_pct)}</span>
          </div>
        ) : null}
        {d.drc ? (
          <div className={`kpi ${d.drc.clean ? 'kpi-success' : 'kpi-warn'}`}>
            <span className="kpi-label">DRC</span>
            <span className="kpi-value">
              {d.drc.clean ? 'Clean' : `${d.drc.error_count || 0}E / ${d.drc.warning_count || 0}W`}
            </span>
          </div>
        ) : null}
        {d.bitstream ? (
          <div className={`kpi ${d.bitstream.found ? 'kpi-success' : ''}`}>
            <span className="kpi-label">Bit</span>
            <span className="kpi-value">{d.bitstream.found ? 'Yes' : 'No'}</span>
          </div>
        ) : null}
      </div>
      <h4 style={{ marginTop: 12, fontSize: 13 }}>{t('reports.issues', { defaultValue: 'Issues' })}</h4>
      {issues.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>
          {t('reports.noIssues', { defaultValue: 'No issues detected.' })}
        </p>
      ) : (
        <ul className="report-issue-list">
          {issues.map((it, i) => (
            <li key={i} className={`report-issue report-issue--${it.severity || 'low'}`}>
              <span className="report-issue-cat">{it.category}</span>
              <span>{it.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
