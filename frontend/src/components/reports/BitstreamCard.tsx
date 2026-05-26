import { useTranslation } from 'react-i18next'
import type { ParsedReportRow } from '../../api/connectors'

interface BitFile {
  path: string
  kind: string
  size_bytes: number
  sha256?: string
  mtime?: number
}

interface BitstreamData {
  found?: boolean
  count?: number
  primary_bit?: string
  files?: BitFile[]
}

function fmtBytes(n: number): string {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function BitstreamCard({ report }: { report: ParsedReportRow }) {
  const { t } = useTranslation()
  const d = (report.data || {}) as BitstreamData
  const files = d.files ?? []
  return (
    <div className="report-card">
      <div className="report-card-head">
        <span className="report-card-title">{t('reports.bitstream', { defaultValue: 'Bitstream' })}</span>
        <span className="muted mono" style={{ fontSize: 11 }}>{report.stage}</span>
      </div>
      {!d.found && files.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          {t('reports.bitstreamMissing', { defaultValue: 'No bitstream files found in this run workspace.' })}
        </p>
      ) : (
        <>
          <div className="report-meta-row">
            <span className={`pill ${d.found ? 'ok' : 'neg'}`}>
              {t('reports.bitstreamFound', { defaultValue: 'Bit' })}: {d.found ? '✓' : '✗'}
            </span>
            <span className="pill muted">{t('reports.bitstreamCount', { defaultValue: 'Files' })}: {d.count ?? files.length}</span>
          </div>
          {d.primary_bit ? (
            <p className="mono" style={{ fontSize: 11, wordBreak: 'break-all', margin: '6px 0' }}>{d.primary_bit}</p>
          ) : null}
          <table className="report-table" style={{ marginTop: 8 }}>
            <thead><tr><th>Kind</th><th>Path</th><th>Size</th><th>SHA256</th></tr></thead>
            <tbody>
              {files.slice(0, 12).map((f) => (
                <tr key={f.path}>
                  <td className="mono">{f.kind}</td>
                  <td><code style={{ fontSize: 11 }}>{f.path.split('/').slice(-3).join('/')}</code></td>
                  <td>{fmtBytes(f.size_bytes)}</td>
                  <td className="mono muted" style={{ fontSize: 10 }}>{f.sha256 ? f.sha256.slice(0, 12) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
