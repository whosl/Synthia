import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bug, CircuitBoard, FileText, FolderOpen, Shield, Terminal, Wrench } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { getPatchApproval } from '../../api/settings'
import type { Session } from '../../api/types'
import { getVivadoHealth, runVivadoTcl } from '../../api/vivado'
import { formatNumber, formatRelative, formatTime } from '../../lib/time'
import type { RightPanelTab } from '../../stores/terminalStore'
import type { SessionTimelineState } from '../../timeline/types'
import { StatusBadge } from '../common/StatusBadge'
import { ContextDebugPanel } from './ContextDebugPanel'

const TABS: { id: RightPanelTab; label: string; icon: typeof FileText }[] = [
  { id: 'summary', label: 'Summary', icon: FileText },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'vivado', label: 'Vivado', icon: CircuitBoard },
]

export function TerminalRightPanel({
  sessionId,
  session,
  activeTask,
  streamStatus,
  timeline,
  problemCount,
  tab,
  onTabChange,
}: {
  sessionId: string
  session?: Session
  activeTask?: { id?: string; state?: string } | null
  streamStatus: string
  timeline: SessionTimelineState
  problemCount: number
  tab: RightPanelTab
  onTabChange: (tab: RightPanelTab) => void
}) {
  const approvalQ = useQuery({ queryKey: ['patch-approval'], queryFn: getPatchApproval })

  return (
    <aside className="terminal-right-panel">
      <div className="right-panel-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`right-panel-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => onTabChange(t.id)}
            title={t.label}
          >
            <t.icon size={14} />
            <span className="right-panel-tab-label">{t.label}</span>
          </button>
        ))}
      </div>
      <div className="right-panel-body">
        {tab === 'summary' && (
          <SummaryTab
            sessionId={sessionId}
            session={session}
            activeTask={activeTask}
            streamStatus={streamStatus}
            timeline={timeline}
            problemCount={problemCount}
            patchApproved={approvalQ.data?.approved}
          />
        )}
        {tab === 'terminal' && <RemoteTerminalTab />}
        {tab === 'files' && <PlaceholderTab title="Files" hint="Session folders and multi-session directory management — coming soon." />}
        {tab === 'vivado' && <VivadoTab />}
      </div>
    </aside>
  )
}

function SummaryTab({
  sessionId,
  session,
  activeTask,
  streamStatus,
  timeline,
  problemCount,
  patchApproved,
}: {
  sessionId: string
  session?: Session
  activeTask?: { id?: string; state?: string } | null
  streamStatus: string
  timeline: SessionTimelineState
  problemCount: number
  patchApproved?: boolean
}) {
  return (
    <>
      <section className="drawer-section">
        <div className="side-title">Session</div>
        <div className="kv"><span>ID</span><span className="mono">{sessionId}</span></div>
        <div className="kv"><span>Status</span><span><StatusBadge status={activeTask?.state || session?.status} /></span></div>
        <div className="kv"><span>Created</span><span>{formatTime(session?.created_at)}</span></div>
        <div className="kv"><span>Updated</span><span>{formatRelative(session?.updated_at)}</span></div>
        <div className="kv"><span>Messages</span><span>{formatNumber(session?.message_count)}</span></div>
        <div className="kv"><span>Tools</span><span>{formatNumber(timeline.tools.length || session?.tool_call_count)}</span></div>
        <div className="kv"><span>Problems</span><span style={{ color: problemCount ? 'var(--error)' : undefined }}>{formatNumber(problemCount || session?.problem_count)}</span></div>
      </section>
      <section className="drawer-section">
        <div className="side-title">Stream</div>
        <div className="kv"><span>Status</span><span>{streamStatus}</span></div>
        <div className="kv"><span>Last seq</span><span className="mono">{timeline.lastSeq}</span></div>
      </section>
      <section className="drawer-section">
        <div className="side-title"><FileText size={13} /> Context</div>
        <ContextDebugPanel sessionId={sessionId} taskId={activeTask?.id} />
        <div className="drawer-list" style={{ marginTop: 8 }}>
          <span><Shield size={13} /> Patch: {patchApproved ? 'auto' : 'manual'}</span>
        </div>
      </section>
      <section className="drawer-section">
        <div className="side-title"><Bug size={13} /> Events</div>
        <div className="drawer-list">
          <span>{timeline.auditLog.length} events</span>
          <span>{problemCount} problems</span>
        </div>
      </section>
      <section className="drawer-section">
        <div className="side-title"><Wrench size={13} /> Tools</div>
        <div className="drawer-list">
          {timeline.tools.length === 0 && <span className="muted">No tool calls yet</span>}
          {timeline.tools.slice(-12).map((t) => (
            <span key={t.toolcallId}>{t.name} — {t.state}</span>
          ))}
        </div>
      </section>
    </>
  )
}

function RemoteTerminalTab() {
  const queryClient = useQueryClient()
  const healthQ = useQuery({ queryKey: ['vivado-health'], queryFn: getVivadoHealth, refetchInterval: 15000 })
  const [tclInput, setTclInput] = useState('')
  const [autoApprove, setAutoApprove] = useState(true)
  const [lines, setLines] = useState<string[]>(['# Remote target shell (Vivado Tcl over SSH)', '# Type Tcl commands below — full PTY shell coming later'])

  const handleRun = async () => {
    const cmd = tclInput.trim()
    if (!cmd) return
    setLines((prev) => [...prev, `$ ${cmd}`])
    setTclInput('')
    try {
      const res = await runVivadoTcl(cmd, autoApprove)
      if (res.requires_approval) {
        setLines((prev) => [...prev, '# Policy requires approval — enable auto-approve or approve in chat'])
        return
      }
      if (res.stdout) setLines((prev) => [...prev, ...(res.stdout || '').split('\n').filter(Boolean).slice(-40)])
      if (res.stderr) setLines((prev) => [...prev, ...(res.stderr || '').split('\n').filter(Boolean).slice(-15)])
      setLines((prev) => [...prev, res.ok ? `# ok (${res.elapsed_sec ?? 0}s)` : `# failed: ${res.error || res.exit_code}`])
      await queryClient.invalidateQueries({ queryKey: ['vivado-health'] })
    } catch (e) {
      setLines((prev) => [...prev, `# error: ${e instanceof Error ? e.message : String(e)}`])
    }
  }

  const h = healthQ.data
  return (
    <div className="remote-terminal-tab">
      <div className="drawer-section" style={{ paddingBottom: 8 }}>
        <div className="kv compact"><span>Host</span><span className="mono">{h?.host || '—'}</span></div>
        <div className="kv compact"><span>SSH</span><span><StatusBadge status={h?.reachable ? 'connected' : 'error'} /></span></div>
        {h?.error && <div className="muted drawer-hint">{h.error}</div>}
      </div>
      <div className="remote-console" role="log">{lines.join('\n')}</div>
      <div className="remote-console-input">
        <input
          className="input"
          value={tclInput}
          onChange={(e) => setTclInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleRun() } }}
          placeholder="Tcl on remote Vivado…"
          spellCheck={false}
        />
        <button type="button" className="btn primary" onClick={() => void handleRun()}>Run</button>
      </div>
      <label className="remote-console-opt muted">
        <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
        Auto-approve policy-checked Tcl
      </label>
    </div>
  )
}

function VivadoTab() {
  const { data, isFetching, refetch } = useQuery({ queryKey: ['vivado-health'], queryFn: getVivadoHealth, refetchInterval: 15000 })
  return (
    <div className="drawer-section">
      <div className="side-title">Project runtime</div>
      <div className="kv compact"><span>Reachable</span><span><StatusBadge status={data?.reachable ? 'connected' : 'error'} /></span></div>
      <div className="kv compact"><span>Version</span><span>{data?.version || '—'}</span></div>
      <div className="kv compact"><span>Path</span><span className="mono" style={{ fontSize: 11 }}>{data?.vivado_path || 'vivado'}</span></div>
      <p className="muted drawer-hint" style={{ marginTop: 12 }}>
        Synthesis logs, bitstream status, and project metadata will appear here.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost" onClick={() => void refetch()} disabled={isFetching}>Refresh</button>
        <Link to="/vivado" className="btn ghost">Open Vivado page →</Link>
      </div>
    </div>
  )
}

function PlaceholderTab({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="drawer-section placeholder-tab">
      <div className="side-title">{title}</div>
      <p className="muted drawer-hint">{hint}</p>
    </div>
  )
}
