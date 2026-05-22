import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Database, GitMerge, RefreshCw, XCircle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { approveKbCandidate, listKbCandidates, listLegacyErrorKb, mergeKbCandidate, rejectKbCandidate } from '../api/kb'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { Panel } from '../components/common/Panel'

export default function KnowledgeBasePage({ mode = 'kb' }: { mode?: 'kb' | 'knowledge' }) {
  const navigate = useNavigate()

  if (mode === 'knowledge') {
    const kbCasesQ = useQuery({ queryKey: ['legacy-kb'], queryFn: listLegacyErrorKb })
    const cases = kbCasesQ.data?.cases ?? []

    return <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Knowledge Base</h1>
          <p className="page-subtitle">Error KB sources, candidate review, and retrieval audit</p>
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
            <Button className="ghost" disabled title="Requires Phase 2A backend">Reindex Sources</Button>
            <Button className="ghost" onClick={() => navigate('/monitor')}>Retrieval Audits</Button>
          </div>
        </Panel>
      </div>
    </div>
  }

  const { data } = useQuery({ queryKey: ['legacy-kb'], queryFn: listLegacyErrorKb })
  const candidatesQ = useQuery({ queryKey: ['kb-candidates'], queryFn: listKbCandidates })

  return <div className="page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Error KB Review</h1>
        <p className="page-subtitle">Built-in cases, user cases, and pending candidates</p>
      </div>
    </div>
    <div className="dashboard-grid">
      <Panel title="KB Candidates">
        {(candidatesQ.data?.candidates ?? []).length > 0
          ? <table className="table"><thead><tr><th>ID</th><th>Title</th><th>Source</th><th>Score</th><th>Action</th></tr></thead><tbody>{(candidatesQ.data?.candidates ?? []).map((c) => <tr key={c.id}>
            <td className="mono" style={{ fontSize: 11 }}>{c.id}</td>
            <td>{c.title}</td>
            <td className="mono muted" style={{ fontSize: 11 }}>{c.source_run_id || c.source_session_id || '—'}</td>
            <td>{c.confidence}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <Button className="success" onClick={() => approveKbCandidate(c.id)}><CheckCircle2 size={13} /></Button>{' '}
              <Button className="danger" onClick={() => rejectKbCandidate(c.id)}><XCircle size={13} /></Button>{' '}
              <Button className="ghost" onClick={() => mergeKbCandidate(c.id)}><GitMerge size={13} /></Button>
            </td>
          </tr>)}</tbody></table>
          : <EmptyState title="No pending candidates" detail="Candidates are auto-generated from failed runs." />}
      </Panel>
      <Panel title="Built-in Error KB">
        {data?.cases?.length
          ? <div style={{ display: 'grid', gap: 10 }}>{data.cases.slice(0, 10).map((c) => <div className="metric-card" key={c.pattern}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{c.category}</div>
            <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>{c.pattern}</div>
          </div>)}</div>
          : <EmptyState title="KB unavailable" detail="KB API returns data when backend is running." />}
      </Panel>
    </div>
  </div>
}
