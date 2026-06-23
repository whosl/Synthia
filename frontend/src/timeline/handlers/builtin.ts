import { assistantEntryKey, completeAssistantStream, resolveStreamId, resolveStreamIdForCompletion } from '../streamId'
import { toolStateFromCompletion } from '../toolState'
import type { TimelineHandlerContext } from '../context'
import {
  appendAssistantDelta,
  eventTimeMs,
  insertEntry,
  pushAudit,
  removeKeys,
  toolStartedAtMs,
  updateEntry,
  upsertToolList,
  type AssistantTextPayload,
  type InteractionEntryPayload,
  type ReasoningEntryPayload,
  type ToolEntryPayload,
  type UserEntryPayload,
} from '../context'
import type { CustomEntryPayload, SessionTimelineState, TimelineEntry } from '../types'
import type { ErrorEntryPayload } from '../types'

function auditOnly(ctx: TimelineHandlerContext, title?: string, detail?: string, auditState?: string): SessionTimelineState {
  const { state, event, payload } = ctx
  pushAudit(
    state,
    event,
    title ?? event.event_type,
    detail ?? JSON.stringify(payload).slice(0, 180),
    auditState ?? String(payload.state || ''),
  )
  return state
}

function payloadText(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
    if (value != null && typeof value !== 'object') return String(value)
  }
  return ''
}

function upsertErrorEntry(
  state: SessionTimelineState,
  event: TimelineHandlerContext['event'],
  taskId: string | null,
  payload: Record<string, unknown>,
  title: string,
): SessionTimelineState {
  const message = payloadText(payload, ['error', 'message', 'detail', 'result'])
  const runId = String(payload.run_id || event.run_id || '')
  const scope = taskId ? `task:${taskId}` : runId ? `run:${runId}` : event.id
  const key = `error:${scope}`
  const errorPayload: ErrorEntryPayload = {
    title,
    message: message || title,
    source: event.event_type,
  }
  if (state.indexByKey[key] !== undefined) {
    return updateEntry(state, key, (e) => ({
      ...e,
      payload: errorPayload,
    }))
  }
  return insertEntry(state, {
    key,
    id: key,
    seq: event.seq || state.lastSeq,
    kind: 'error',
    taskId,
    createdAt: event.created_at,
    payload: errorPayload,
  })
}

function closeRunningToolsForTask(
  state: SessionTimelineState,
  taskId: string | null,
  result: string,
): SessionTimelineState {
  const entries = state.entries.map((entry) => {
    if (entry.kind !== 'tool') return entry
    if (taskId && entry.taskId !== taskId) return entry
    const payload = entry.payload as ToolEntryPayload
    if (payload.state !== 'running') return entry
    return {
      ...entry,
      payload: {
        ...payload,
        state: 'error',
        error: result,
        result: payload.result || result,
      } satisfies ToolEntryPayload,
    }
  })
  const indexByKey: Record<string, number> = {}
  entries.forEach((entry, index) => { indexByKey[entry.key] = index })
  const tools = state.tools.map((tool) => {
    if (tool.state !== 'running') return tool
    const matchingEntry = entries.find((entry) => {
      if (entry.kind !== 'tool') return false
      if (taskId && entry.taskId !== taskId) return false
      return (entry.payload as ToolEntryPayload).toolcallId === tool.toolcallId
    })
    if (!matchingEntry) return tool
    return {
      ...tool,
      state: 'error',
      error: result,
      result: tool.result || result,
    } satisfies ToolEntryPayload
  })
  return { ...state, entries, indexByKey, tools }
}

export function handleMessageUserCreated(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, text, taskId } = ctx
  let next = ctx.state
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
  return next
}

export function handleTaskCreatedOrStarted(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  next.activeTaskId = taskId || String(payload.task_id || '')
  next.taskState = 'running'
  pushAudit(next, event, 'Task started', next.activeTaskId || undefined, 'running')
  return next
}

export function handleTaskStopping(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, state: next } = ctx
  next.taskState = 'stopping'
  const stopMsg = 'Task stopped by user'
  next.entries = next.entries.map((e) => {
    if (e.kind !== 'tool') return e
    const p = e.payload as ToolEntryPayload
    if (p.state !== 'running') return e
    return { ...e, payload: { ...p, state: 'stopped', result: stopMsg } }
  })
  next.tools = next.tools.map((t) =>
    t.state === 'running' ? { ...t, state: 'stopped', result: stopMsg } : t,
  )
  pushAudit(next, event, 'Stop requested', String(payload.task_id || ''), 'stopping')
  return next
}

export function handleTaskStopped(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, state: next } = ctx
  next.taskState = 'stopped'
  pushAudit(next, event, 'Task stopped', String(payload.task_id || ''), 'stopped')
  return next
}

export function handleTaskDone(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, state: next } = ctx
  next.taskState = 'done'
  next.activeTaskId = null
  pushAudit(next, event, 'Task completed', String(payload.task_id || ''), 'done')
  return next
}

export function handleTaskError(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  next.taskState = 'error'
  next.activeTaskId = null
  let state = closeRunningToolsForTask(next, taskId, payloadText(payload, ['error', 'message']) || 'Task failed')
  state = upsertErrorEntry(state, event, taskId, payload, 'Task failed')
  pushAudit(state, event, 'Task failed', String(payload.error || ''), 'error')
  return state
}

export function handleRunError(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  let state = closeRunningToolsForTask(next, taskId, payloadText(payload, ['error', 'message']) || 'Run failed')
  state = upsertErrorEntry(state, event, taskId, payload, 'Run failed')
  pushAudit(state, event, 'Run failed', String(payload.error || ''), 'error')
  return state
}

export function handleAssistantStreamOpened(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  if (!taskId) return next
  const streamId = String(payload.stream_id || '')
  if (streamId) {
    next.activeStreamByTask = { ...next.activeStreamByTask, [taskId]: streamId }
  }
  pushAudit(next, event, 'Synthia stream opened', streamId)
  return next
}

export function handleAssistantStreamCompleted(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, state: next } = ctx
  const streamId = String(payload.stream_id || '')
  let state = next
  if (streamId) {
    state = completeAssistantStream(state, streamId, { stopped: Boolean(payload.stopped) })
  }
  pushAudit(state, event, 'Synthia stream completed', streamId, 'done')
  return state
}

export function handleMessageAssistantSnapshot(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  const streamId = String(payload.stream_id || '')
  const snapText = String(payload.text || '')
  if (!streamId || !snapText || !taskId) return next
  const key = assistantEntryKey(streamId)
  const idx = next.indexByKey[key]
  let state = next
  if (idx === undefined) {
    const entry: TimelineEntry = {
      key,
      id: key,
      seq: event.seq || state.lastSeq,
      kind: 'assistant_text',
      taskId,
      createdAt: event.created_at,
      payload: { streamId, text: snapText, partial: false } satisfies AssistantTextPayload,
    }
    state = insertEntry(state, entry)
  } else {
    const p = state.entries[idx].payload as AssistantTextPayload
    if (snapText.length > p.text.length + 10) {
      state = updateEntry(state, key, (e) => ({
        ...e,
        payload: { ...(e.payload as AssistantTextPayload), text: snapText, partial: false },
      }))
    }
  }
  state.activeStreamByTask = { ...state.activeStreamByTask, [taskId]: streamId }
  return state
}

export function handleMessageAssistantDelta(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, text, taskId, options, state: next } = ctx
  if (!options.appendAssistantDelta || !text || !taskId) return next
  const streamId = resolveStreamId(next, event, taskId)
  return appendAssistantDelta(next, taskId, streamId, text, event)
}

export function handleMessageAssistantCompleted(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  const streamId = taskId ? resolveStreamIdForCompletion(next, event, taskId) : ''
  const isEmpty = Boolean(payload.empty)
  let state = next
  if (streamId) {
    const key = assistantEntryKey(streamId)
    if (state.indexByKey[key] !== undefined) {
      state = completeAssistantStream(state, streamId)
      if (isEmpty) {
        state = updateEntry(state, key, (e) => {
          const p = e.payload as AssistantTextPayload
          return {
            ...e,
            payload: { ...p, partial: false, emptyTurn: true },
          }
        })
      }
    } else if (isEmpty && taskId) {
      const entry: TimelineEntry = {
        key,
        id: key,
        seq: event.seq || state.lastSeq,
        kind: 'assistant_text',
        taskId,
        createdAt: event.created_at,
        payload: {
          streamId,
          text: '',
          partial: false,
          emptyTurn: true,
        } satisfies AssistantTextPayload,
      }
      state = insertEntry(state, entry)
    } else {
      state = completeAssistantStream(state, streamId)
    }
  }
  pushAudit(
    state,
    event,
    isEmpty ? 'Synthia response (tools only)' : 'Synthia response completed',
    streamId || String(payload.text || '').slice(0, 80),
    'done',
  )
  return state
}

export function handleMessageAssistantStopped(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, taskId, state: next } = ctx
  const streamId = taskId ? resolveStreamIdForCompletion(next, event, taskId) : ''
  let state = next
  if (streamId) state = completeAssistantStream(state, streamId, { stopped: true })
  pushAudit(state, event, 'Synthia response stopped', streamId, 'stopped')
  return state
}

export function handleReasoningDelta(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, text, taskId, state: next } = ctx
  if (!taskId) return next
  const key = `reasoning:${taskId}`
  const idx = next.indexByKey[key]
  let state = next
  if (idx !== undefined) {
    state = updateEntry(state, key, (e) => {
      const p = e.payload as ReasoningEntryPayload
      return { ...e, payload: { ...p, text: p.text + text, state: 'running' } }
    })
  } else {
    const entry: TimelineEntry = {
      key,
      id: key,
      seq: event.seq || state.lastSeq,
      kind: 'reasoning',
      taskId,
      createdAt: event.created_at,
      payload: { text, state: 'running' } satisfies ReasoningEntryPayload,
    }
    state = insertEntry(state, entry)
  }
  pushAudit(state, event, 'Reasoning update', text.slice(0, 120), 'running')
  return state
}

export function handleToolStarted(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  let state = next
  if (taskId && !String(payload.stream_id || '')) {
    const seg = state.legacySegmentByTask[taskId] ?? 0
    state.legacySegmentByTask = { ...state.legacySegmentByTask, [taskId]: seg + 1 }
  }
  const toolcallId = String(payload.toolcall_id || event.id)
  const key = `tool:${toolcallId}`
  const startedAtMs = toolStartedAtMs(payload, event)
  const startedAt = startedAtMs != null ? Math.floor(startedAtMs / 1000) : Number(payload.started_at || event.created_at || 0) || undefined
  const toolPayload: ToolEntryPayload = {
    toolcallId,
    name: String(payload.tool_name || payload.name || 'tool'),
    state: 'running',
    args: typeof payload.args === 'string' ? payload.args : undefined,
    startedAt,
    startedAtMs,
  }
  if (state.indexByKey[key] !== undefined) {
    state = updateEntry(state, key, (e) => {
      const prev = e.payload as ToolEntryPayload
      if (prev.state !== 'running') return e
      return {
        ...e,
        payload: {
          ...toolPayload,
          result: prev.result,
          elapsedMs: prev.elapsedMs,
          startedAtMs: toolPayload.startedAtMs ?? prev.startedAtMs,
        },
      }
    })
  } else {
    const entry: TimelineEntry = {
      key,
      id: key,
      seq: event.seq || state.lastSeq,
      kind: 'tool',
      taskId,
      createdAt: event.created_at,
      payload: toolPayload,
    }
    state = insertEntry(state, entry)
  }
  state.tools = upsertToolList(state.tools, toolPayload)
  pushAudit(state, event, `Tool started: ${toolPayload.name}`, toolPayload.args, 'running')
  return state
}

export function handleToolCompleted(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  const tcid = String(payload.toolcall_id || '')
  const name = String(payload.tool_name || payload.name || 'tool')
  const result = String(payload.result || '')
  const endState = toolStateFromCompletion(result, payload.state)
  const key = tcid ? `tool:${tcid}` : null
  let elapsedMs = payload.elapsed_ms != null ? Number(payload.elapsed_ms) : undefined
  const startedAtMs = toolStartedAtMs(payload, event)
  const startedAt = startedAtMs != null
    ? Math.floor(startedAtMs / 1000)
    : Number(payload.started_at || event.created_at || 0) || undefined
  if ((!elapsedMs || elapsedMs <= 0) && startedAtMs != null) {
    elapsedMs = Math.max(1, eventTimeMs(event.created_at) - startedAtMs)
  }
  const patch = (p: ToolEntryPayload): ToolEntryPayload => ({
    ...p,
    state: endState,
    result,
    startedAtMs: startedAtMs ?? p.startedAtMs,
    elapsedMs: elapsedMs ?? p.elapsedMs,
  })
  let state = next
  if (key && state.indexByKey[key] !== undefined) {
    state = updateEntry(state, key, (e) => ({ ...e, payload: patch(e.payload as ToolEntryPayload) }))
    const updated = state.entries[state.indexByKey[key]].payload as ToolEntryPayload
    state.tools = upsertToolList(state.tools, updated)
  } else if (key && tcid) {
    const toolPayload: ToolEntryPayload = {
      toolcallId: tcid,
      name,
      state: endState,
      result,
      startedAt,
      startedAtMs,
      elapsedMs,
    }
    const entry: TimelineEntry = {
      key,
      id: key,
      seq: event.seq || state.lastSeq,
      kind: 'tool',
      taskId,
      createdAt: event.created_at,
      payload: toolPayload,
    }
    state = insertEntry(state, entry)
    state.tools = upsertToolList(state.tools, toolPayload)
  } else {
    state.entries = state.entries.map((e) => {
      if (e.kind !== 'tool') return e
      const p = e.payload as ToolEntryPayload
      if (tcid && p.toolcallId !== tcid) return e
      if (!tcid && (p.name !== name || p.state !== 'running')) return e
      const updated = patch(p)
      state.tools = upsertToolList(state.tools, updated)
      return { ...e, payload: updated }
    })
  }
  pushAudit(
    state,
    event,
    endState === 'rejected' ? `Tool rejected: ${name}` : `Tool completed: ${name}`,
    result,
    endState,
  )
  return state
}

export function handleToolError(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  const toolcallId = String(payload.toolcall_id || payload.call_id || payload.id || '')
  const name = String(payload.tool_name || payload.name || 'tool')
  const error = payloadText(payload, ['error', 'message', 'result']) || 'Tool failed'
  const result = payloadText(payload, ['result', 'output']) || error
  const key = toolcallId ? `tool:${toolcallId}` : null
  const patch = (p: ToolEntryPayload): ToolEntryPayload => ({
    ...p,
    state: 'error',
    error,
    result: p.result || result,
    elapsedMs: payload.elapsed_ms != null ? Number(payload.elapsed_ms) : p.elapsedMs,
  })
  let state = next
  if (key && state.indexByKey[key] !== undefined) {
    state = updateEntry(state, key, (e) => ({ ...e, payload: patch(e.payload as ToolEntryPayload) }))
    const updated = state.entries[state.indexByKey[key]].payload as ToolEntryPayload
    state.tools = upsertToolList(state.tools, updated)
  } else if (key) {
    const startedAtMs = toolStartedAtMs(payload, event)
    const toolPayload: ToolEntryPayload = {
      toolcallId,
      name,
      state: 'error',
      error,
      result,
      startedAt: startedAtMs != null ? Math.floor(startedAtMs / 1000) : event.created_at,
      startedAtMs,
      elapsedMs: payload.elapsed_ms != null ? Number(payload.elapsed_ms) : undefined,
    }
    state = insertEntry(state, {
      key,
      id: key,
      seq: event.seq || state.lastSeq,
      kind: 'tool',
      taskId,
      createdAt: event.created_at,
      payload: toolPayload,
    })
    state.tools = upsertToolList(state.tools, toolPayload)
  } else {
    state.entries = state.entries.map((e) => {
      if (e.kind !== 'tool') return e
      const p = e.payload as ToolEntryPayload
      if (p.name !== name || p.state !== 'running') return e
      const updated = patch(p)
      state.tools = upsertToolList(state.tools, updated)
      return { ...e, payload: updated }
    })
  }
  pushAudit(state, event, `Tool error: ${name}`, error, 'error')
  return state
}

export function handleInteractionRequested(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
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
  let state = next
  if (state.indexByKey[key] !== undefined) {
    state = updateEntry(state, key, (e) => ({ ...e, seq: event.seq || e.seq, payload: interactionPayload }))
  } else {
    const entry: TimelineEntry = {
      key,
      id: iid,
      seq: event.seq || state.lastSeq,
      kind: 'interaction',
      taskId,
      createdAt: event.created_at,
      payload: interactionPayload,
    }
    state = insertEntry(state, entry)
  }
  pushAudit(state, event, `Interaction: ${payload.title || payload.interaction_type}`, undefined, 'pending')
  return state
}

export function handleInteractionResolved(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  const iid = String(payload.id || payload.interaction_id || '')
  const newStatus =
    event.event_type === 'interaction.approved'
      ? 'approved'
      : event.event_type === 'interaction.rejected'
        ? 'rejected'
        : 'responded'
  const response = (payload.response || {}) as Record<string, unknown>
  const key = `interaction:${iid}`
  let state = next
  if (iid && state.indexByKey[key] !== undefined) {
    state = updateEntry(state, key, (e) => ({
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
      seq: event.seq || state.lastSeq,
      kind: 'interaction',
      taskId,
      createdAt: event.created_at,
      payload: interactionPayload,
    }
    state = insertEntry(state, entry)
  }
  pushAudit(state, event, `Interaction ${newStatus}`, iid, newStatus)
  return state
}

/** Extension: custom.* events or payload.ui_kind → chat custom block */
export function handleCustomOrExtension(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, taskId, state: next } = ctx
  const wire = event.event_type
  const uiKind = String(payload.ui_kind || payload.component || '')
  if (!wire.startsWith('custom.') && !uiKind) {
    return auditOnly(ctx)
  }
  const blockId = String(payload.block_id || payload.id || event.id)
  const key = `custom:${blockId}`
  const customPayload: CustomEntryPayload = {
    uiKind: uiKind || wire.replace(/^custom\./, ''),
    title: String(payload.title || ''),
    data: (payload.data as Record<string, unknown>) ?? payload,
  }
  let state = next
  if (state.indexByKey[key] !== undefined) {
    state = updateEntry(state, key, (e) => ({
      ...e,
      seq: event.seq || e.seq,
      payload: customPayload,
    }))
  } else {
    const entry: TimelineEntry = {
      key,
      id: blockId,
      seq: event.seq || state.lastSeq,
      kind: 'custom',
      taskId,
      createdAt: event.created_at,
      payload: customPayload,
    }
    state = insertEntry(state, entry)
  }
  pushAudit(state, event, customPayload.title || customPayload.uiKind, undefined, 'custom')
  return state
}

export { auditOnly }
