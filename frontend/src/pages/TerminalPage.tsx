import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Bug, FileText, PanelRightClose, PanelRightOpen, Shield, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getSession } from '../api/sessions'
import { getPatchApproval, setPatchApproval } from '../api/settings'
import { stopSessionTask } from '../api/tasks'
import { request } from '../api/client'
import { Button } from '../components/common/Button'
import { StatusBadge } from '../components/common/StatusBadge'
import { ContextDebugPanel } from '../components/terminal/ContextDebugPanel'
import { Composer } from '../components/terminal/Composer'
import { TimelineChatList } from '../components/terminal/TimelineChatList'
import { TimelineView } from '../components/terminal/TimelineView'
import { useSessionTimeline } from '../timeline/useSessionTimeline'
import { formatNumber, formatRelative, formatTime } from '../lib/time'
import { useStreamStore } from '../stores/streamStore'
import { useTerminalStore } from '../stores/terminalStore'

export default function TerminalPage() {
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session') || ''
  const queryClient = useQueryClient()
  const view = useTerminalStore((s) => s.view)
  const setView = useTerminalStore((s) => s.setView)
  const debugOpen = useTerminalStore((s) => s.debugOpen)
  const setDebugOpen = useTerminalStore((s) => s.setDebugOpen)
  const streamStatus = useStreamStore((s) => s.statusBySession[sessionId] || 'idle')

  const {
    timeline,
    activeTask,
    running,
    stopping,
    start,
  } = useSessionTimeline(sessionId)

  const scrollRef = useRef<HTMLDivElement>(null)
  const sessionQ = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getSession(sessionId),
    enabled: Boolean(sessionId),
  })
  const approvalQ = useQuery({ queryKey: ['patch-approval'], queryFn: getPatchApproval })

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [timeline.entries, timeline.auditLog, view])

  const stop = useMutation({
    mutationFn: () => stopSessionTask(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['active-task', sessionId] }),
  })
  const approve = useMutation({
    mutationFn: setPatchApproval,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['patch-approval'] }),
  })

  const problemCount = useMemo(
    () => timeline.auditLog.filter((t) => t.type.includes('problem') || t.state === 'error').length,
    [timeline.auditLog],
  )
  const session = sessionQ.data?.session

  const handleInteractionRespond = async (interactionId: string, response: Record<string, unknown>) => {
    await request(`/interactions/${interactionId}/respond`, {
      method: 'POST',
      body: JSON.stringify(response),
      headers: { 'Content-Type': 'application/json' },
    })
    queryClient.invalidateQueries({ queryKey: ['events', sessionId] })
    queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
    queryClient.invalidateQueries({ queryKey: ['active-task', sessionId] })
    queryClient.invalidateQueries({ queryKey: ['interactions', sessionId] })
  }

  return (
    <div className="page terminal-page">
      <div className="terminal-shell">
        <header className="terminal-header">
          <Link to="/" className="btn ghost"><ArrowLeft size={15} /> Sessions</Link>
          <div className="terminal-title">
            {session?.name || 'Session'} {(running || stopping) && <span className="terminal-status-dot" />}
          </div>
          <label className="approval-toggle">
            <span>Auto-approve</span>
            <input type="checkbox" checked={Boolean(approvalQ.data?.approved)} onChange={(e) => approve.mutate(e.target.checked)} />
          </label>
          {(running || stopping) && (
            <Button className="danger" onClick={() => stop.mutate()} disabled={stopping}>Stop</Button>
          )}
        </header>
        <div className="terminal-layout">
          <aside className="terminal-side">
            <div className="side-section">
              <div className="side-title">Session</div>
              <div className="kv"><span>ID</span><span className="mono">{sessionId}</span></div>
              <div className="kv"><span>Status</span><span><StatusBadge status={activeTask?.state || session?.status} /></span></div>
              <div className="kv"><span>Created</span><span>{formatTime(session?.created_at)}</span></div>
              <div className="kv"><span>Updated</span><span>{formatRelative(session?.updated_at)}</span></div>
              <div className="kv"><span>Messages</span><span>{formatNumber(session?.message_count)}</span></div>
              <div className="kv"><span>Tools</span><span>{formatNumber(timeline.tools.length || session?.tool_call_count)}</span></div>
              <div className="kv"><span>Problems</span><span style={{ color: problemCount ? 'var(--error)' : undefined }}>{formatNumber(problemCount || session?.problem_count)}</span></div>
            </div>
            <div className="side-section">
              <div className="side-title">Stream</div>
              <div className="kv"><span>Status</span><span>{streamStatus}</span></div>
              <div className="kv"><span>Last seq</span><span className="mono">{timeline.lastSeq}</span></div>
            </div>
          </aside>

          <section className="chat-panel">
            <div className="view-tabs">
              <button type="button" className={`tab ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>Chat</button>
              <button type="button" className={`tab ${view === 'timeline' ? 'active' : ''}`} onClick={() => setView('timeline')}>Timeline</button>
              <span style={{ flex: 1 }} />
              <Button className="ghost" onClick={() => setDebugOpen(!debugOpen)}>
                {debugOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
              </Button>
            </div>
            <div className={view === 'chat' ? 'message-list' : 'timeline-view'} ref={scrollRef}>
              {view === 'chat' ? (
                <TimelineChatList timeline={timeline} onInteractionRespond={handleInteractionRespond} />
              ) : (
                <TimelineView items={timeline.auditLog} />
              )}
            </div>
            <Composer
              running={running}
              stopping={stopping}
              disabled={stopping || start.isPending || running}
              onSend={(q) => start.mutate(q)}
              onStop={() => stop.mutate()}
            />
          </section>

          {debugOpen && (
            <aside className="debug-drawer">
              <div className="drawer-header">
                <span>Debug</span>
                <Button className="ghost icon-btn" onClick={() => setDebugOpen(false)}>×</Button>
              </div>
              <div className="drawer-section">
                <div className="side-title"><FileText size={13} /> Context</div>
                <ContextDebugPanel sessionId={sessionId} taskId={activeTask?.id} />
                <div className="drawer-list" style={{ marginTop: 8 }}>
                  <span><Shield size={13} /> Patch: {approvalQ.data?.approved ? 'auto' : 'manual'}</span>
                </div>
              </div>
              <div className="drawer-section">
                <div className="side-title"><Bug size={13} /> Events</div>
                <div className="drawer-list">
                  <span>{timeline.auditLog.length} events</span>
                  <span>{problemCount} problems</span>
                </div>
              </div>
              <div className="drawer-section">
                <div className="side-title"><Wrench size={13} /> Tools</div>
                <div className="drawer-list">
                  {timeline.tools.slice(-8).map((t) => (
                    <span key={t.toolcallId}>{t.name} — {t.state}</span>
                  ))}
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
