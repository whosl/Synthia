import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getProject } from '../api/projects'
import { getSession } from '../api/sessions'
import { stopSessionTask } from '../api/tasks'
import { request } from '../api/client'
import { Button } from '../components/common/Button'
import { Composer } from '../components/terminal/Composer'
import { TerminalRightPanel } from '../components/terminal/TerminalRightPanel'
import { ChatEnterProvider } from '../components/terminal/ChatEnterAnimation'
import { TimelineChatList } from '../components/terminal/TimelineChatList'
import { TimelineView } from '../components/terminal/TimelineView'
import { useSessionTimeline } from '../timeline/useSessionTimeline'
import { isProjectArchived } from '../lib/projectStatus'
import { useStickToBottomScroll } from '../lib/useStickToBottomScroll'
import { useStreamStore } from '../stores/streamStore'
import { useTerminalStore } from '../stores/terminalStore'

export default function TerminalPage() {
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session') || ''
  const projectIdFromUrl = searchParams.get('project') || ''
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
    taskActive,
    running,
    stopping,
    start,
  } = useSessionTimeline(sessionId)

  const { ref: scrollRef, onScroll: onChatScroll, pinToBottom } = useStickToBottomScroll(
    [timeline.entries, timeline.auditLog, view, sessionId],
  )

  useEffect(() => {
    pinToBottom()
  }, [sessionId, pinToBottom])

  const sessionQ = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getSession(sessionId),
    enabled: Boolean(sessionId),
  })
  const projectId = projectIdFromUrl || sessionQ.data?.session?.project_id || ''
  const projectQ = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    enabled: Boolean(projectId),
  })

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
  const project = projectQ.data?.project
  const projectArchived = isProjectArchived(project)
  const composerDisabled = projectArchived || stopping || start.isPending || running
  const backHref = projectId ? `/projects/${projectId}` : '/'
  const headerTitle = session?.name || 'Session'
  const headerSubtitle = project ? `${project.name} · ${project.root_path}` : projectId ? 'Loading project…' : ''

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
        <div className={`terminal-layout ${rightPanelOpen ? 'right-open' : 'right-closed'}`}>
          <section className="chat-panel">
            <header className="chat-panel-header">
              <Link to={backHref} className="btn ghost terminal-back-link" aria-label="Back to project sessions">
                <ArrowLeft size={15} />
                <span className="terminal-back-label">Back</span>
              </Link>
              <div className="chat-panel-header-title-block">
                <h1 className="chat-panel-header-title">
                  {headerTitle}
                  {(running || stopping) && <span className="terminal-status-dot" />}
                </h1>
                {headerSubtitle && (
                  <p className="chat-panel-header-subtitle mono" title={headerSubtitle}>{headerSubtitle}</p>
                )}
                {projectArchived && (
                  <p className="terminal-archived-notice">Project archived — view only; restore the project to send messages.</p>
                )}
              </div>
              <div className="chat-panel-header-tabs" role="tablist" aria-label="Chat views">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'chat'}
                  className={`tab ${view === 'chat' ? 'active' : ''}`}
                  onClick={() => setView('chat')}
                >
                  Chat
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'timeline'}
                  className={`tab ${view === 'timeline' ? 'active' : ''}`}
                  onClick={() => setView('timeline')}
                >
                  Timeline
                </button>
              </div>
              <div className="chat-panel-header-actions">
                <Button
                  className="ghost terminal-controls-button header-icon-btn"
                  onClick={() => {
                    setRightPanelTab('run')
                    setRightPanelOpen(true)
                  }}
                  aria-label="Open run controls"
                  title="Controls"
                >
                  <SlidersHorizontal size={16} />
                </Button>
                {(running || stopping) && (
                  <Button className="danger" onClick={() => stop.mutate()} disabled={stopping}>
                    Stop
                  </Button>
                )}
              </div>
            </header>
            <div
              className={`chat-panel-scroll${view === 'chat' ? ' message-list' : ' timeline-view'}`}
              ref={scrollRef}
              onScroll={onChatScroll}
            >
              {view === 'chat' ? (
                <ChatEnterProvider sessionId={sessionId}>
                  <TimelineChatList
                    timeline={timeline}
                    taskActive={taskActive}
                    onInteractionRespond={handleInteractionRespond}
                  />
                </ChatEnterProvider>
              ) : (
                <TimelineView items={timeline.auditLog} />
              )}
            </div>
            <Composer
              running={running}
              stopping={stopping}
              disabled={composerDisabled}
              placeholder={
                projectArchived
                  ? 'Project archived — read-only'
                  : undefined
              }
              onSend={(q) => {
                pinToBottom()
                start.mutate(q)
              }}
              onStop={() => stop.mutate()}
            />
          </section>

          <button
            type="button"
            className={`right-panel-backdrop${rightPanelOpen ? ' is-open' : ''}`}
            aria-label="Close side panel"
            aria-hidden={!rightPanelOpen}
            tabIndex={rightPanelOpen ? 0 : -1}
            onClick={() => setRightPanelOpen(false)}
          />

          <TerminalRightPanel
            open={rightPanelOpen}
            sessionId={sessionId}
            projectId={projectId}
            session={session}
            activeTask={activeTask}
            streamStatus={streamStatus}
            timeline={timeline}
            problemCount={problemCount}
            tab={rightPanelTab}
            onTabChange={setRightPanelTab}
            onClose={() => setRightPanelOpen(false)}
          />
        </div>
      </div>
    </div>
  )
}
