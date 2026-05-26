import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { listRunPatches } from '../../api/runs'
import { Panel } from '../common/Panel'
import { StatusBadge } from '../common/StatusBadge'

export function RunPatchesPanel({ runId }: { runId: string }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['run-patches', runId],
    queryFn: () => listRunPatches(runId),
    enabled: Boolean(runId),
  })
  const patches = q.data?.patches ?? []

  return (
    <Panel title={t('runDetail.patches')}>
      {patches.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>{t('runDetail.noPatches')}</p>
      ) : (
        patches.map((p) => (
          <div className="event-row" key={String(p.id)}>
            <span className="mono">{String(p.target_file)}</span>
            <StatusBadge status={String(p.status)} />
            <span className="muted">{String(p.patch_type)}</span>
          </div>
        ))
      )}
    </Panel>
  )
}
