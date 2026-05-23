import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Bug, CircuitBoard, ExternalLink, FileText, FolderOpen, RefreshCw, Shield, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getApprovals, setPatchApproval, setVivadoApproval } from '../../api/settings'
import type { Session } from '../../api/types'
import { getVivadoHealth, runVivadoTcl } from '../../api/vivado'
import { formatNumber, formatRelative } from '../../lib/time'
import type { RightPanelTab } from '../../stores/terminalStore'
import type { InteractionEntryPayload, SessionTimelineState } from '../../timeline/types'
import { StatusBadge } from '../common/StatusBadge'
import { ContextDebugPanel } from './ContextDebugPanel'

const TABS: { id: RightPanelTab; label: string; icon: typeof FileText }[] = [
  { id: 'run', label: 'Run', icon: Activity },
  { id: 'artifacts', label: 'Artifacts', icon: FolderOpen },
  { id: 'vivado', label: 'Vivado', icon: CircuitBoard },
  { id: 'debug', label: 'Debug', icon: Bug },
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
  onClose,
}: {
  sessionId: string
  session?: Session
  activeTask?: { id?: string; state?: string } | null
  streamStatus: string
  timeline: SessionTimelineState
  problemCount: number
  tab: RightPanelTab
  onTabChange: (tab: RightPanelTab) => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const approvalQ = useQuery({ queryKey: ['approvals'], queryFn: getApprovals })
  const [patchLocal, setPatchLocal] = useState<boolean | null>(null)
  const [vivadoLocal, setVivadoLocal] = useState<boolean | null>(null)

  useEffect(() => {
    if (approvalQ.data) {
      setPatchLocal(approvalQ.data.patch_approved)
      setVivadoLocal(approvalQ.data.vivado_execution_approved)
    }
  }, [approvalQ.data?.patch_approved, approvalQ.data?.vivado_execution_approved])

  const patchApprove = useMutation({
    mutationFn: setPatchApproval,
    onMutate: async (approved) => {
      setApprovalError(null)
      setPatchLocal(approved)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['approvals'] }),
    onError: (err: Error) => {
      setPatchLocal(null)
      setApprovalError(err.message || 'Failed to update file patch approval')
    },
  })
  const vivadoApprove = useMutation({
    mutationFn: setVivadoApproval,
    onMutate: async (approved) => {
      setApprovalError(null)
      setVivadoLocal(approved)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['approvals'] }),
    onError: (err: Error) => {
      setVivadoLocal(null)
      setApprovalError(err.message || 'Failed to update Vivado approval')
    },
  })

  return (
    <aside className="terminal-right-panel" aria-label="Session inspector">
      <div className="right-panel-topbar">
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
        <button type="button" className="right-panel-close" onClick={onClose} aria-label="Close session inspector">
          <X size={15} />
        </button>
      </div>
      <div className="right-panel-body">
        {tab === 'run' && (
          <RunTab
            sessionId={sessionId}
            session={session}
            activeTask={activeTask}
            streamStatus={streamStatus}
            timeline={timeline}
            problemCount={problemCount}
            patchApproved={patchLocal ?? approvalQ.data?.patch_approved}
            vivadoApproved={vivadoLocal ?? approvalQ.data?.vivado_execution_approved}
            approvalError={approvalError}
            patchUpdating={patchApprove.isPending}
            vivadoUpdating={vivadoApprove.isPending}
            onPatchApprovalChange={(approved) => patchApprove.mutate(approved)}
            onVivadoApprovalChange={(approved) => vivadoApprove.mutate(approved)}
          />
        )}
        {tab === 'artifacts' && <ArtifactsTab timeline={timeline} />}
        {tab === 'vivado' && <VivadoTab />}
        {tab === 'debug' && (
          <DebugTab
            sessionId={sessionId}
            activeTaskId={activeTask?.id}
            streamStatus={streamStatus}
            timeline={timeline}
            problemCount={problemCount}
          />
        )}
      </div>
    </aside>
  )
}

function RunTab({
  sessionId,
  session,
  activeTask,
  streamStatus,
  timeline,
  problemCount,
  patchApproved,
  vivadoApproved,
  approvalError,
  patchUpdating,
  vivadoUpdating,
  onPatchApprovalChange,
  onVivadoApprovalChange,
}: {
  sessionId: string
  session?: Session
  activeTask?: { id?: string; state?: string } | null
  streamStatus: string
  timeline: SessionTimelineState
  problemCount: number
  patchApproved?: boolean
  vivadoApproved?: boolean
  approvalError?: string | null
  patchUpdating: boolean
  vivadoUpdating: boolean
  onPatchApprovalChange: (approved: boolean) => void
  onVivadoApprovalChange: (approved: boolean) => void
}) {
  const recentTools = timeline.tools.slice(-5).reverse()

  return (
    <>
      <section className="drawer-section">
        <div className="side-title">Run</div>
        <div className="kv"><span>Status</span><span><StatusBadge status={activeTask?.state || session?.status} /></span></div>
        <div className="kv"><span>Session</span><span className="mono">{session?.name || sessionId}</span></div>
        <div className="kv"><span>Updated</span><span>{formatRelative(session?.updated_at)}</span></div>
        <div className="kv"><span>Messages</span><span>{formatNumber(session?.message_count)}</span></div>
        <div className="kv"><span>Tools</span><span>{formatNumber(timeline.tools.length || session?.tool_call_count)}</span></div>
        <div className="kv"><span>Problems</span><span style={{ color: problemCount ? 'var(--error)' : undefined }}>{formatNumber(problemCount || session?.problem_count)}</span></div>
      </section>

      <section className="drawer-section">
        <div className="side-title"><Shield size={13} /> Approvals</div>
        {approvalError && (
          <p className="approval-error" role="alert">{approvalError}</p>
        )}
        <ApprovalSwitch
          label="File patches"
          description="Create and modify files without per-file confirmation."
          checked={Boolean(patchApproved)}
          disabled={patchUpdating}
          onChange={onPatchApprovalChange}
        />
        <ApprovalSwitch
          label="Vivado execution"
          description="Run synthesis, implementation, and Tcl commands without extra confirmation."
          checked={Boolean(vivadoApproved)}
          disabled={vivadoUpdating}
          onChange={onVivadoApprovalChange}
        />
      </section>

      <section className="drawer-section">
        <div className="side-title"><Activity size={13} /> Stream</div>
        <div className="kv"><span>Status</span><span>{streamStatus}</span></div>
        <div className="kv"><span>Last seq</span><span className="mono">{timeline.lastSeq}</span></div>
      </section>

      <section className="drawer-section">
        <div className="side-title"><Wrench size={13} /> Recent tools</div>
        <div className="drawer-list">
          {recentTools.length === 0 && <span className="muted">No tool calls yet</span>}
          {recentTools.map((t) => (
            <span key={t.toolcallId}>
              <StatusDot state={t.state} />
              <span className="mono drawer-list-label">{t.name}</span>
              <span className="drawer-list-state">{t.state}</span>
            </span>
          ))}
        </div>
      </section>
    </>
  )
}

function ApprovalSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={`approval-switch ${checked ? 'enabled' : ''}`}>
      <input
        type="checkbox"
        className="approval-switch-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        onClick={(e) => e.stopPropagation()}
      />
      <span className="approval-switch-copy">
        <span>{label}</span>
        <small>{description}</small>
      </span>
      <span className="approval-switch-state">{checked ? 'Auto' : 'Manual'}</span>
    </label>
  )
}

function ArtifactsTab({ timeline }: { timeline: SessionTimelineState }) {
  const artifacts = useMemo(() => collectArtifacts(timeline), [timeline])

  return (
    <section className="drawer-section artifacts-section">
      <div className="side-title"><FolderOpen size={13} /> Artifacts</div>
      <div className="artifact-list">
        {artifacts.length === 0 && <div className="muted drawer-hint">No file artifacts recorded in this session yet.</div>}
        {artifacts.map((artifact) => (
          <div className="artifact-row" key={`${artifact.action}:${artifact.path}`}>
            <span className="file-action-badge">{artifact.action}</span>
            <code className="file-path">{artifact.path}</code>
            {artifact.description && <span className="file-desc">{artifact.description}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}

function VivadoTab() {
  return <RemoteTerminalTab />
}

function DebugTab({
  sessionId,
  activeTaskId,
  streamStatus,
  timeline,
  problemCount,
}: {
  sessionId: string
  activeTaskId?: string
  streamStatus: string
  timeline: SessionTimelineState
  problemCount: number
}) {
  return (
    <>
      <section className="drawer-section">
        <div className="side-title">Session</div>
        <div className="kv"><span>ID</span><span className="mono">{sessionId}</span></div>
        <div className="kv"><span>Stream</span><span>{streamStatus}</span></div>
        <div className="kv"><span>Last seq</span><span className="mono">{timeline.lastSeq}</span></div>
      </section>
      <section className="drawer-section">
        <div className="side-title"><FileText size={13} /> Context</div>
        <ContextDebugPanel sessionId={sessionId} taskId={activeTaskId} />
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
          {timeline.tools.slice(-16).reverse().map((t) => (
            <span key={t.toolcallId}>{t.name} - {t.state}</span>
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
  const [lines, setLines] = useState<string[]>(['# Vivado Tcl over SSH', '# Type Tcl commands below'])

  const handleRun = async () => {
    const cmd = tclInput.trim()
    if (!cmd) return
    setLines((prev) => [...prev, `$ ${cmd}`])
    setTclInput('')
    try {
      const res = await runVivadoTcl(cmd, autoApprove)
      if (res.requires_approval) {
        setLines((prev) => [...prev, '# Policy requires approval - enable auto-approve or approve in chat'])
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
      <section className="drawer-section">
        <div className="side-title"><CircuitBoard size={13} /> Vivado</div>
        <div className="kv compact"><span>Host</span><span className="mono">{h?.host || '—'}</span></div>
        <div className="kv compact"><span>SSH</span><span><StatusBadge status={h?.reachable ? 'connected' : 'error'} /></span></div>
        <div className="kv compact"><span>Version</span><span>{h?.version || '—'}</span></div>
        <div className="kv compact"><span>Path</span><span className="mono">{h?.vivado_path || 'vivado'}</span></div>
        {h?.error && <div className="muted drawer-hint">{h.error}</div>}
        <div className="drawer-actions">
          <button type="button" className="btn ghost" onClick={() => void healthQ.refetch()} disabled={healthQ.isFetching}>
            <RefreshCw size={13} /> Refresh
          </button>
          <Link to="/vivado" className="btn ghost"><ExternalLink size={13} /> Open page</Link>
        </div>
      </section>
      <div className="remote-console" role="log">{lines.join('\n')}</div>
      <div className="remote-console-input">
        <input
          className="input"
          value={tclInput}
          onChange={(e) => setTclInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleRun() } }}
          placeholder="Tcl on remote Vivado..."
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

function collectArtifacts(timeline: SessionTimelineState) {
  const files = new Map<string, { path: string; action: string; description?: string }>()

  for (const entry of timeline.entries) {
    if (entry.kind !== 'interaction') continue
    const payload = entry.payload as InteractionEntryPayload
    for (const file of payload.files || []) {
      files.set(file.path, {
        path: file.path,
        action: file.action || 'file',
        description: file.description,
      })
    }
  }

  return [...files.values()]
}

function StatusDot({ state }: { state: string }) {
  return <span className={`status-dot state-${state}`} aria-hidden />
}
