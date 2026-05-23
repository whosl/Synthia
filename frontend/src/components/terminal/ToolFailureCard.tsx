import type { ToolFailureCardModel } from '../../lib/toolPresentation'

function formatElapsed(ms?: number) {
  if (ms == null) return null
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function ToolFailureCard({ model }: { model: ToolFailureCardModel }) {
  const elapsed = formatElapsed(model.elapsedMs)
  return (
    <div className="tool-failure-card" role="alert">
      <div className="tool-failure-card-title">❌ {model.title}</div>
      <dl className="tool-failure-card-grid">
        {model.stage && (
          <div className="tool-failure-row">
            <dt>Stage</dt>
            <dd><code>{model.stage}</code></dd>
          </div>
        )}
        <div className="tool-failure-row">
          <dt>Error</dt>
          <dd className="tool-failure-error">{model.error}</dd>
        </div>
        {elapsed && (
          <div className="tool-failure-row">
            <dt>Elapsed</dt>
            <dd>{elapsed}</dd>
          </div>
        )}
        <div className="tool-failure-row">
          <dt>Action</dt>
          <dd>{model.action}</dd>
        </div>
      </dl>
    </div>
  )
}
