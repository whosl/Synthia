import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { listRunSteps } from '../../api/runs'
import { SessionEventStream } from '../../lib/sse'
import { Panel } from '../common/Panel'
import { StatusBadge } from '../common/StatusBadge'
import { formatDuration, formatTime } from '../../lib/time'

const RUN_STEP_EVENTS = new Set([
  'run.step.started',
  'run.step.completed',
  'run.step.failed',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
])

export function StepTimeline({ runId, sessionId }: { runId: string; sessionId?: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['run-steps', runId],
    queryFn: () => listRunSteps(runId),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const steps = query.state.data?.steps ?? []
      const active = steps.some((s) => {
        const state = String(s.state ?? '')
        return state === 'running' || state === 'pending'
      })
      return active ? 2000 : false
    },
  })

  useEffect(() => {
    if (!sessionId || !runId) return
    const stream = new SessionEventStream(sessionId, 0, (evt) => {
      if (evt.run_id !== runId) return
      if (!RUN_STEP_EVENTS.has(evt.event_type)) return
      qc.invalidateQueries({ queryKey: ['run-steps', runId] })
      if (evt.event_type.startsWith('run.')) {
        qc.invalidateQueries({ queryKey: ['run', runId] })
      }
    })
    stream.connect()
    return () => stream.disconnect()
  }, [runId, sessionId, qc])
  const steps = q.data?.steps ?? []

  return (
    <Panel title={t('runDetail.steps')}>
      {steps.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>{t('runDetail.noSteps')}</p>
      ) : (
        steps.map((s) => (
          <div className="event-row" key={String(s.id)}>
            <span className="mono">{String(s.stage)}</span>
            <span>{String(s.name)}</span>
            <StatusBadge status={String(s.state)} />
            <span className="muted">{formatDuration(s.elapsed_ms as number)} · {formatTime(s.started_at as number)}</span>
          </div>
        ))
      )}
    </Panel>
  )
}
