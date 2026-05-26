import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

interface Finding {
  rule?: string
  severity?: string
  severity_rank?: number
  category?: string
  message?: string
  suggested_action?: string
}

interface MethodologyData {
  findings?: Finding[]
  count?: number
  by_severity?: Record<string, number>
  by_category?: Record<string, number>
}

export function MethodologyCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as MethodologyData
  const findings = d.findings ?? []
  const bySev = Object.entries(d.by_severity ?? {}).filter(([, n]) => n > 0)
  return (
    <div className="report-card">
      <div className="report-card-head">
        <span className="report-card-title">{t('reports.methodology')}</span>
        <span className="muted mono" style={{ fontSize: 11 }}>{report.stage} · {d.count ?? findings.length}</span>
      </div>
      {findings.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('reports.noFindings')}</p>
      ) : (
        <>
          {bySev.length > 0 ? (
            <div className="report-meta-row" style={{ flexWrap: 'wrap', gap: 4 }}>
              {bySev.map(([sev, n]) => (
                <span key={sev} className={`pill ${sev === 'error' ? 'neg' : sev === 'critical warning' ? 'warn' : 'muted'}`}>
                  {sev}: {n}
                </span>
              ))}
            </div>
          ) : null}
          <ul className="report-list">
            {findings.slice(0, 8).map((f, i) => (
              <li key={i}>
                <span className={`status ${(f.severity_rank ?? 0) >= 2 ? 'error' : 'warning'}`}>{f.rule}</span>
                {f.category ? <span className="muted mono" style={{ fontSize: 10 }}>{f.category}</span> : null}
                <span>{f.message}</span>
                {f.suggested_action ? (
                  <span className="muted" style={{ fontSize: 11, fontStyle: 'italic' }}>
                    → {f.suggested_action}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
