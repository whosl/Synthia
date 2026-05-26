import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Play, RefreshCw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import { getRun, getRunContext, getRunWorkspace, listRunArtifacts, listRunEvents, listRunProblems, listRunToolRequests, rerunRun, stopRun } from '../api/monitor'
import { Button } from '../components/common/Button'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { formatDuration, formatNumber, formatTime } from '../lib/time'
import { ArtifactsPanel } from '../components/reports/ArtifactsPanel'
import { StructuredReportsPanel } from '../components/reports/StructuredReportsPanel'
import { StepTimeline } from '../components/monitor/StepTimeline'
import { RunPatchesPanel } from '../components/monitor/RunPatchesPanel'

export default function RunDetailPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { runId = '' } = useParams()
  const { data, refetch } = useQuery({ queryKey: ['run', runId], queryFn: () => getRun(runId), enabled: Boolean(runId) })
  const eventsQ = useQuery({ queryKey: ['run-events', runId], queryFn: () => listRunEvents(runId), enabled: Boolean(runId) })
  const artifactsQ = useQuery({ queryKey: ['run-artifacts', runId], queryFn: () => listRunArtifacts(runId), enabled: Boolean(runId) })
  const problemsQ = useQuery({ queryKey: ['run-problems', runId], queryFn: () => listRunProblems(runId), enabled: Boolean(runId) })
  const contextQ = useQuery({ queryKey: ['run-context', runId], queryFn: () => getRunContext(runId), enabled: Boolean(runId) })
  const toolReqQ = useQuery({ queryKey: ['run-tool-requests', runId], queryFn: () => listRunToolRequests(runId), enabled: Boolean(runId) })
  const wsQ = useQuery({ queryKey: ['run-workspace', runId], queryFn: () => getRunWorkspace(runId), enabled: Boolean(runId) })
  const rerunM = useMutation({
    mutationFn: () => rerunRun(runId, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', runId] }),
  })
  const stopM = useMutation({
    mutationFn: () => stopRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['run', runId] })
      qc.invalidateQueries({ queryKey: ['run-steps', runId] })
    },
  })
  const run = data?.run
  const canStop = Boolean(run?.state && !['done', 'succeeded', 'failed', 'cancelled', 'policy_denied'].includes(String(run.state)))
  const toolcalls = data?.toolcalls ?? []
  const usage = data?.usage ?? []
  const totalIn = usage.reduce((a, u) => a + (u.input_tokens || 0), 0)
  const totalOut = usage.reduce((a, u) => a + (u.output_tokens || 0), 0)
  const longest = Math.max(1, ...toolcalls.map((c) => c.elapsed_ms || 250))

  const handleExport = () => {
    const blob = new Blob([JSON.stringify({ run, toolcalls, usage, events: eventsQ.data?.events, problems: problemsQ.data?.problems, context: contextQ.data, artifacts: artifactsQ.data?.artifacts }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `run-${runId}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  return <div className="page">
    <PageStickyTop>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('runDetail.title')}</h1>
          <p className="page-subtitle mono">{runId}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canStop ? (
            <Button className="ghost" onClick={() => stopM.mutate()} disabled={stopM.isPending}>
              <Square size={14} /> {t('runDetail.stop', { defaultValue: 'Stop' })}
            </Button>
          ) : null}
          <Button className="ghost" onClick={() => rerunM.mutate()} disabled={rerunM.isPending}>
            <Play size={14} /> {t('runDetail.rerun')}
          </Button>
          <Button className="ghost" onClick={() => refetch()}><RefreshCw size={14} /> {t('runDetail.refresh')}</Button>
          <Button className="ghost" onClick={handleExport}><Download size={14} /> {t('runDetail.export')}</Button>
        </div>
      </div>
    </PageStickyTop>
    <div className="run-detail-grid">
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title={t('runDetail.overview')}>
          <div className="kv"><span>{t('runDetail.session')}</span><span className="mono">{run?.session_id || '—'}</span></div>
          <div className="kv"><span>{t('runDetail.runId')}</span><span className="mono">{run?.id || runId}</span></div>
          <div className="kv"><span>{t('runDetail.status')}</span><span><StatusBadge status={run?.state} /></span></div>
          <div className="kv"><span>{t('runDetail.started')}</span><span>{formatTime(run?.started_at)}</span></div>
          <div className="kv"><span>{t('runDetail.duration')}</span><span>{formatDuration(run?.elapsed_ms)}</span></div>
          <div className="kv"><span>{t('runDetail.type')}</span><span className="mono">{run?.run_type || '—'}</span></div>
        </Panel>
        <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="metric-card"><div className="metric-label">{t('runDetail.toolCalls')}</div><div className="metric-value">{toolcalls.length}</div></div>
          <div className="metric-card"><div className="metric-label">{t('runDetail.tokens')}</div><div className="metric-value">{formatNumber(totalIn + totalOut)}</div></div>
          <div className="metric-card"><div className="metric-label">{t('runDetail.input')}</div><div className="metric-value">{formatNumber(totalIn)}</div></div>
          <div className="metric-card"><div className="metric-label">{t('runDetail.output')}</div><div className="metric-value">{formatNumber(totalOut)}</div></div>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title={t('runDetail.toolCallTimeline')}>
          <div className="timeline-bars">{toolcalls.length ? toolcalls.map((c) => <div className="timeline-bar" key={c.id}>
            <span className="mono">{c.tool_name}</span>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(8, ((c.elapsed_ms || 250) / longest) * 100)}%` }}>{formatDuration(c.elapsed_ms)}</div></div>
            <StatusBadge status={c.state} />
          </div>) : <div className="muted" style={{ padding: 12 }}>{t('runDetail.noToolCalls')}</div>}</div>
        </Panel>
        <div className="dashboard-grid">
          <Panel title={t('runDetail.events')}>{(eventsQ.data?.events ?? []).slice(0, 8).map((e) => <div className="event-row" key={e.id}><span className="mono muted">#{e.seq}</span><span>{e.event_type}</span><span className="muted">{formatTime(e.created_at)}</span></div>)}</Panel>
          <Panel title={t('runDetail.problems')}>{(problemsQ.data?.problems ?? []).length ? problemsQ.data!.problems.map((p) => <div className="problem-row" key={p.id}><span className={`status ${p.severity || 'warning'}`}>{p.severity || 'INFO'}</span><span>{p.message}</span><span className="muted">{p.source}</span></div>) : <div className="problem-row"><span className="status idle">{t('runDetail.ok')}</span><span className="muted">{t('runDetail.noProblems')}</span><span /></div>}</Panel>
        </div>
        <Panel title={t('runDetail.workspace')}>
          {wsQ.data?.workspace_root ? (
            <>
              <div className="kv"><span>{t('runDetail.workspaceRoot')}</span><span className="mono" style={{ fontSize: 11 }}>{wsQ.data.workspace_root}</span></div>
              {Object.entries(wsQ.data.subdirs ?? {}).slice(0, 6).map(([k, v]) => (
                <div className="event-row" key={k}><span className="mono">{k}</span><span className="muted mono" style={{ fontSize: 10 }}>{v}</span></div>
              ))}
            </>
          ) : (
            <p className="muted">{t('runDetail.noWorkspace')}</p>
          )}
        </Panel>
        <Panel title={t('runDetail.toolRequests')}>
          {(toolReqQ.data?.requests ?? []).length
            ? toolReqQ.data!.requests.map((req) => (
              <div className="event-row" key={req.id}>
                <span className="mono">{req.capability_id}</span>
                <span className="muted">{req.connector_id}</span>
                <StatusBadge status={req.status || 'pending'} />
              </div>
            ))
            : <p className="muted">{t('runDetail.noToolRequests')}</p>}
        </Panel>
        <StepTimeline runId={runId} sessionId={run?.session_id ?? undefined} />
        <StructuredReportsPanel runId={runId} />
        <RunPatchesPanel runId={runId} />
        <div className="dashboard-grid">
          <Panel title={t('runDetail.contextAudit')}>
            {(contextQ.data?.contexts ?? []).slice(0, 1).map((ctx) => <div key={ctx.package.id}>
              <div className="kv"><span>{t('runDetail.package')}</span><span className="mono">{ctx.package.id}</span></div>
              <div className="kv"><span>{t('runDetail.tokens')}</span><span>{ctx.package.total_tokens || 0}</span></div>
              {ctx.items.slice(0, 6).map((item) => <div className="event-row" key={item.id}><span>{item.item_type}</span><span>{item.title}</span><span className="muted">{item.token_count}</span></div>)}
            </div>)}
          </Panel>
          <ArtifactsPanel
            runId={runId}
            artifacts={artifactsQ.data?.artifacts ?? []}
            loading={artifactsQ.isLoading}
          />
        </div>
      </div>
    </div>
  </div>
}