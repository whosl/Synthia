import { useQuery } from '@tanstack/react-query'
import { Download, RefreshCw } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { getRun, getRunContext, listRunArtifacts, listRunEvents, listRunProblems } from '../api/monitor'
import { Button } from '../components/common/Button'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { formatDuration, formatNumber, formatTime } from '../lib/time'

export default function RunDetailPage() {
  const { runId = '' } = useParams()
  const { data, refetch } = useQuery({ queryKey: ['run', runId], queryFn: () => getRun(runId), enabled: Boolean(runId) })
  const eventsQ = useQuery({ queryKey: ['run-events', runId], queryFn: () => listRunEvents(runId), enabled: Boolean(runId) })
  const artifactsQ = useQuery({ queryKey: ['run-artifacts', runId], queryFn: () => listRunArtifacts(runId), enabled: Boolean(runId) })
  const problemsQ = useQuery({ queryKey: ['run-problems', runId], queryFn: () => listRunProblems(runId), enabled: Boolean(runId) })
  const contextQ = useQuery({ queryKey: ['run-context', runId], queryFn: () => getRunContext(runId), enabled: Boolean(runId) })
  const run = data?.run
  const toolcalls = data?.toolcalls ?? []
  const usage = data?.usage ?? []
  const totalIn = usage.reduce((a, u) => a + (u.input_tokens || 0), 0)
  const totalOut = usage.reduce((a, u) => a + (u.output_tokens || 0), 0)
  const longest = Math.max(1, ...toolcalls.map((t) => t.elapsed_ms || 250))

  const handleExport = () => {
    const blob = new Blob([JSON.stringify({ run, toolcalls, usage, events: eventsQ.data?.events, problems: problemsQ.data?.problems, context: contextQ.data, artifacts: artifactsQ.data?.artifacts }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `run-${runId}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  return <div className="page">
    <div className="page-header"><div><h1 className="page-title">Run Detail</h1><p className="page-subtitle mono">{runId}</p></div><div><Button className="ghost" onClick={() => refetch()}><RefreshCw size={14} /> Refresh</Button> <Button className="ghost" onClick={handleExport}><Download size={14} /> Export</Button></div></div>
    <div className="run-detail-grid">
      <div style={{ display: 'grid', gap: 12 }}>
        <Panel title="Run Overview">
          <div className="kv"><span>Session</span><span className="mono">{run?.session_id || '—'}</span></div>
          <div className="kv"><span>Run ID</span><span className="mono">{run?.id || runId}</span></div>
          <div className="kv"><span>Status</span><span><StatusBadge status={run?.state} /></span></div>
          <div className="kv"><span>Started</span><span>{formatTime(run?.started_at)}</span></div>
          <div className="kv"><span>Duration</span><span>{formatDuration(run?.elapsed_ms)}</span></div>
          <div className="kv"><span>Type</span><span>{run?.run_type || '—'}</span></div>
        </Panel>
        <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="metric-card"><div className="metric-label">Tool Calls</div><div className="metric-value">{toolcalls.length}</div></div>
          <div className="metric-card"><div className="metric-label">Tokens</div><div className="metric-value">{formatNumber(totalIn + totalOut)}</div></div>
          <div className="metric-card"><div className="metric-label">Input</div><div className="metric-value">{formatNumber(totalIn)}</div></div>
          <div className="metric-card"><div className="metric-label">Output</div><div className="metric-value">{formatNumber(totalOut)}</div></div>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <Panel title="Tool Call Timeline">
          <div className="timeline-bars">{toolcalls.map((t) => <div className="timeline-bar" key={t.id}>
            <span className="mono">{t.tool_name}</span><div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(8, ((t.elapsed_ms || 250) / longest) * 100)}%` }}>{formatDuration(t.elapsed_ms)}</div></div><StatusBadge status={t.state} />
          </div>) || <span className="muted">No tool calls</span>}</div>
        </Panel>
        <div className="dashboard-grid">
          <Panel title="Event Timeline">{(eventsQ.data?.events ?? []).slice(0, 8).map((e) => <div className="event-row" key={e.id}><span className="mono">#{e.seq}</span><span>{e.event_type}</span><span className="muted">{formatTime(e.created_at)}</span></div>)}</Panel>
          <Panel title="Problems">{(problemsQ.data?.problems ?? []).length ? problemsQ.data!.problems.map((p) => <div className="problem-row" key={p.id}><span className={`status ${p.severity || 'warning'}`}>{p.severity || 'INFO'}</span><span>{p.message}</span><span className="muted">{p.source}</span></div>) : <div className="problem-row"><span className="status idle">INFO</span><span>No problems recorded for this run.</span><span className="muted">—</span></div>}</Panel>
        </div>
        <div className="dashboard-grid">
          <Panel title="Context Audit">
            {(contextQ.data?.contexts ?? []).slice(0, 1).map((ctx) => <div key={ctx.package.id}>
              <div className="kv"><span>Package</span><span className="mono">{ctx.package.id}</span></div>
              <div className="kv"><span>Tokens</span><span>{ctx.package.total_tokens || 0}</span></div>
              {ctx.items.slice(0, 6).map((item) => <div className="event-row" key={item.id}><span>{item.item_type}</span><span>{item.title}</span><span className="muted">{item.token_count}</span></div>)}
            </div>)}
          </Panel>
          <Panel title="Artifacts">
            {(artifactsQ.data?.artifacts ?? []).length ? artifactsQ.data!.artifacts.map((a) => <div className="event-row" key={a.id}><span>{a.artifact_type}</span><span className="mono">{a.path}</span><span className="muted">{formatTime(a.created_at)}</span></div>) : <div className="event-row"><span>—</span><span>No artifacts recorded.</span><span /></div>}
          </Panel>
        </div>
      </div>
    </div>
  </div>
}
