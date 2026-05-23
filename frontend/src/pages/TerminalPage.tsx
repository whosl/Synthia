import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Bug, Database, FileText, PanelRightClose, PanelRightOpen, Shield, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { listEvents } from '../api/events'
import { listMessages } from '../api/messages'
import { getSession } from '../api/sessions'
import { getPatchApproval, setPatchApproval } from '../api/settings'
import { getActiveTask, startTask, stopSessionTask } from '../api/tasks'
import { request } from '../api/client'
import type { SessionEvent } from '../api/types'
import { Button } from '../components/common/Button'
import { StatusBadge } from '../components/common/StatusBadge'
import { Composer } from '../components/terminal/Composer'
import { MessageList } from '../components/terminal/MessageList'
import { TimelineView } from '../components/terminal/TimelineView'
import { applyEvent, mergePendingInteractions, rebuildTerminalState, type TerminalRuntimeState } from '../lib/eventReducer'
import { SessionEventStream } from '../lib/sse'
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
  const setLastSeq = useStreamStore((s) => s.setLastSeq)
  const getLastSeq = useStreamStore((s) => s.getLastSeq)
  const setStreamStatus = useStreamStore((s) => s.setStatus)
  const streamStatus = useStreamStore((s) => s.statusBySession[sessionId] || 'idle')
  const [runtime, setRuntime] = useState<TerminalRuntimeState>({ turns: [], timeline: [], tools: [], lastSeq: 0 })
  const streamRef = useRef<SessionEventStream | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const sessionQ = useQuery({ queryKey: ['session', sessionId], queryFn: () => getSession(sessionId), enabled: Boolean(sessionId) })
  const messagesQ = useQuery({ queryKey: ['messages', sessionId], queryFn: () => listMessages(sessionId, 500), enabled: Boolean(sessionId) })
  const activeQ = useQuery({ queryKey: ['active-task', sessionId], queryFn: () => getActiveTask(sessionId), enabled: Boolean(sessionId), refetchInterval: 3000 })
  const approvalQ = useQuery({ queryKey: ['patch-approval'], queryFn: getPatchApproval })
  const eventsQ = useQuery({ queryKey: ['events', sessionId], queryFn: () => listEvents(sessionId, 0, 5000), enabled: Boolean(sessionId) })
  const pendingInteractionsQ = useQuery({
    queryKey: ['interactions', sessionId],
    queryFn: () => request<{ interactions: Record<string, unknown>[] }>(`/sessions/${sessionId}/interactions`),
    enabled: Boolean(sessionId),
    refetchInterval: 3000,
  })

  const activeTask = activeQ.data?.task
  const running = activeTask?.state === 'running'
  const stopping = activeTask?.state === 'stopping'

  // Reset UI when switching sessions
  useEffect(() => {
    setRuntime({ turns: [], timeline: [], tools: [], lastSeq: 0 })
    setLastSeq(sessionId, 0)
  }, [sessionId, setLastSeq])

  // Rebuild runtime from persisted data + pending interactions (single pass avoids race)
  useEffect(() => {
    if (!messagesQ.data || !eventsQ.data) return
    const pending = pendingInteractionsQ.data?.interactions || []
    let next = rebuildTerminalState(messagesQ.data.messages, eventsQ.data.events, activeTask)
    next = mergePendingInteractions(next, pending)
    setRuntime(next)
    if (next.lastSeq > 0) setLastSeq(sessionId, next.lastSeq)
  }, [messagesQ.data, eventsQ.data, pendingInteractionsQ.data, sessionId, setLastSeq, activeTask])

  // SSE stream event handler — stable ref to avoid stream reconnects
  const onStreamEventRef = useRef<(event: SessionEvent) => void>(() => {})
  onStreamEventRef.current = (event: SessionEvent) => {
    setRuntime((prev) => applyEvent(prev, event, { appendAssistantDelta: event.event_type === 'message.assistant.delta' }))
    setLastSeq(sessionId, event.seq)
    if (event.event_type === 'task.done' || event.event_type === 'task.error' || event.event_type === 'task.stopped') {
      queryClient.invalidateQueries({ queryKey: ['active-task', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['events', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  }

  // SSE connection — only reconnects when sessionId changes
  useEffect(() => {
    if (!sessionId) return
    streamRef.current?.disconnect()
    const stream = new SessionEventStream(
      sessionId,
      getLastSeq(sessionId),
      (evt) => onStreamEventRef.current(evt),
      (status) => setStreamStatus(sessionId, status),
    )
    streamRef.current = stream
    stream.connect()
    return () => stream.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [runtime.turns, runtime.timeline, view])

  const start = useMutation({
    mutationFn: (question: string) => startTask(sessionId, { question }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['active-task', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['events', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })
  const stop = useMutation({ mutationFn: () => stopSessionTask(sessionId), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['active-task', sessionId] }) })
  const approve = useMutation({ mutationFn: setPatchApproval, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['patch-approval'] }) })

  const toolCount = runtime.tools.length
  const problemCount = useMemo(() => runtime.timeline.filter((t) => t.type.includes('problem') || t.state === 'error').length, [runtime.timeline])
  const session = sessionQ.data?.session

  const handleInteractionRespond = async (interactionId: string, response: Record<string, any>) => {
    await request(`/interactions/${interactionId}/respond`, { method: 'POST', body: JSON.stringify(response), headers: { 'Content-Type': 'application/json' } })
    queryClient.invalidateQueries({ queryKey: ['events', sessionId] })
    queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
    queryClient.invalidateQueries({ queryKey: ['active-task', sessionId] })
    queryClient.invalidateQueries({ queryKey: ['interactions', sessionId] })
  }

  return <div className="page terminal-page">
    <div className="terminal-shell">
      <header className="terminal-header">
        <Link to="/" className="btn ghost"><ArrowLeft size={15} /> Sessions</Link>
        <div className="terminal-title">{session?.name || 'Session'} {(running || stopping) && <span className="terminal-status-dot" />}</div>
        <label className="approval-toggle"><span>Auto-approve</span><input type="checkbox" checked={Boolean(approvalQ.data?.approved)} onChange={(e) => approve.mutate(e.target.checked)} /></label>
        {(running || stopping) && <Button className="danger" onClick={() => stop.mutate()} disabled={stopping}>Stop</Button>}
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
            <div className="kv"><span>Tools</span><span>{formatNumber(toolCount || session?.tool_call_count)}</span></div>
            <div className="kv"><span>Problems</span><span style={{ color: problemCount ? 'var(--error)' : undefined }}>{formatNumber(problemCount || session?.problem_count)}</span></div>
          </div>
          <div className="side-section">
            <div className="side-title">Stream</div>
            <div className="kv"><span>Status</span><span>{streamStatus}</span></div>
            <div className="kv"><span>Last seq</span><span className="mono">{runtime.lastSeq}</span></div>
          </div>
        </aside>

        <section className="chat-panel">
          <div className="view-tabs">
            <button className={`tab ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>Chat</button>
            <button className={`tab ${view === 'timeline' ? 'active' : ''}`} onClick={() => setView('timeline')}>Timeline</button>
            <span style={{ flex: 1 }} />
            <Button className="ghost" onClick={() => setDebugOpen(!debugOpen)}>{debugOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}</Button>
          </div>
          <div className={view === 'chat' ? 'message-list' : 'timeline-view'} ref={scrollRef}>
            {view === 'chat' ? <MessageList turns={runtime.turns} onInteractionRespond={handleInteractionRespond} /> : <TimelineView items={runtime.timeline} />}
          </div>
          <Composer running={running} stopping={stopping} disabled={stopping || start.isPending} onSend={(q) => start.mutate(q)} onStop={() => stop.mutate()} />
        </section>

        {debugOpen && <aside className="debug-drawer">
          <div className="drawer-header"><span>Debug</span><Button className="ghost icon-btn" onClick={() => setDebugOpen(false)}>×</Button></div>
          <div className="drawer-section">
            <div className="side-title"><FileText size={13} /> Context</div>
            <div className="drawer-list">
              <span><Database size={13} /> Retrieval audit pending</span>
              <span><Shield size={13} /> Patch: {approvalQ.data?.approved ? 'auto' : 'manual'}</span>
            </div>
          </div>
          <div className="drawer-section">
            <div className="side-title"><Bug size={13} /> Events</div>
            <div className="drawer-list">
              <span>{runtime.timeline.length} events</span>
              <span>{problemCount} problems</span>
            </div>
          </div>
          <div className="drawer-section">
            <div className="side-title"><Wrench size={13} /> Tools</div>
            <div className="drawer-list">{runtime.tools.slice(-8).map((t) => <span key={t.id}>{t.name} — {t.state}</span>)}</div>
          </div>
        </aside>}
      </div>
    </div>
  </div>
}
