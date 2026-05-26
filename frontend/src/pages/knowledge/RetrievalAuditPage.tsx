import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { listRunsApi } from '../../api/runs'
import { getRunContext } from '../../api/monitor'
import { Panel } from '../../components/common/Panel'

export default function RetrievalAuditPage() {
  const { t } = useTranslation()
  const runsQ = useQuery({ queryKey: ['kb-retrieval-runs'], queryFn: () => listRunsApi({ limit: 5 }) })
  const runId = runsQ.data?.runs?.[0]?.id ?? ''
  const ctxQ = useQuery({
    queryKey: ['kb-retrieval', runId],
    queryFn: () => getRunContext(runId),
    enabled: Boolean(runId),
  })
  const audits = ctxQ.data?.retrieval_audits ?? []

  return (
    <Panel title={t('knowledge.retrieval')}>
      {runId && <p className="muted mono" style={{ fontSize: 12, marginBottom: 8 }}>run: {runId}</p>}
      {audits.map(({ audit, items }) => (
        <div key={audit.id} className="event-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <span className="mono">{audit.query?.slice(0, 80) || audit.id}</span>
          <span className="muted" style={{ fontSize: 11 }}>
            {items.length} items · budget {audit.token_budget} / used {audit.token_used}
          </span>
        </div>
      ))}
      {!audits.length && <p className="muted">{t('knowledge.emptyRetrieval')}</p>}
    </Panel>
  )
}
