import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { artifactDownloadUrl, runArtifactsZipUrl, runSummaryUrl } from '../../api/monitor'
import { Panel } from '../common/Panel'
import { Button } from '../common/Button'
import { formatTime } from '../../lib/time'
import type { Artifact } from '../../api/types'

function fmtBytes(n: number | undefined | null): string {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

interface ArtifactsPanelProps {
  runId: string
  artifacts: Artifact[]
  loading?: boolean
}

export function ArtifactsPanel({ runId, artifacts, loading }: ArtifactsPanelProps) {
  const { t } = useTranslation()
  const grouped = artifacts.reduce<Record<string, Artifact[]>>((acc, a) => {
    const key = String(a.artifact_type || 'other')
    if (!acc[key]) acc[key] = []
    acc[key].push(a)
    return acc
  }, {})

  return (
    <Panel
      title={t('runDetail.artifacts')}
      actions={
        <div style={{ display: 'flex', gap: 6 }}>
          <Button className="ghost" onClick={() => window.open(runSummaryUrl(runId), '_blank')} title={t('runDetail.summaryMdHint', { defaultValue: 'Open summary.md in a new tab' })}>
            summary.md
          </Button>
          {artifacts.length > 0 ? (
            <Button className="ghost" onClick={() => window.open(runArtifactsZipUrl(runId), '_blank')}>
              <Download size={14} /> .zip
            </Button>
          ) : null}
        </div>
      }
    >
      {loading ? (
        <p className="muted" style={{ fontSize: 12 }}>{t('runDetail.loadingArtifacts', { defaultValue: 'Loading artifacts…' })}</p>
      ) : artifacts.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>{t('runDetail.noArtifacts')}</p>
      ) : (
        <div>
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type} style={{ marginBottom: 8 }}>
              <div className="muted mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                {type} · {items.length}
              </div>
              <div className="run-artifacts-list">
                {items.map((a) => (
                  <div className="run-artifacts-row" key={String(a.id)}>
                    <code title={String(a.path)}>{String(a.path)}</code>
                    <span className="muted" style={{ fontSize: 10 }}>{fmtBytes(a.size_bytes)}</span>
                    <span className="sha" title={a.sha256 ? `sha256:${a.sha256}` : ''}>
                      {a.sha256 ? a.sha256.slice(0, 10) : '—'}
                    </span>
                    <a
                      href={artifactDownloadUrl(String(a.id))}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="muted"
                      style={{ fontSize: 11 }}
                    >
                      {t('runDetail.download', { defaultValue: 'download' })}
                    </a>
                  </div>
                ))}
              </div>
              {items[0]?.created_at ? (
                <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
                  {formatTime(items[0].created_at as number)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
