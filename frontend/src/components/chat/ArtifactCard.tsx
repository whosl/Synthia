import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { artifactDownloadUrl } from '../../api/monitor'
import '../../styles/chat-cards.css'

function fmtBytes(n: number) {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function ArtifactCard({ data }: { data: Record<string, unknown> }) {
  const { t } = useTranslation()
  const path = String(data.path || '')
  const name = path.split('/').pop() || String(data.kind || 'artifact')
  const artifactId = String(data.artifact_id || '')
  const href = artifactId ? artifactDownloadUrl(artifactId) : '#'

  return (
    <div className="syn-card syn-artifact-card">
      <div className="syn-artifact-card__body">
        <div className="syn-artifact-card__name">{name}</div>
        <div className="syn-artifact-card__meta">
          {String(data.kind || 'file')}
          {data.size_bytes != null ? ` · ${fmtBytes(Number(data.size_bytes))}` : ''}
          {data.sha256 ? (
            <span title={String(data.sha256)}>
              {' '}
              · sha256: {String(data.sha256).slice(0, 8)}…
            </span>
          ) : null}
        </div>
      </div>
      {artifactId && (
        <a className="syn-button syn-button--ghost" href={href} download>
          <Download size={14} />
          {t('chat.download', { defaultValue: 'Download' })}
        </a>
      )}
    </div>
  )
}
