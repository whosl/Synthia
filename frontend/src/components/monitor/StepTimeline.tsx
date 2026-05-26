import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { listRunSteps } from '../../api/runs'
import { Panel } from '../common/Panel'
import { StatusBadge } from '../common/StatusBadge'
import { formatDuration, formatTime } from '../../lib/time'

export function StepTimeline({ runId }: { runId: string }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['run-steps', runId],
    queryFn: () => listRunSteps(runId),
    enabled: Boolean(runId),
  })
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
