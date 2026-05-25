import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { getSessionContext } from '../../api/context'
import type { ContextPackageItem, RetrievalAuditItem } from '../../api/types'
import { formatNumber } from '../../lib/time'

function ItemRow({ item, kind, t }: { item: ContextPackageItem | RetrievalAuditItem; kind: 'context' | 'audit'; t: (key: string, opts?: any) => string }) {
  if (kind === 'context') {
    const ci = item as ContextPackageItem
    const included = Boolean(ci.included)
    return (
      <div className={`context-item ${included ? '' : 'excluded'}`}>
        <div className="context-item-head">
          <span className="mono">{ci.item_type}</span>
          <span>{included ? `${ci.token_count || 0} tok` : t('contextDebug.excluded')}</span>
        </div>
        <div className="context-item-title">{ci.title}</div>
        {ci.truncation_reason && <div className="muted">{t('contextDebug.truncationReason', { reason: ci.truncation_reason })}</div>}
        {ci.content_summary && <pre className="context-excerpt">{ci.content_summary.slice(0, 400)}</pre>}
      </div>
    )
  }
  const ai = item as RetrievalAuditItem
  return (
    <div className="context-item">
      <div className="context-item-head">
        <span className="mono">{ai.source_type}</span>
        <span>score {ai.final_score?.toFixed(2) ?? '—'}</span>
      </div>
      <div className="context-item-title">{ai.title}</div>
      {ai.excerpt && <pre className="context-excerpt">{ai.excerpt.slice(0, 300)}</pre>}
    </div>
  )
}

export function ContextDebugPanel({ sessionId, taskId }: { sessionId: string; taskId?: string | null }) {
  const { t } = useTranslation()
  const ctxQ = useQuery({
    queryKey: ['session-context', sessionId, taskId],
    queryFn: () => getSessionContext(sessionId, taskId || undefined),
    enabled: Boolean(sessionId),
    refetchInterval: 5000,
  })

  const pkg = ctxQ.data?.contexts?.[0]
  const audit = ctxQ.data?.retrieval_audits?.[0]

  if (ctxQ.isLoading) return <div className="muted drawer-hint">{t('contextDebug.loading')}</div>
  if (ctxQ.isError) return <div className="muted drawer-hint">{t('contextDebug.failed')}</div>
  if (!pkg && !audit) return <div className="muted drawer-hint">{t('contextDebug.empty')}</div>

  return (
    <div className="context-debug">
      {pkg && (
        <>
          <div className="kv compact">
            <span>{t('contextDebug.package')}</span>
            <span className="mono">{pkg.package.id}</span>
          </div>
          <div className="kv compact">
            <span>{t('contextDebug.tokens')}</span>
            <span>{formatNumber(pkg.package.total_tokens)} / {formatNumber(pkg.package.max_context_tokens || 0)}</span>
          </div>
          {Boolean(pkg.package.truncated) ? <div className="context-truncated">{t('contextDebug.truncated')}</div> : null}
          {pkg.items.map((item) => (
            <ItemRow key={item.id} item={item} kind="context" t={t} />
          ))}
        </>
      )}
      {audit && (
        <>
          <div className="side-title" style={{ marginTop: 12 }}>{t('contextDebug.retrievalAudit')}</div>
          <div className="kv compact">
            <span>{t('contextDebug.query')}</span>
            <span className="mono" style={{ fontSize: 11 }}>{audit.audit.query?.slice(0, 80)}</span>
          </div>
          <div className="kv compact">
            <span>{t('contextDebug.used')}</span>
            <span>{audit.audit.token_used} / {audit.audit.token_budget}</span>
          </div>
          {audit.items.slice(0, 8).map((item) => (
            <ItemRow key={item.id} item={item} kind="audit" t={t} />
          ))}
        </>
      )}
    </div>
  )
}
