import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { StatusPill } from '../common/StatusPill'
import { request } from '../../api/client'
import '../../styles/chat-cards.css'

interface RunStep {
  id?: string
  name?: string
  capability_id?: string
  state?: string
  elapsed_ms?: number
}

export function RunCard({ data }: { data: Record<string, unknown> }) {
  const { t } = useTranslation()
  const runId = String(data.run_id || '')
  const [steps, setSteps] = useState<RunStep[]>([])
  const state = String(data.state || 'running')
  const flowName = String(data.flow_name || '').replace(/_/g, ' ')

  useEffect(() => {
    if (!runId) return
    const load = () => {
      request<{ steps?: RunStep[] }>(`/api/v1/runs/${runId}/steps`)
        .then((d) => setSteps(d.steps || []))
        .catch(() => {})
    }
    load()
    const tmr = setInterval(load, 3000)
    return () => clearInterval(tmr)
  }, [runId])

  return (
    <div className="syn-card syn-run-card">
      <div className="syn-run-card__header">
        <StatusPill
          status={
            (['queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs_approval'].includes(
              state,
            )
              ? state
              : 'running') as import('../common/StatusPill').StatusKind
          }
        />
        <span className="syn-run-card__title">{flowName || t('chat.run', { defaultValue: 'Run' })}</span>
        {runId && (
          <Link className="syn-run-card__link" to={`/runs/${runId}`}>
            {t('chat.runDetails', { defaultValue: '详情 →' })}
          </Link>
        )}
      </div>
      {steps.length > 0 && (
        <ol className="syn-run-card__steps">
          {steps.map((s, i) => (
            <li key={s.id || i} className={`syn-run-step syn-run-step--${s.state || 'running'}`}>
              <span className="syn-run-step__dot" />
              <span className="syn-run-step__name">{s.name || s.capability_id}</span>
              {s.elapsed_ms != null && (
                <span className="syn-run-step__time">{(s.elapsed_ms / 1000).toFixed(1)}s</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
