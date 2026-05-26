import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

type DrcItem = { rule?: string; severity?: string; message?: string }

export function DrcCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as { errors?: DrcItem[]; warnings?: DrcItem[]; clean?: boolean }
  const errors = d.errors ?? []
  const warnings = d.warnings ?? []
  return (
    <div className="report-card">
      <div className="report-card-head">
        <span className="report-card-title">{t('reports.drc')}</span>
        <span className="muted mono" style={{ fontSize: 11 }}>{report.stage}</span>
      </div>
      {d.clean ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('reports.drcClean')}</p>
      ) : (
        <ul className="report-list">
          {[...errors, ...warnings].slice(0, 8).map((item, i) => (
            <li key={i}>
              <span className={`status ${item.severity?.includes('error') ? 'error' : 'warning'}`}>
                {item.rule || 'DRC'}
              </span>
              <span>{item.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
