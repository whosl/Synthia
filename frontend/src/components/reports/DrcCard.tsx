import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

interface DrcItem {
  rule?: string
  severity?: string
  category?: string
  message?: string
  suggested_action?: string
}

interface DrcData {
  errors?: DrcItem[]
  warnings?: DrcItem[]
  clean?: boolean
  by_category?: Record<string, number>
}

export function DrcCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as DrcData
  const errors = d.errors ?? []
  const warnings = d.warnings ?? []
  const byCategory = Object.entries(d.by_category ?? {})
  const items = [...errors, ...warnings]
  return (
    <div className="report-card">
      <div className="report-card-head">
        <span className="report-card-title">{t('reports.drc')}</span>
        <span className="muted mono" style={{ fontSize: 11 }}>{report.stage}</span>
      </div>
      {d.clean ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('reports.drcClean')}</p>
      ) : (
        <>
          <div className="report-meta-row">
            <span className="pill neg">{t('reports.drcErrors', { defaultValue: 'Errors' })}: {errors.length}</span>
            <span className="pill warn">{t('reports.drcWarnings', { defaultValue: 'Warnings' })}: {warnings.length}</span>
          </div>
          {byCategory.length > 0 ? (
            <div className="report-meta-row" style={{ flexWrap: 'wrap', gap: 4 }}>
              {byCategory.map(([cat, n]) => (
                <span key={cat} className="pill muted">{cat}: {n}</span>
              ))}
            </div>
          ) : null}
          <ul className="report-list">
            {items.slice(0, 10).map((item, i) => (
              <li key={i}>
                <span className={`status ${item.severity?.includes('error') ? 'error' : 'warning'}`}>
                  {item.rule || 'DRC'}
                </span>
                {item.category ? <span className="muted mono" style={{ fontSize: 10 }}>{item.category}</span> : null}
                <span>{item.message}</span>
                {item.suggested_action ? (
                  <span className="muted" style={{ fontSize: 11, fontStyle: 'italic' }}>
                    → {item.suggested_action}
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
