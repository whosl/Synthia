import {
  insertEntry,
  pushAudit,
  updateEntry,
  type TimelineHandlerContext,
} from '../context'
import type { CustomEntryPayload, SessionTimelineState, TimelineEntry } from '../types'

function upsertCustomCard(
  state: SessionTimelineState,
  blockId: string,
  payload: CustomEntryPayload,
  ctx: TimelineHandlerContext,
): SessionTimelineState {
  const key = `custom:${blockId}`
  if (state.indexByKey[key] !== undefined) {
    return updateEntry(state, key, (e) => ({
      ...e,
      seq: ctx.event.seq || e.seq,
      payload,
    }))
  }
  const entry: TimelineEntry = {
    key,
    id: blockId,
    seq: ctx.event.seq || state.lastSeq,
    kind: 'custom',
    taskId: ctx.taskId,
    createdAt: ctx.event.created_at ?? 0,
    payload,
  }
  return insertEntry(state, entry)
}

export function handleIntentClassified(ctx: TimelineHandlerContext): SessionTimelineState {
  const { payload, state: next } = ctx
  const action = String(payload.action || '')
  if (action === 'ask_missing_info') {
    return handleMissingInfoRequired(ctx)
  }
  if (action === 'create_run') {
    const runId = String(payload.run_id || '')
    const blockId = `run-${runId}`
    return upsertCustomCard(
      next,
      blockId,
      {
        uiKind: 'run',
        title: String(payload.flow_name || 'run').replace(/_/g, ' '),
        data: {
          run_id: runId,
          flow_name: payload.flow_name,
          state: 'queued',
          task_id: payload.task_id,
        },
      },
      ctx,
    )
  }
  pushAudit(next, ctx.event, 'Intent', action)
  return next
}

export function handleMissingInfoRequired(ctx: TimelineHandlerContext): SessionTimelineState {
  const { payload, state: next } = ctx
  const blockId = String(payload.block_id || `missing-${ctx.taskId}`)
  const data = (payload.data as Record<string, unknown>) ?? payload
  const state = upsertCustomCard(
    next,
    blockId,
    {
      uiKind: 'missing_info',
      title: String(payload.title || '缺少参数'),
      data: data as Record<string, unknown>,
    },
    ctx,
  )
  pushAudit(state, ctx.event, 'Missing info', blockId, 'custom')
  return state
}

export function handleRunOrchestrationEvent(ctx: TimelineHandlerContext): SessionTimelineState {
  const { event, payload, state: next } = ctx
  const runId = String(payload.run_id || '')
  if (!runId) return next
  const blockId = `run-${runId}`
  const key = `custom:${blockId}`
  const terminal =
    event.event_type === 'run.succeeded'
      ? 'succeeded'
      : event.event_type === 'run.failed'
        ? 'failed'
        : event.event_type === 'run.cancelled'
          ? 'cancelled'
          : event.event_type === 'run.queued'
            ? 'queued'
            : 'running'

  if (next.indexByKey[key] !== undefined) {
    return updateEntry(next, key, (e) => {
      const p = e.payload as CustomEntryPayload
      return {
        ...e,
        seq: event.seq || e.seq,
        payload: {
          ...p,
          data: { ...p.data, state: terminal, final: payload },
        },
      }
    })
  }
  return upsertCustomCard(
    next,
    blockId,
    {
      uiKind: 'run',
      title: 'Run',
      data: { run_id: runId, state: terminal, ...payload },
    },
    ctx,
  )
}

export function handleArtifactCreatedChat(ctx: TimelineHandlerContext): SessionTimelineState {
  const { payload, state: next } = ctx
  const blockId = String(payload.block_id || `art-${payload.artifact_id || ctx.event.id}`)
  const state = upsertCustomCard(
    next,
    blockId,
    {
      uiKind: 'artifact',
      title: String(payload.path || '').split('/').pop() || 'artifact',
      data: payload as Record<string, unknown>,
    },
    ctx,
  )
  pushAudit(state, ctx.event, 'Artifact', blockId, 'custom')
  return state
}

export function handleCustomRunCard(ctx: TimelineHandlerContext): SessionTimelineState {
  const { payload, state: next } = ctx
  const inner = (payload.data as Record<string, unknown> | undefined) ?? {}
  const blockId = String(payload.block_id || `run-${inner.run_id || ctx.event.id}`)
  const data = inner.run_id ? inner : (payload as Record<string, unknown>)
  return upsertCustomCard(
    next,
    blockId,
    {
      uiKind: 'run',
      title: String(payload.title || 'Run'),
      data: data as Record<string, unknown>,
    },
    ctx,
  )
}
