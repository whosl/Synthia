import type { ToolFailureCardModel } from '../../lib/toolPresentation'
import { useTranslation } from 'react-i18next'

function formatElapsed(ms?: number) {
  if (ms == null) return null
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function ToolFailureCard({ model }: { model: ToolFailureCardModel }) {
  const { t } = useTranslation()
  const elapsed = formatElapsed(model.elapsedMs)
  return (
    <div className="tool-failure-card" role="alert">
      <div className="tool-failure-card-title">❌ {model.title}</div>
      <dl className="tool-failure-card-grid">
        {model.stage && (
          <div className="tool-failure-row">
            <dt>{t('toolFailure.stage')}</dt>
            <dd><code>{model.stage}</code></dd>
          </div>
        )}
        <div className="tool-failure-row">
          <dt>{t('toolFailure.error')}</dt>
          <dd className="tool-failure-error">{model.error}</dd>
        </div>
        {elapsed && (
          <div className="tool-failure-row">
            <dt>{t('toolFailure.elapsed')}</dt>
            <dd>{elapsed}</dd>
          </div>
        )}
        <div className="tool-failure-row">
          <dt>{t('toolFailure.action')}</dt>
          <dd>{model.action}</dd>
        </div>
      </dl>
    </div>
  )
}
