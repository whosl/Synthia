import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, GitMerge, RefreshCw, XCircle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { approveKbCandidate, listKbCandidates, listLegacyErrorKb, mergeKbCandidate, rejectKbCandidate } from '../api/kb'
import { reindexKnowledge } from '../api/knowledge'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { Panel } from '../components/common/Panel'

export default function KnowledgeBasePage({ mode = 'kb' }: { mode?: 'kb' | 'knowledge' }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const kbCasesQ = useQuery({ queryKey: ['legacy-kb'], queryFn: listLegacyErrorKb })
  const candidatesQ = useQuery({ queryKey: ['kb-candidates'], queryFn: listKbCandidates, enabled: mode === 'kb' })
  const invalidateCandidates = () => queryClient.invalidateQueries({ queryKey: ['kb-candidates'] })
  const reindex = useMutation({
    mutationFn: () => reindexKnowledge(),
    onSuccess: (r) => {
      const g = (r as { global?: { indexed_sources?: number; chunks?: number } }).global
      const totalChunks = g?.chunks ?? (r as { chunks?: number }).chunks ?? 0
      const totalSources = g?.indexed_sources ?? (r as { indexed_sources?: number }).indexed_sources ?? 0
      alert(`Indexed ${totalSources} sources, ${totalChunks} chunks`)
      queryClient.invalidateQueries({ queryKey: ['legacy-kb'] })
    },
  })

  if (mode === 'knowledge') {
    const cases = kbCasesQ.data?.cases ?? []

    return <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Knowledge Base</h1>
          <p className="page-subtitle">Semantic KB sources and retrieval</p>
        </div>
        <Button className="ghost" onClick={() => kbCasesQ.refetch()}><RefreshCw size={14} /> Refresh</Button>
      </div>
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title="Error KB Sources" actions={<span className="muted" style={{ fontSize: 12 }}>{cases.length} patterns</span>}>
          {cases.length > 0
            ? <table className="table"><thead><tr><th>Category</th><th>Pattern</th><th>Type</th></tr></thead>
              <tbody>{cases.slice(0, 20).map((c, i) => <tr key={i}><td>{c.category}</td><td className="mono" style={{ fontSize: 12 }}>{c.pattern}</td><td className="muted">built-in</td></tr>)}</tbody></table>
            : <EmptyState title="No KB sources loaded" detail="Start the backend to load built-in error KB cases." />}
        </Panel>
        <Panel title="Actions">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Button className="primary" onClick={() => navigate('/kb')}>Review Candidates</Button>
            <Button className="ghost" onClick={() => reindex.mutate()} disabled={reindex.isPending}>
              {reindex.isPending ? 'Reindexing…' : 'Reindex Sources'}
            </Button>
            <Button className="ghost" onClick={() => navigate('/monitor')}>Retrieval Audits</Button>
          </div>
        </Panel>
      </div>
    </div>
  }

  return <div className="page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Error KB Review</h1>
        <p className="page-subtitle">Built-in cases, user cases, and pending candidates</p>
      </div>
    </div>
    <div className="kb-review-layout">
      <Panel title="KB Candidates" className="kb-candidates-panel">
        {(candidatesQ.data?.candidates ?? []).length > 0
          ? <div className="kb-table-wrap">
            <table className="table kb-candidates-table"><thead><tr><th>ID</th><th>Pattern</th><th>Category</th><th>Likely causes</th><th>Score</th><th>Action</th></tr></thead><tbody>{(candidatesQ.data?.candidates ?? []).map((c) => <tr key={c.id}>
              <td className="mono kb-col-id">{c.id.slice(0, 8)}…</td>
              <td className="kb-col-pattern">{c.title || c.pattern}</td>
              <td className="muted kb-col-category">{c.category}</td>
              <td className="muted kb-col-causes">{(c.likely_causes ?? []).slice(0, 2).join('; ') || '—'}</td>
              <td className="kb-col-score">{c.confidence?.toFixed?.(2) ?? c.confidence}</td>
              <td className="kb-col-actions">
                <Button className="success" onClick={async () => { await approveKbCandidate(c.id); invalidateCandidates() }}><CheckCircle2 size={13} /></Button>{' '}
                <Button className="danger" onClick={async () => { await rejectKbCandidate(c.id); invalidateCandidates() }}><XCircle size={13} /></Button>{' '}
                <Button className="ghost" onClick={async () => { await mergeKbCandidate(c.id); invalidateCandidates() }}><GitMerge size={13} /></Button>
              </td>
            </tr>)}</tbody></table>
          </div>
          : <EmptyState title="No pending candidates" detail="Candidates are auto-generated from failed runs." />}
      </Panel>
      <Panel title="Built-in Error KB" className="kb-builtin-panel">
        {kbCasesQ.data?.cases?.length
          ? <div className="kb-builtin-grid">{kbCasesQ.data!.cases.slice(0, 10).map((c) => <div className="metric-card" key={c.pattern}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{c.category}</div>
            <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>{c.pattern}</div>
          </div>)}</div>
          : <EmptyState title="KB unavailable" detail="KB API returns data when backend is running." />}
      </Panel>
    </div>
  </div>
}
