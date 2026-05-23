import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, PanelRightClose, PanelRightOpen, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getSession } from '../api/sessions'
import { stopSessionTask } from '../api/tasks'
import { request } from '../api/client'
import { Button } from '../components/common/Button'
import { Composer } from '../components/terminal/Composer'
import { TerminalRightPanel } from '../components/terminal/TerminalRightPanel'
import { TimelineChatList } from '../components/terminal/TimelineChatList'
import { TimelineView } from '../components/terminal/TimelineView'
import { useSessionTimeline } from '../timeline/useSessionTimeline'
import { useStreamStore } from '../stores/streamStore'
import { useTerminalStore } from '../stores/terminalStore'

export default function TerminalPage() {
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session') || ''
  const queryClient = useQueryClient()
  const view = useTerminalStore((s) => s.view)
  const setView = useTerminalStore((s) => s.setView)
  const rightPanelOpen = useTerminalStore((s) => s.rightPanelOpen)
  const setRightPanelOpen = useTerminalStore((s) => s.setRightPanelOpen)
  const rightPanelTab = useTerminalStore((s) => s.rightPanelTab)
  const setRightPanelTab = useTerminalStore((s) => s.setRightPanelTab)
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [timeline.entries, timeline.auditLog, view])

  const stop = useMutation({
    mutationFn: () => stopSessionTask(sessionId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['active-task', sessionId] }),
        queryClient.invalidateQueries({ queryKey: ['session', sessionId] }),
        queryClient.refetchQueries({ queryKey: ['events', sessionId] }),
      ])
    },
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
          <Link to="/" className="btn ghost terminal-back-link"><ArrowLeft size={15} /> Sessions</Link>
          <div className="terminal-title">
            {session?.name || 'Session'} {(running || stopping) && <span className="terminal-status-dot" />}
          </div>
          <Button
            className="ghost terminal-controls-button"
            onClick={() => {
              setRightPanelTab('run')
              setRightPanelOpen(true)
            }}
            aria-label="Open run controls"
          >
            <SlidersHorizontal size={15} />
            <span>Controls</span>
          </Button>
          {(running || stopping) && (
            <Button className="danger" onClick={() => stop.mutate()} disabled={stopping}>Stop</Button>
          )}
        </header>
        <div className={`terminal-layout ${rightPanelOpen ? 'right-open' : 'right-closed'}`}>
          <section className="chat-panel">
            <div className="view-tabs">
              <button type="button" className={`tab ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>Chat</button>
              <button type="button" className={`tab ${view === 'timeline' ? 'active' : ''}`} onClick={() => setView('timeline')}>Timeline</button>
              <span style={{ flex: 1 }} />
              <Button
                className="ghost right-panel-toggle"
                onClick={() => setRightPanelOpen(!rightPanelOpen)}
                aria-label={rightPanelOpen ? 'Hide side panel' : 'Show side panel'}
              >
                {rightPanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
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

          {rightPanelOpen && (
            <button
              type="button"
              className="right-panel-backdrop"
              aria-label="Close side panel"
              onClick={() => setRightPanelOpen(false)}
            />
          )}

          {rightPanelOpen && (
            <TerminalRightPanel
              sessionId={sessionId}
              session={session}
              activeTask={activeTask}
              streamStatus={streamStatus}
              timeline={timeline}
              problemCount={problemCount}
              tab={rightPanelTab}
              onTabChange={setRightPanelTab}
              onClose={() => setRightPanelOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
