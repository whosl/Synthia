import type { Message, SessionEvent, Task } from '../api/types'
import type {
  AssistantTextPayload,
  AuditLogItem,
  InteractionEntryPayload,
  ReasoningEntryPayload,
  SessionTimelineState,
  TimelineEntry,
  ToolEntryPayload,
  UserEntryPayload,
} from './types'
import { emptyTimelineState } from './types'
import { assistantEntryKey, completeAssistantStream, resolveStreamId, resolveStreamIdForCompletion } from './streamId'
import { toolStateFromCompletion } from './toolState'

export type ApplyEventOptions = {
  appendAssistantDelta?: boolean
  ignoreSeqGuard?: boolean
}

function pushAudit(state: SessionTimelineState, event: SessionEvent, title: string, detail?: string, auditState?: string) {
  const item: AuditLogItem = {
    id: event.id,
    seq: event.seq,
    type: event.event_type,
    title,
    detail,
    state: auditState,
    createdAt: event.created_at,
  }
  state.auditLog.push(item)
}

function upsertToolList(tools: ToolEntryPayload[], tool: ToolEntryPayload): ToolEntryPayload[] {
  const idx = tools.findIndex((t) => t.toolcallId === tool.toolcallId)
  if (idx < 0) return [...tools, tool]
  const next = [...tools]
  next[idx] = tool
  return next
}

function insertEntry(state: SessionTimelineState, entry: TimelineEntry): SessionTimelineState {
  const entries = [...state.entries, entry].sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key))
  const indexByKey: Record<string, number> = {}
  entries.forEach((e, i) => { indexByKey[e.key] = i })
  return { ...state, entries, indexByKey }
}

function updateEntry(
  state: SessionTimelineState,
  key: string,
  updater: (entry: TimelineEntry) => TimelineEntry,
): SessionTimelineState {
  const idx = state.indexByKey[key]
  if (idx === undefined) return state
  const entries = [...state.entries]
  entries[idx] = updater(entries[idx])
  return { ...state, entries }
}

function appendAssistantDelta(
  state: SessionTimelineState,
  taskId: string,
  streamId: string,
  text: string,
  event: SessionEvent,
): SessionTimelineState {
  const key = assistantEntryKey(streamId)
  const idx = state.indexByKey[key]
  let next: SessionTimelineState = {
    ...state,
    activeStreamByTask: { ...state.activeStreamByTask, [taskId]: streamId },
  }
  if (idx !== undefined) {
    next = updateEntry(next, key, (e) => {
      const p = e.payload as AssistantTextPayload
      return { ...e, payload: { ...p, text: p.text + text, partial: true } }
    })
  } else {
    const entry: TimelineEntry = {
      key,
      id: key,
      seq: event.seq || next.lastSeq,
      kind: 'assistant_text',
      taskId,
      createdAt: event.created_at,
      payload: { streamId, text, partial: true } satisfies AssistantTextPayload,
    }
    next = insertEntry(next, entry)
  }
  return next
}

function removeKeys(state: SessionTimelineState, predicate: (key: string) => boolean): SessionTimelineState {
  const entries = state.entries.filter((e) => !predicate(e.key))
  const indexByKey: Record<string, number> = {}
  entries.forEach((e, i) => { indexByKey[e.key] = i })
  return { ...state, entries, indexByKey }
}

export function applyTimelineEvent(
  state: SessionTimelineState,
  event: SessionEvent,
  options: ApplyEventOptions = {},
): SessionTimelineState {
  if (
    !options.ignoreSeqGuard
    && event.event_type !== 'message.user.created'
    && event.seq
    && event.seq <= state.lastSeq
  ) {
    return state
  }

  let next: SessionTimelineState = {
    ...state,
    entries: [...state.entries],
    indexByKey: { ...state.indexByKey },
    auditLog: [...state.auditLog],
    tools: [...state.tools],
    activeStreamByTask: { ...state.activeStreamByTask },
    legacySegmentByTask: { ...state.legacySegmentByTask },
    lastSeq: Math.max(state.lastSeq, event.seq || 0),
  }

  const payload = event.payload || {}
  const text = String(payload.text || '')
  const taskId = event.task_id || String(payload.task_id || '') || null

  switch (event.event_type) {
    case 'message.user.created': {
      const mid = String(payload.message_id || event.id)
      next = removeKeys(next, (k) => k.startsWith('optimistic-user:'))
      const key = `user:${mid}`
      if (next.indexByKey[key] === undefined) {
        const entry: TimelineEntry = {
          key,
          id: mid,
          seq: event.seq || next.lastSeq,
          kind: 'user',
          taskId,
          createdAt: event.created_at,
          payload: { text, messageId: mid } satisfies UserEntryPayload,
        }
        next = insertEntry(next, entry)
      }
      pushAudit(next, event, 'User message', text.slice(0, 80))
      break
    }
    case 'task.created':
    case 'task.started':
      next.activeTaskId = taskId || String(payload.task_id || '')
      next.taskState = 'running'
      pushAudit(next, event, 'Task started', next.activeTaskId || undefined, 'running')
      break
    case 'task.stopping':
      next.taskState = 'stopping'
      pushAudit(next, event, 'Stop requested', String(payload.task_id || ''), 'stopping')
      break
    case 'task.stopped':
      next.taskState = 'stopped'
      pushAudit(next, event, 'Task stopped', String(payload.task_id || ''), 'stopped')
      break
    case 'task.done':
      next.taskState = 'done'
      next.activeTaskId = null
      pushAudit(next, event, 'Task completed', String(payload.task_id || ''), 'done')
      break
    case 'task.error':
      next.taskState = 'error'
      next.activeTaskId = null
      pushAudit(next, event, 'Task failed', String(payload.error || ''), 'error')
      break
    case 'assistant.stream.opened': {
      if (!taskId) break
      const streamId = String(payload.stream_id || '')
      if (streamId) {
        next.activeStreamByTask = { ...next.activeStreamByTask, [taskId]: streamId }
      }
      pushAudit(next, event, 'Assistant stream opened', streamId)
      break
    }
    case 'assistant.stream.completed': {
      const streamId = String(payload.stream_id || '')
      if (streamId) {
        next = completeAssistantStream(next, streamId, { stopped: Boolean(payload.stopped) })
      }
      pushAudit(next, event, 'Assistant stream completed', streamId, 'done')
      break
    }
    case 'message.assistant.snapshot': {
      const streamId = String(payload.stream_id || '')
      const snapText = String(payload.text || '')
      if (!streamId || !snapText || !taskId) break
      const key = assistantEntryKey(streamId)
      const idx = next.indexByKey[key]
      if (idx === undefined) {
        const entry: TimelineEntry = {
          key,
          id: key,
          seq: event.seq || next.lastSeq,
          kind: 'assistant_text',
          taskId,
          createdAt: event.created_at,
          payload: {
            streamId,
            text: snapText,
            partial: false,
          } satisfies AssistantTextPayload,
        }
        next = insertEntry(next, entry)
      } else {
        const p = next.entries[idx].payload as AssistantTextPayload
        if (snapText.length > p.text.length + 10) {
          next = updateEntry(next, key, (e) => ({
            ...e,
            payload: { ...(e.payload as AssistantTextPayload), text: snapText, partial: false },
          }))
        }
      }
      next.activeStreamByTask = { ...next.activeStreamByTask, [taskId]: streamId }
      break
    }
    case 'message.assistant.delta': {
      if (!options.appendAssistantDelta || !text || !taskId) break
      const streamId = resolveStreamId(next, event, taskId)
      next = appendAssistantDelta(next, taskId, streamId, text, event)
      break
    }
    case 'message.assistant.completed': {
      const streamId = taskId ? resolveStreamIdForCompletion(next, event, taskId) : ''
      if (streamId) {
        next = completeAssistantStream(next, streamId)
      }
      pushAudit(next, event, 'Assistant response completed', streamId || String(payload.text || '').slice(0, 80), 'done')
      break
    }
    case 'message.assistant.stopped': {
      const streamId = taskId ? resolveStreamIdForCompletion(next, event, taskId) : ''
      if (streamId) {
        next = completeAssistantStream(next, streamId, { stopped: true })
      }
      pushAudit(next, event, 'Assistant response stopped', streamId, 'stopped')
      break
    }
    case 'reasoning.delta': {
      if (!taskId) break
      const key = `reasoning:${taskId}`
      const idx = next.indexByKey[key]
      if (idx !== undefined) {
        next = updateEntry(next, key, (e) => {
          const p = e.payload as ReasoningEntryPayload
          return { ...e, payload: { ...p, text: p.text + text, state: 'running' } }
        })
      } else {
        const entry: TimelineEntry = {
          key,
          id: key,
          seq: event.seq || next.lastSeq,
          kind: 'reasoning',
          taskId,
          createdAt: event.created_at,
          payload: { text, state: 'running' } satisfies ReasoningEntryPayload,
        }
        next = insertEntry(next, entry)
      }
      pushAudit(next, event, 'Reasoning update', text.slice(0, 120), 'running')
      break
    }
    case 'tool.started': {
      if (taskId && !String(payload.stream_id || '')) {
        const seg = next.legacySegmentByTask[taskId] ?? 0
        next.legacySegmentByTask = { ...next.legacySegmentByTask, [taskId]: seg + 1 }
      }
      const toolcallId = String(payload.toolcall_id || event.id)
      const key = `tool:${toolcallId}`
      const startedAt = Number(payload.started_at || event.created_at || 0) || undefined
      const toolPayload: ToolEntryPayload = {
        toolcallId,
        name: String(payload.tool_name || payload.name || 'tool'),
        state: 'running',
        args: typeof payload.args === 'string' ? payload.args : undefined,
        startedAt,
      }
      if (next.indexByKey[key] !== undefined) {
        next = updateEntry(next, key, (e) => {
          const prev = e.payload as ToolEntryPayload
          if (prev.state !== 'running') return e
          return { ...e, payload: { ...toolPayload, result: prev.result, elapsedMs: prev.elapsedMs } }
        })
      } else {
        const entry: TimelineEntry = {
          key,
          id: key,
          seq: event.seq || next.lastSeq,
          kind: 'tool',
          taskId,
          createdAt: event.created_at,
          payload: toolPayload,
        }
        next = insertEntry(next, entry)
      }
      next.tools = upsertToolList(next.tools, toolPayload)
      pushAudit(next, event, `Tool started: ${toolPayload.name}`, toolPayload.args, 'running')
      break
    }
    case 'tool.completed': {
      const tcid = String(payload.toolcall_id || '')
      const name = String(payload.tool_name || payload.name || 'tool')
      const result = String(payload.result || '')
      const endState = toolStateFromCompletion(result, payload.state)
      const key = tcid ? `tool:${tcid}` : null
      const elapsedMs = payload.elapsed_ms != null ? Number(payload.elapsed_ms) : undefined
      const patch = (p: ToolEntryPayload): ToolEntryPayload => ({
        ...p,
        state: endState,
        result,
        elapsedMs: elapsedMs ?? p.elapsedMs,
      })
      const startedAt = Number(payload.started_at || event.created_at || 0) || undefined
      if (key && next.indexByKey[key] !== undefined) {
        next = updateEntry(next, key, (e) => ({ ...e, payload: patch(e.payload as ToolEntryPayload) }))
        const updated = next.entries[next.indexByKey[key]].payload as ToolEntryPayload
        next.tools = upsertToolList(next.tools, updated)
      } else if (key && tcid) {
        const toolPayload: ToolEntryPayload = {
          toolcallId: tcid,
          name,
          state: endState,
          result,
          startedAt,
          elapsedMs,
        }
        const entry: TimelineEntry = {
          key,
          id: key,
          seq: event.seq || next.lastSeq,
          kind: 'tool',
          taskId,
          createdAt: event.created_at,
          payload: toolPayload,
        }
        next = insertEntry(next, entry)
        next.tools = upsertToolList(next.tools, toolPayload)
      } else {
        next.entries = next.entries.map((e) => {
          if (e.kind !== 'tool') return e
          const p = e.payload as ToolEntryPayload
          if (tcid && p.toolcallId !== tcid) return e
          if (!tcid && (p.name !== name || p.state !== 'running')) return e
          const updated = patch(p)
          next.tools = upsertToolList(next.tools, updated)
          return { ...e, payload: updated }
        })
      }
      pushAudit(
        next,
        event,
        endState === 'rejected' ? `Tool rejected: ${name}` : `Tool completed: ${name}`,
        result,
        endState,
      )
      break
    }
    case 'tool.error':
      pushAudit(next, event, `Tool error: ${String(payload.tool_name || 'tool')}`, String(payload.error || ''), 'error')
      break
    case 'interaction.requested': {
      const iid = String(payload.id || payload.interaction_id || event.id)
      const key = `interaction:${iid}`
      const interactionPayload: InteractionEntryPayload = {
        interaction_type: (payload.interaction_type || 'approval') as 'approval' | 'input_request',
        title: String(payload.title || ''),
        message: String(payload.message || ''),
        reason: String(payload.reason || ''),
        status: 'pending',
        files: payload.files as InteractionEntryPayload['files'],
        fields: payload.fields as InteractionEntryPayload['fields'],
      }
      if (next.indexByKey[key] !== undefined) {
        next = updateEntry(next, key, (e) => ({ ...e, seq: event.seq || e.seq, payload: interactionPayload }))
      } else {
        const entry: TimelineEntry = {
          key,
          id: iid,
          seq: event.seq || next.lastSeq,
          kind: 'interaction',
          taskId,
          createdAt: event.created_at,
          payload: interactionPayload,
        }
        next = insertEntry(next, entry)
      }
      pushAudit(next, event, `Interaction: ${payload.title || payload.interaction_type}`, undefined, 'pending')
      break
    }
    case 'interaction.approved':
    case 'interaction.rejected':
    case 'interaction.responded': {
      const iid = String(payload.id || payload.interaction_id || '')
      const newStatus =
        event.event_type === 'interaction.approved'
          ? 'approved'
          : event.event_type === 'interaction.rejected'
            ? 'rejected'
            : 'responded'
      const response = (payload.response || {}) as Record<string, unknown>
      const key = `interaction:${iid}`
      if (iid && next.indexByKey[key] !== undefined) {
        next = updateEntry(next, key, (e) => ({
          ...e,
          payload: {
            ...(e.payload as InteractionEntryPayload),
            status: newStatus,
            response,
            files: (payload.files as InteractionEntryPayload['files']) || (e.payload as InteractionEntryPayload).files,
            title: String(payload.title || (e.payload as InteractionEntryPayload).title),
            message: String(payload.message || (e.payload as InteractionEntryPayload).message),
            reason: String(payload.reason || (e.payload as InteractionEntryPayload).reason || ''),
          },
        }))
      } else if (iid) {
        const interactionPayload: InteractionEntryPayload = {
          interaction_type: (payload.interaction_type || 'approval') as 'approval' | 'input_request',
          title: String(payload.title || ''),
          message: String(payload.message || ''),
          reason: String(payload.reason || ''),
          status: newStatus,
          files: payload.files as InteractionEntryPayload['files'],
          fields: payload.fields as InteractionEntryPayload['fields'],
          response,
        }
        const entry: TimelineEntry = {
          key,
          id: iid,
          seq: event.seq || next.lastSeq,
          kind: 'interaction',
          taskId,
          createdAt: event.created_at,
          payload: interactionPayload,
        }
        next = insertEntry(next, entry)
      }
      pushAudit(next, event, `Interaction ${newStatus}`, iid, newStatus)
      break
    }
    default:
      pushAudit(next, event, event.event_type, JSON.stringify(payload).slice(0, 180), String(payload.state || ''))
  }

  return next
}

/** Optimistic user bubble before server ack (negative seq → sorts before confirmed messages). */
export function applyOptimisticUser(
  state: SessionTimelineState,
  text: string,
): SessionTimelineState {
  const optimisticId = `optimistic-user:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const entry: TimelineEntry = {
    key: optimisticId,
    id: optimisticId,
    seq: -(Date.now()),
    kind: 'user',
    taskId: null,
    createdAt: Math.floor(Date.now() / 1000),
    payload: { text, messageId: optimisticId } satisfies UserEntryPayload,
  }
  return insertEntry(state, entry)
}

export function mergePendingInteractions(
  state: SessionTimelineState,
  pending: Record<string, unknown>[],
): SessionTimelineState {
  let next = state
  for (const raw of pending) {
    const iid = String(raw.id || raw.interaction_id || '')
    if (!iid) continue
    const key = `interaction:${iid}`
    if (next.indexByKey[key] !== undefined) {
      const existing = next.entries[next.indexByKey[key]].payload as InteractionEntryPayload
      if (existing.status === 'pending') continue
    }
    const taskId = String(raw.task_id || '') || null
    const interactionPayload: InteractionEntryPayload = {
      interaction_type: (raw.interaction_type as 'approval' | 'input_request') || 'approval',
      title: String(raw.title || ''),
      message: String(raw.message || ''),
      reason: String(raw.reason || ''),
      status: 'pending',
      files: raw.files as InteractionEntryPayload['files'],
      fields: raw.fields as InteractionEntryPayload['fields'],
    }
    const entry: TimelineEntry = {
      key,
      id: iid,
      seq: Number(raw.created_at) || next.lastSeq + 1,
      kind: 'interaction',
      taskId,
      createdAt: Number(raw.created_at) || undefined,
      payload: interactionPayload,
    }
    next = insertEntry(next, entry)
  }
  return next
}

/** Rebuild chat timeline from events (canonical). Messages table supplies user rows only; assistant text comes from events. */
export function rebuildTimelineFromSources(
  events: SessionEvent[],
  messages: Message[],
  pending: Record<string, unknown>[],
  activeTask?: Task | null,
): SessionTimelineState {
  const sorted = [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))
  let state = emptyTimelineState()
  for (const evt of sorted) {
    state = applyTimelineEvent(state, evt, { appendAssistantDelta: true, ignoreSeqGuard: true })
  }
  for (const m of messages) {
    if (m.role !== 'user') continue
    const mid = m.id
    const key = `user:${mid}`
    if (state.indexByKey[key] !== undefined) continue
    const entry: TimelineEntry = {
      key,
      id: mid,
      seq: m.created_at || 0,
      kind: 'user',
      taskId: m.task_id ?? null,
      createdAt: m.created_at,
      payload: { text: m.content, messageId: mid },
    }
    state = insertEntry(state, entry)
  }
  state = mergePendingInteractions(state, pending)
  if (activeTask) {
    state.activeTaskId = activeTask.id
    state.taskState = activeTask.state
  }
  return state
}

export function getChatEntries(state: SessionTimelineState): TimelineEntry[] {
  return state.entries.filter((e) =>
    e.kind === 'user'
    || e.kind === 'assistant_text'
    || e.kind === 'reasoning'
    || e.kind === 'tool'
    || e.kind === 'interaction',
  )
}
