import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, GitMerge, RefreshCw, Sparkles, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  approveKbCandidate,
  listKbCandidates,
  listLegacyErrorKb,
  mergeKbCandidate,
  rejectKbCandidate,
} from '../api/kb'
import { listEvolutionCandidates } from '../api/evolution'
import { reindexKnowledge } from '../api/knowledge'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { formatTime } from '../lib/time'

export function EvolutionKbTab({
  onOpenEvolutionCandidate,
}: {
  onOpenEvolutionCandidate: (id: string) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const kbCasesQ = useQuery({ queryKey: ['legacy-kb'], queryFn: listLegacyErrorKb })
  const legacyCandidatesQ = useQuery({ queryKey: ['kb-candidates'], queryFn: listKbCandidates })
  const evolutionKbQ = useQuery({
    queryKey: ['evolution', 'candidates', 'kb-tab'],
    queryFn: () =>
      listEvolutionCandidates({
        status: 'pending',
        surface: 'kb',
        limit: 200,
      }),
    refetchInterval: 6000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['kb-candidates'] })
    queryClient.invalidateQueries({ queryKey: ['evolution'] })
    queryClient.invalidateQueries({ queryKey: ['legacy-kb'] })
  }

  const reindex = useMutation({
    mutationFn: () => reindexKnowledge(),
    onSuccess: (r) => {
      const g = (r as { global?: { indexed_sources?: number; chunks?: number } }).global
      const totalChunks = g?.chunks ?? (r as { chunks?: number }).chunks ?? 0
      const totalSources = g?.indexed_sources ?? (r as { indexed_sources?: number }).indexed_sources ?? 0
      alert(t('knowledge.indexed', { sources: totalSources, chunks: totalChunks }))
      queryClient.invalidateQueries({ queryKey: ['legacy-kb'] })
    },
  })

  const legacyCandidates = legacyCandidatesQ.data?.candidates ?? []
  const evolutionKbCandidates = evolutionKbQ.data?.candidates ?? []
  const cases = kbCasesQ.data?.cases ?? []

  return (
    <div className="evolution-kb-tab">
      <Panel
        title={t('evolution.kbTab.actions')}
        className="evolution-kb-actions-panel"
      >
        <div className="evolution-kb-actions">
          <Button className="ghost" onClick={() => invalidate()}>
            <RefreshCw size={14} /> {t('knowledge.refresh')}
          </Button>
          <Button className="ghost" onClick={() => reindex.mutate()} disabled={reindex.isPending}>
            {reindex.isPending ? t('knowledge.reindexing') : t('knowledge.reindexSources')}
          </Button>
          <Button className="ghost" onClick={() => navigate('/monitor')}>
            {t('knowledge.retrievalAudits')}
          </Button>
        </div>
      </Panel>

      <div className="evolution-kb-grid">
        <Panel
          title={t('evolution.kbTab.legacyCandidates')}
          actions={
            <span className="muted" style={{ fontSize: 11 }}>
              {legacyCandidates.length} {t('evolution.kbTab.pending')}
            </span>
          }
          className="evolution-kb-panel"
        >
          {legacyCandidates.length > 0 ? (
            <div className="kb-table-wrap">
              <table className="table kb-candidates-table">
                <thead>
                  <tr>
                    <th>{t('knowledge.tableId')}</th>
                    <th>{t('knowledge.tablePattern')}</th>
                    <th>{t('knowledge.tableCategory')}</th>
                    <th>{t('knowledge.tableCauses')}</th>
                    <th>{t('knowledge.tableScore')}</th>
                    <th>{t('knowledge.tableAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {legacyCandidates.map((c) => (
                    <tr key={c.id}>
                      <td className="mono kb-col-id">{c.id.slice(0, 8)}…</td>
                      <td className="kb-col-pattern">{c.title || c.pattern}</td>
                      <td className="muted kb-col-category">{c.category}</td>
                      <td className="muted kb-col-causes">
                        {(c.likely_causes ?? []).slice(0, 2).join('; ') || '—'}
                      </td>
                      <td className="kb-col-score">{c.confidence?.toFixed?.(2) ?? c.confidence}</td>
                      <td className="kb-col-actions">
                        <Button
                          className="success"
                          onClick={async () => {
                            await approveKbCandidate(c.id)
                            invalidate()
                          }}
                        >
                          <CheckCircle2 size={13} />
                        </Button>{' '}
                        <Button
                          className="danger"
                          onClick={async () => {
                            await rejectKbCandidate(c.id)
                            invalidate()
                          }}
                        >
                          <XCircle size={13} />
                        </Button>{' '}
                        <Button
                          className="ghost"
                          onClick={async () => {
                            await mergeKbCandidate(c.id)
                            invalidate()
                          }}
                        >
                          <GitMerge size={13} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title={t('knowledge.noPendingCandidates')}
              detail={t('knowledge.noPendingCandidatesDetail')}
            />
          )}
        </Panel>

        <Panel
          title={t('evolution.kbTab.evolutionCandidates')}
          actions={
            <span className="muted" style={{ fontSize: 11 }}>
              {evolutionKbCandidates.length} {t('evolution.kbTab.pending')}
            </span>
          }
          className="evolution-kb-panel"
        >
          {evolutionKbCandidates.length > 0 ? (
            <ul className="evolution-list">
              {evolutionKbCandidates.map((c) => (
                <li key={c.id} className="evolution-list-item">
                  <button
                    type="button"
                    className="evolution-list-row"
                    onClick={() => onOpenEvolutionCandidate(c.id)}
                  >
                    <div className="evolution-list-row-top">
                      <span className="evolution-surface tag-kb">{t('evolution.surfaces.knowledgeBase')}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="evolution-list-row-title">{c.title}</div>
                    <div className="evolution-list-row-meta muted">
                      <span>{c.scope}</span>
                      <span>·</span>
                      <span>{c.created_by}</span>
                      <span>·</span>
                      <span>{formatTime(c.created_at)}</span>
                    </div>
                  </button>
                  <Sparkles size={14} className="evolution-list-chevron muted" />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title={t('evolution.kbTab.noEvolutionKb')}
              detail={t('evolution.kbTab.noEvolutionKbDetail')}
            />
          )}
        </Panel>
      </div>

      <Panel
        title={t('evolution.kbTab.catalog')}
        actions={
          <span className="muted" style={{ fontSize: 12 }}>
            {cases.length} {t('knowledge.patterns')}
          </span>
        }
      >
        {cases.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('knowledge.tableCategory')}</th>
                <th>{t('knowledge.tablePattern')}</th>
                <th>{t('knowledge.tableType')}</th>
              </tr>
            </thead>
            <tbody>
              {cases.slice(0, 50).map((c, i) => (
                <tr key={c.id ?? `${c.pattern}-${i}`}>
                  <td>{c.category}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.pattern}</td>
                  <td className="muted">{c.source === 'builtin' ? t('knowledge.builtIn') : t('evolution.kbTab.approved')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title={t('knowledge.noSources')} detail={t('knowledge.noSourcesDetail')} />
        )}
      </Panel>
    </div>
  )
}
