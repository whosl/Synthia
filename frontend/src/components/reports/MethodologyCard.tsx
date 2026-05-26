import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

type Finding = { rule?: string; severity?: string; message?: string }

export function MethodologyCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as { findings?: Finding[]; count?: number }
  const findings = d.findings ?? []
  return (
    <div className="report-card">
      <div className="report-card-head">
        <span className="report-card-title">{t('reports.methodology')}</span>
        <span className="muted mono" style={{ fontSize: 11 }}>{report.stage} · {d.count ?? findings.length}</span>
      </div>
      {findings.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('reports.noFindings')}</p>
      ) : (
        <ul className="report-list">
          {findings.slice(0, 6).map((f, i) => (
            <li key={i}>
              <span className="status warning">{f.rule}</span>
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
