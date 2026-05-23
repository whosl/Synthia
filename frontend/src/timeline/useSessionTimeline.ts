import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { listEvents } from '../api/events'
import { listMessages } from '../api/messages'
import { request } from '../api/client'
import type { SessionEvent } from '../api/types'
import { getActiveTask, startTask } from '../api/tasks'
import { SessionEventStream } from '../lib/sse'
import { useStreamStore } from '../stores/streamStore'
import {
  applyOptimisticUser,
  applyTimelineEvent,
  rebuildTimelineFromSources,
} from './reducer'
import type { SessionTimelineState } from './types'
import { emptyTimelineState } from './types'

export function useSessionTimeline(sessionId: string) {
  const queryClient = useQueryClient()
  const setLastSeq = useStreamStore((s) => s.setLastSeq)
  const getLastSeq = useStreamStore((s) => s.getLastSeq)
  const setStreamStatus = useStreamStore((s) => s.setStatus)

  const [timeline, setTimeline] = useState<SessionTimelineState>(emptyTimelineState)
  const streamRef = useRef<SessionEventStream | null>(null)
  const sendingRef = useRef(false)

  const messagesQ = useQuery({
    queryKey: ['messages', sessionId],
    queryFn: () => listMessages(sessionId, 500),
    enabled: Boolean(sessionId),
  })
  const eventsQ = useQuery({
    queryKey: ['events', sessionId],
    queryFn: () => listEvents(sessionId, 0, 5000, true),
    enabled: Boolean(sessionId),
  })
  const activeQ = useQuery({
    queryKey: ['active-task', sessionId],
    queryFn: () => getActiveTask(sessionId),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => {
      const state = query.state.data?.task?.state
      return state === 'stopping' || state === 'running' ? 1000 : 3000
    },
  })
  const pendingInteractionsQ = useQuery({
    queryKey: ['interactions', sessionId],
    queryFn: () => request<{ interactions: Record<string, unknown>[] }>(`/sessions/${sessionId}/interactions`),
    enabled: Boolean(sessionId),
    refetchInterval: 3000,
  })

  const activeTask = activeQ.data?.task
  const taskActive = activeTask?.state === 'running' || activeTask?.state === 'stopping'

  useEffect(() => {
    if (taskActive) sendingRef.current = false
  }, [taskActive])

  useEffect(() => {
    setTimeline(emptyTimelineState())
    sendingRef.current = false
  }, [sessionId])

  useEffect(() => {
    if (!messagesQ.data || !eventsQ.data || !sessionId) return
    const pending = pendingInteractionsQ.data?.interactions || []
    const rebuilt = rebuildTimelineFromSources(
      eventsQ.data.events,
      messagesQ.data.messages,
      pending,
      activeTask,
    )
    setTimeline((prev) => {
      if (!taskActive && !sendingRef.current) return rebuilt
      if (prev.entries.length === 0) return rebuilt
      return prev.lastSeq >= rebuilt.lastSeq ? prev : rebuilt
    })
    if (rebuilt.lastSeq > 0) setLastSeq(sessionId, rebuilt.lastSeq)
  }, [messagesQ.data, eventsQ.data, pendingInteractionsQ.data, sessionId, activeTask, taskActive, setLastSeq])

  const onStreamEvent = useCallback((event: SessionEvent) => {
    setTimeline((prev) =>
      applyTimelineEvent(prev, event, {
        appendAssistantDelta: event.event_type === 'message.assistant.delta',
        ignoreSeqGuard: event.event_type === 'message.user.created',
      }),
    )
    setLastSeq(sessionId, event.seq)
    if (event.event_type === 'context.package.created') {
      queryClient.invalidateQueries({ queryKey: ['session-context', sessionId] })
    }
    if (
      event.event_type === 'task.done'
      || event.event_type === 'task.error'
      || event.event_type === 'task.stopped'
      || event.event_type === 'task.stopping'
    ) {
      if (event.event_type !== 'task.stopping') {
        sendingRef.current = false
      }
      queryClient.invalidateQueries({ queryKey: ['active-task', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['events', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['session-context', sessionId] })
    }
  }, [queryClient, sessionId, setLastSeq])

  useEffect(() => {
    if (!sessionId) return
    streamRef.current?.disconnect()
    const stream = new SessionEventStream(sessionId, getLastSeq(sessionId), onStreamEvent, (status) =>
      setStreamStatus(sessionId, status),
    )
    streamRef.current = stream
    stream.connect()
    return () => stream.disconnect()
  }, [sessionId, getLastSeq, onStreamEvent, setStreamStatus])

  const start = useMutation({
    mutationFn: (question: string) => startTask(sessionId, { question }),
    onMutate: (question) => {
      sendingRef.current = true
      setTimeline((prev) => applyOptimisticUser(prev, question))
    },
    onError: () => {
      sendingRef.current = false
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ['active-task', sessionId] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['messages', sessionId] }),
        queryClient.refetchQueries({ queryKey: ['events', sessionId] }),
      ])
    },
  })

  return {
    timeline,
    activeTask,
    taskActive,
    running: activeTask?.state === 'running',
    stopping: activeTask?.state === 'stopping',
    start,
    messagesQ,
    eventsQ,
    activeQ,
  }
}
