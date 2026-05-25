import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Bug, CircuitBoard, ExternalLink, FileText, FolderOpen, Pencil, RefreshCw, Shield, Trash2, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { getApprovals, setPatchApproval, setVivadoApproval } from '../../api/settings'
import { deleteSession, updateSession } from '../../api/sessions'
import type { Session } from '../../api/types'
import { getVivadoHealth, runVivadoTcl } from '../../api/vivado'
import { formatNumber, formatRelative } from '../../lib/time'
import type { RightPanelTab } from '../../stores/terminalStore'
import type { InteractionEntryPayload, SessionTimelineState } from '../../timeline/types'
import { StatusBadge } from '../common/StatusBadge'
import { ContextDebugPanel } from './ContextDebugPanel'

const TABS: { id: RightPanelTab; icon: typeof FileText }[] = [
  { id: 'run', icon: Activity },
  { id: 'artifacts', icon: FolderOpen },
  { id: 'vivado', icon: CircuitBoard },
  { id: 'debug', icon: Bug },
]

function tabLabel(id: RightPanelTab, t: (key: string) => string): string {
  const map: Record<RightPanelTab, string> = {
    run: t('rightPanel.runTab'),
    artifacts: t('rightPanel.artifactsTab'),
    vivado: t('rightPanel.vivadoTab'),
    debug: t('rightPanel.debugTab'),
  }
  return map[id]
}

export function TerminalRightPanel({
  open,
  sessionId,
  projectId,
  session,
  activeTask,
  streamStatus,
  timeline,
  problemCount,
  tab,
  onTabChange,
  onClose,
}: {
  open: boolean
  sessionId: string
  projectId?: string
  session?: Session
  activeTask?: { id?: string; state?: string } | null
  streamStatus: string
  timeline: SessionTimelineState
  problemCount: number
  tab: RightPanelTab
  onTabChange: (tab: RightPanelTab) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
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
      setApprovalError(err.message || t('rightPanel.updateFileApprovalFailed'))
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
      setApprovalError(err.message || t('rightPanel.updateVivadoApprovalFailed'))
    },
  })

  return (
    <aside
      className={`terminal-right-panel${open ? ' is-open' : ''}`}
      aria-label={t('rightPanel.close')}
      aria-hidden={!open}
      inert={!open || undefined}
    >
      <div className="right-panel-topbar">
        <div className="right-panel-tabs" role="tablist">
          {TABS.map((tb) => {
            const label = tabLabel(tb.id, t)
            return (
            <button
              key={tb.id}
              type="button"
              role="tab"
              aria-selected={tab === tb.id}
              className={`right-panel-tab ${tab === tb.id ? 'active' : ''}`}
              onClick={() => onTabChange(tb.id)}
              title={label}
            >
              <tb.icon size={14} />
              <span className="right-panel-tab-label">{label}</span>
            </button>
          )})}
        </div>
        <button type="button" className="right-panel-close" onClick={onClose} aria-label={t('rightPanel.close')}>
          <X size={15} />
        </button>
      </div>
      <div className="right-panel-body">
        {tab === 'run' && (
          <RunTab
            sessionId={sessionId}
            projectId={projectId}
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
  projectId,
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
  projectId?: string
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
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const recentTools = timeline.tools.slice(-5).reverse()

  const rename = useMutation({
    mutationFn: (name: string) => updateSession(sessionId, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session', sessionId] })
      if (projectId) queryClient.invalidateQueries({ queryKey: ['sessions', projectId] })
    },
    onError: (err: Error) => alert(err.message || t('rightPanel.renameFailed')),
  })
  const del = useMutation({
    mutationFn: () => deleteSession(sessionId),
    onSuccess: () => {
      if (projectId) queryClient.invalidateQueries({ queryKey: ['sessions', projectId] })
      navigate(projectId ? `/projects/${projectId}` : '/')
    },
    onError: (err: Error) => alert(err.message || t('rightPanel.deleteFailed')),
  })

  const promptRename = () => {
    const next = window.prompt(t('rightPanel.sessionName'), session?.name || '')
    if (next && next.trim() && next.trim() !== session?.name) {
      rename.mutate(next.trim())
    }
  }

  const promptDelete = () => {
    if (confirm(t('rightPanel.archiveConfirm'))) del.mutate()
  }

  return (
    <>
      <section className="drawer-section">
        <div className="side-title">{t('rightPanel.sessionInfo')}</div>
        <div className="kv"><span>{t('rightPanel.status')}</span><span><StatusBadge status={activeTask?.state || session?.status} /></span></div>
        <div className="kv"><span>{t('rightPanel.session')}</span><span className="mono">{session?.name || sessionId}</span></div>
        <div className="kv"><span>{t('rightPanel.updated')}</span><span>{formatRelative(session?.updated_at)}</span></div>
        <div className="kv"><span>{t('rightPanel.messages')}</span><span>{formatNumber(session?.message_count)}</span></div>
        <div className="kv"><span>{t('rightPanel.tools')}</span><span>{formatNumber(timeline.tools.length || session?.tool_call_count)}</span></div>
        <div className="kv"><span>{t('rightPanel.problems')}</span><span style={{ color: problemCount ? 'var(--error)' : undefined }}>{formatNumber(problemCount || session?.problem_count)}</span></div>
        <div className="session-info-actions">
          <button type="button" className="btn ghost" onClick={promptRename} disabled={rename.isPending}>
            <Pencil size={14} /> {t('rightPanel.rename')}
          </button>
          <button type="button" className="btn ghost danger-ghost" onClick={promptDelete} disabled={del.isPending}>
            <Trash2 size={14} /> {t('rightPanel.delete')}
          </button>
        </div>
      </section>

      <section className="drawer-section">
        <div className="side-title"><Shield size={13} /> {t('rightPanel.approvals')}</div>
        {approvalError && (
          <p className="approval-error" role="alert">{approvalError}</p>
        )}
        <ApprovalSwitch
          label={t('rightPanel.filePatches')}
          description={t('rightPanel.filePatchesDesc')}
          checked={Boolean(patchApproved)}
          disabled={patchUpdating}
          onChange={onPatchApprovalChange}
        />
        <ApprovalSwitch
          label={t('rightPanel.vivadoExecution')}
          description={t('rightPanel.vivadoExecutionDesc')}
          checked={Boolean(vivadoApproved)}
          disabled={vivadoUpdating}
          onChange={onVivadoApprovalChange}
        />
      </section>

      <section className="drawer-section">
        <div className="side-title"><Activity size={13} /> {t('rightPanel.stream')}</div>
        <div className="kv"><span>{t('rightPanel.status')}</span><span>{streamStatus}</span></div>
        <div className="kv"><span>{t('rightPanel.lastSeq')}</span><span className="mono">{timeline.lastSeq}</span></div>
      </section>

      <section className="drawer-section">
        <div className="side-title"><Wrench size={13} /> {t('rightPanel.recentTools')}</div>
        <div className="drawer-list">
          {recentTools.length === 0 && <span className="muted">{t('rightPanel.noToolCalls')}</span>}
          {recentTools.map((tc) => (
            <span key={tc.toolcallId}>
              <StatusDot state={tc.state} />
              <span className="mono drawer-list-label">{tc.name}</span>
              <span className="drawer-list-state">{tc.state}</span>
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
  const { t } = useTranslation()
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
      <span className="approval-switch-state">{checked ? t('rightPanel.auto') : t('rightPanel.manual')}</span>
    </label>
  )
}

function ArtifactsTab({ timeline }: { timeline: SessionTimelineState }) {
  const { t } = useTranslation()
  const artifacts = useMemo(() => collectArtifacts(timeline), [timeline])

  return (
    <section className="drawer-section artifacts-section">
      <div className="side-title"><FolderOpen size={13} /> {t('rightPanel.artifacts')}</div>
      <div className="artifact-list">
        {artifacts.length === 0 && <div className="muted drawer-hint">{t('rightPanel.noArtifacts')}</div>}
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
  const { t } = useTranslation()
  return (
    <>
      <section className="drawer-section">
        <div className="side-title">{t('rightPanel.session')}</div>
        <div className="kv"><span>{t('rightPanel.sessionId')}</span><span className="mono">{sessionId}</span></div>
        <div className="kv"><span>{t('rightPanel.stream')}</span><span>{streamStatus}</span></div>
        <div className="kv"><span>{t('rightPanel.lastSeq')}</span><span className="mono">{timeline.lastSeq}</span></div>
      </section>
      <section className="drawer-section">
        <div className="side-title"><FileText size={13} /> {t('rightPanel.context')}</div>
        <ContextDebugPanel sessionId={sessionId} taskId={activeTaskId} />
      </section>
      <section className="drawer-section">
        <div className="side-title"><Bug size={13} /> {t('rightPanel.events')}</div>
        <div className="drawer-list">
          <span>{t('rightPanel.eventsCount', { n: timeline.auditLog.length })}</span>
          <span>{t('rightPanel.problemsCount', { n: problemCount })}</span>
        </div>
      </section>
      <section className="drawer-section">
        <div className="side-title"><Wrench size={13} /> {t('rightPanel.tools')}</div>
        <div className="drawer-list">
          {timeline.tools.length === 0 && <span className="muted">{t('rightPanel.noToolCalls')}</span>}
          {timeline.tools.slice(-16).reverse().map((tc) => (
            <span key={tc.toolcallId}>{tc.name} - {tc.state}</span>
          ))}
        </div>
      </section>
    </>
  )
}

function RemoteTerminalTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const healthQ = useQuery({ queryKey: ['vivado-health'], queryFn: getVivadoHealth, refetchInterval: 15000 })
  const [tclInput, setTclInput] = useState('')
  const [autoApprove, setAutoApprove] = useState(true)
  const [lines, setLines] = useState<string[]>([t('rightPanel.tclConsoleInit1'), t('rightPanel.tclConsoleInit2')])

  const handleRun = async () => {
    const cmd = tclInput.trim()
    if (!cmd) return
    setLines((prev) => [...prev, `$ ${cmd}`])
    setTclInput('')
    try {
      const res = await runVivadoTcl(cmd, autoApprove)
      if (res.requires_approval) {
        setLines((prev) => [...prev, t('rightPanel.tclApprovalMsg')])
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
        <div className="side-title"><CircuitBoard size={13} /> {t('rightPanel.vivadoTab')}</div>
        <div className="kv compact"><span>{t('rightPanel.vivadoHost')}</span><span className="mono">{h?.host || '—'}</span></div>
        <div className="kv compact"><span>{t('rightPanel.vivadoSSH')}</span><span><StatusBadge status={h?.reachable ? 'connected' : 'error'} /></span></div>
        <div className="kv compact"><span>{t('rightPanel.vivadoVersion')}</span><span>{h?.version || '—'}</span></div>
        <div className="kv compact"><span>{t('rightPanel.vivadoPath')}</span><span className="mono">{h?.vivado_path || 'vivado'}</span></div>
        {h?.error && <div className="muted drawer-hint">{h.error}</div>}
        <div className="drawer-actions">
          <button type="button" className="btn ghost" onClick={() => void healthQ.refetch()} disabled={healthQ.isFetching}>
            <RefreshCw size={13} /> {t('rightPanel.refresh')}
          </button>
          <Link to="/vivado" className="btn ghost"><ExternalLink size={13} /> {t('rightPanel.openPage')}</Link>
        </div>
      </section>
      <div className="remote-console" role="log">{lines.join('\n')}</div>
      <div className="remote-console-input">
        <input
          className="input"
          value={tclInput}
          onChange={(e) => setTclInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleRun() } }}
          placeholder={t('rightPanel.tclPlaceholder')}
          spellCheck={false}
        />
        <button type="button" className="btn primary" onClick={() => void handleRun()}>{t('rightPanel.tclRun')}</button>
      </div>
      <label className="remote-console-opt muted">
        <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
        {t('rightPanel.tclAutoApprove')}
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
