import type { Message, SessionEvent, Task } from '../api/types'

export interface ReasoningBlockState {
  id: string
  text: string
  state: 'running' | 'done'
  startedAt?: number
}

export interface ToolBlockState {
  id: string
  name: string
  state: 'running' | 'completed' | 'error' | 'rejected'
  args?: string
  result?: string
  error?: string
  startedAt?: number
  elapsedMs?: number
}

export interface TextBlockState {
  id: string
  text: string
}

export interface InteractionBlockState {
  id: string
  interaction_type: 'approval' | 'input_request'
  title: string
  message: string
  status: 'pending' | 'approved' | 'rejected' | 'responded'
  files?: Array<{ path: string; content: string; description?: string; action: string }>
  fields?: Array<{ id: string; label: string; field_type: string; options?: Array<{ value: string; label: string }>; placeholder?: string; recommendations?: string[]; required?: boolean }>
  response?: Record<string, any>
  createdAt?: number
}

export type TurnBlock =
  | { kind: 'text'; data: TextBlockState }
  | { kind: 'reasoning'; data: ReasoningBlockState }
  | { kind: 'tool'; data: ToolBlockState }
  | { kind: 'interaction'; data: InteractionBlockState }

export interface TerminalTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  taskId?: string | null
  createdAt?: number
  partial?: boolean
  stopped?: boolean
  reasoning: ReasoningBlockState[]
  tools: ToolBlockState[]
  blocks: TurnBlock[]
}

export interface TimelineItem {
  id: string
  seq?: number
  type: string
  title: string
  detail?: string
  state?: string
  createdAt?: number
}

export interface TerminalRuntimeState {
  turns: TerminalTurn[]
  timeline: TimelineItem[]
  tools: ToolBlockState[]
  lastSeq: number
  taskState?: Task['state']
  activeTaskId?: string | null
}

/** Earliest event time on a turn — used so user/assistant sort correctly after reload. */
const touchTurnCreatedAt = (turn: TerminalTurn, eventTime?: number) => {
  if (eventTime == null || eventTime <= 0) return
  if (turn.createdAt == null || eventTime < turn.createdAt) turn.createdAt = eventTime
}

const assistantTurn = (state: TerminalRuntimeState, taskId?: string | null, eventTime?: number) => {
  // Find existing assistant turn for this task (preserves position in interleaved list)
  if (taskId) {
    const existing = state.turns.find((t) => t.role === 'assistant' && t.taskId === taskId)
    if (existing) {
      touchTurnCreatedAt(existing, eventTime)
      return existing
    }
  }
  const last = state.turns[state.turns.length - 1]
  if (last?.role === 'assistant' && last.taskId === taskId) {
    touchTurnCreatedAt(last, eventTime)
    return last
  }
  const turn: TerminalTurn = {
    id: `assistant-${taskId || Date.now()}`,
    role: 'assistant',
    taskId,
    content: '',
    reasoning: [],
    tools: [],
    blocks: [],
    createdAt: eventTime,
  }
  state.turns.push(turn)
  return turn
}

/** Map tool result JSON / event payload to UI state. */
export function toolStateFromCompletion(result: string, payloadState?: unknown): ToolBlockState['state'] {
  if (payloadState === 'rejected' || payloadState === 'error' || payloadState === 'completed') {
    return payloadState
  }
  const text = (result || '').trim()
  if (!text.startsWith('{')) return 'completed'
  try {
    const parsed = JSON.parse(text) as { edagent_outcome?: string }
    if (parsed.edagent_outcome === 'user_rejected') return 'rejected'
    if (parsed.edagent_outcome === 'execution_failed') return 'error'
  } catch {
    /* ignore */
  }
  return 'completed'
}

/** Sort turns chronologically; user before assistant when timestamps tie. */
export function sortTurnsChronologically(turns: TerminalTurn[]): TerminalTurn[] {
  return [...turns].sort((a, b) => {
    const ca = a.createdAt
    const cb = b.createdAt
    if (ca != null && cb != null) {
      if (ca !== cb) return ca - cb
      if (a.role !== b.role) return a.role === 'user' ? -1 : 1
      return 0
    }
    if (ca != null) return -1
    if (cb != null) return 1
    return 0
  })
}

/** Get or create a text block at the end of the turn's blocks. */
const ensureTextBlock = (turn: TerminalTurn): TextBlockState => {
  const last = turn.blocks[turn.blocks.length - 1]
  if (last && last.kind === 'text') return last.data
  const block: TextBlockState = { id: `text-${Date.now()}-${turn.blocks.length}`, text: '' }
  turn.blocks.push({ kind: 'text', data: block })
  return block
}

/** Close any open text block so the next block (tool/reasoning) comes after it. */
const closeTextBlock = (turn: TerminalTurn) => {
  // Just ensure current text block exists; next non-text push will naturally come after
  // No-op: the next push to blocks[] is ordered
}

export function stateFromMessages(messages: Message[]): TerminalRuntimeState {
  return {
    turns: messages.map((m) => ({
      id: m.id,
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
      taskId: m.task_id,
      createdAt: m.created_at,
      partial: Boolean(m.partial),
      stopped: Boolean(m.stopped),
      reasoning: [],
      tools: [],
      blocks: m.content ? [{ kind: 'text' as const, data: { id: `text-${m.id}`, text: m.content } }] : [],
    })),
    timeline: [],
    tools: [],
    lastSeq: 0,
  }
}

export function applyEvent(
  state: TerminalRuntimeState,
  event: SessionEvent,
  options: { appendAssistantDelta?: boolean; ignoreSeqGuard?: boolean } = {},
): TerminalRuntimeState {
  if (!options.ignoreSeqGuard && event.seq && event.seq <= state.lastSeq) return state
  const next: TerminalRuntimeState = {
    ...state,
    turns: state.turns.map((t) => ({ ...t, reasoning: [...t.reasoning], tools: [...t.tools], blocks: [...t.blocks] })),
    timeline: [...state.timeline],
    tools: [...state.tools],
    lastSeq: Math.max(state.lastSeq, event.seq || 0),
  }
  const payload = event.payload || {}
  const text = String(payload.text || '')
  const taskId = event.task_id || String(payload.task_id || '') || null

  const pushTimeline = (title: string, detail?: string, state?: string) => {
    next.timeline.push({ id: event.id, seq: event.seq, type: event.event_type, title, detail, state, createdAt: event.created_at })
  }

  switch (event.event_type) {
    case 'message.user.created': {
      const existing = next.turns.find((t) => t.id === String(payload.message_id || event.id))
      if (!existing) {
        const userTurn: TerminalTurn = {
          id: String(payload.message_id || event.id),
          role: 'user',
          content: text,
          taskId,
          createdAt: event.created_at,
          reasoning: [],
          tools: [],
          blocks: [],
        }
        touchTurnCreatedAt(userTurn, event.created_at)
        next.turns.push(userTurn)
      }
      pushTimeline('User message', text.slice(0, 80))
      break
    }
    case 'task.created':
    case 'task.started':
      next.activeTaskId = taskId || String(payload.task_id || '')
      next.taskState = 'running'
      pushTimeline('Task started', next.activeTaskId || undefined, 'running')
      break
    case 'task.stopping':
      next.taskState = 'stopping'
      pushTimeline('Stop requested', String(payload.task_id || ''), 'stopping')
      break
    case 'task.stopped':
      next.taskState = 'stopped'
      pushTimeline('Task stopped', String(payload.task_id || ''), 'stopped')
      break
    case 'task.done':
      next.taskState = 'done'
      next.activeTaskId = null
      pushTimeline('Task completed', String(payload.task_id || ''), 'done')
      break
    case 'task.error':
      next.taskState = 'error'
      next.activeTaskId = null
      pushTimeline('Task failed', String(payload.error || ''), 'error')
      break
    case 'message.assistant.delta': {
      if (options.appendAssistantDelta && text) {
        const turn = assistantTurn(next, taskId, event.created_at)
        const tb = ensureTextBlock(turn)
        tb.text += text
        turn.content = turn.blocks
          .filter((block): block is { kind: 'text'; data: TextBlockState } => block.kind === 'text')
          .map((block) => block.data.text)
          .join('')
      }
      break
    }
    case 'message.assistant.completed': {
      const turn = assistantTurn(next, taskId, event.created_at)
      turn.partial = false
      pushTimeline('Assistant response completed', String(payload.text || ''), 'done')
      break
    }
    case 'message.assistant.stopped': {
      const turn = assistantTurn(next, taskId, event.created_at)
      turn.partial = true
      turn.stopped = true
      pushTimeline('Assistant response stopped', undefined, 'stopped')
      break
    }
    case 'reasoning.delta': {
      const turn = assistantTurn(next, taskId, event.created_at)
      closeTextBlock(turn)
      const lastBlock = turn.reasoning[turn.reasoning.length - 1]
      if (lastBlock) {
        lastBlock.text += text
      } else {
        const block: ReasoningBlockState = { id: `reason-${event.id}`, text, state: 'running', startedAt: event.created_at }
        turn.reasoning.push(block)
        turn.blocks.push({ kind: 'reasoning', data: block })
      }
      pushTimeline('Reasoning update', text.slice(0, 120), 'running')
      break
    }
    case 'tool.started': {
      const turn = assistantTurn(next, taskId, event.created_at)
      closeTextBlock(turn)
      const tool: ToolBlockState = {
        id: String(payload.toolcall_id || event.id),
        name: String(payload.tool_name || payload.name || 'tool'),
        state: 'running',
        args: typeof payload.args === 'string' ? payload.args : undefined,
        startedAt: event.created_at,
      }
      next.tools.push(tool)
      turn.tools.push(tool)
      turn.blocks.push({ kind: 'tool', data: tool })
      pushTimeline(`Tool started: ${tool.name}`, tool.args, 'running')
      break
    }
    case 'tool.completed': {
      const tcid = String(payload.toolcall_id || '')
      const name = String(payload.tool_name || payload.name || 'tool')
      const result = String(payload.result || '')
      const endState = toolStateFromCompletion(result, payload.state)
      const update = (t: ToolBlockState) => (tcid && t.id === tcid) || (!tcid && t.name === name && t.state === 'running')
        ? { ...t, state: endState, result }
        : t
      next.tools = next.tools.map(update)
      next.turns = next.turns.map((turn) => ({ ...turn, tools: turn.tools.map(update), blocks: turn.blocks.map(b => b.kind === 'tool' ? { ...b, data: update(b.data) } : b) }))
      pushTimeline(
        endState === 'rejected' ? `Tool rejected: ${name}` : `Tool completed: ${name}`,
        result,
        endState,
      )
      break
    }
    case 'tool.error':
      pushTimeline(`Tool error: ${String(payload.tool_name || 'tool')}`, String(payload.error || ''), 'error')
      break
    case 'interaction.requested': {
      const turn = assistantTurn(next, taskId, event.created_at)
      const iid = String(payload.id || payload.interaction_id || event.id)
      const block: InteractionBlockState = {
        id: iid,
        interaction_type: (payload.interaction_type || 'approval') as 'approval' | 'input_request',
        title: String(payload.title || ''),
        message: String(payload.message || ''),
        status: 'pending',
        files: payload.files as InteractionBlockState['files'],
        fields: payload.fields as InteractionBlockState['fields'],
        createdAt: event.created_at,
      }
      turn.blocks.push({ kind: 'interaction', data: block })
      pushTimeline(`Interaction: ${payload.title || payload.interaction_type}`, undefined, 'pending')
      break
    }
    case 'interaction.approved':
    case 'interaction.rejected':
    case 'interaction.responded': {
      const iid = String(payload.id || payload.interaction_id || '')
      const newStatus = event.event_type === 'interaction.approved' ? 'approved'
        : event.event_type === 'interaction.rejected' ? 'rejected' : 'responded'
      const response = (payload.response || {}) as Record<string, any>
      let matched = false
      next.turns = next.turns.map((turn) => ({
        ...turn,
        blocks: turn.blocks.map(b => {
          if (b.kind === 'interaction' && b.data.id === iid) {
            matched = true
            return {
              ...b,
              data: {
                ...b.data,
                status: newStatus,
                response,
                files: (payload.files as InteractionBlockState['files']) || b.data.files,
                title: String(payload.title || b.data.title),
                message: String(payload.message || b.data.message),
              } as InteractionBlockState,
            }
          }
          return b
        }),
      }))
      if (!matched && iid) {
        const turn = assistantTurn(next, taskId, event.created_at)
        const block: InteractionBlockState = {
          id: iid,
          interaction_type: (payload.interaction_type || 'approval') as 'approval' | 'input_request',
          title: String(payload.title || ''),
          message: String(payload.message || ''),
          status: newStatus,
          files: payload.files as InteractionBlockState['files'],
          fields: payload.fields as InteractionBlockState['fields'],
          response,
          createdAt: event.created_at,
        }
        turn.blocks.push({ kind: 'interaction', data: block })
      }
      pushTimeline(`Interaction ${newStatus}`, iid, newStatus)
      break
    }
    default:
      pushTimeline(event.event_type, JSON.stringify(payload).slice(0, 180), String(payload.state || ''))
  }

  return next
}

/** Merge saved assistant message text when event replay missed deltas (e.g. event limit). */
function mergeAssistantMessagesFromDb(state: TerminalRuntimeState, messages: Message[]) {
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.content?.trim()) continue
    let turn = state.turns.find((t) => t.role === 'assistant' && t.taskId === m.task_id)
    if (!turn) {
      turn = {
        id: m.id,
        role: 'assistant',
        content: m.content,
        taskId: m.task_id,
        createdAt: m.created_at,
        partial: Boolean(m.partial),
        stopped: Boolean(m.stopped),
        reasoning: [],
        tools: [],
        blocks: [{ kind: 'text', data: { id: `text-${m.id}`, text: m.content } }],
      }
      state.turns.push(turn)
      continue
    }
    const textFromBlocks = turn.blocks
      .filter((b): b is { kind: 'text'; data: TextBlockState } => b.kind === 'text')
      .map((b) => b.data.text)
      .join('')
    if (m.content.length > textFromBlocks.length + 20) {
      turn.content = m.content
      const nonText = turn.blocks.filter((b) => b.kind !== 'text')
      turn.blocks = [{ kind: 'text', data: { id: `text-${m.id}`, text: m.content } }, ...nonText]
    }
    if (turn.createdAt == null && m.created_at) {
      const userForTask = state.turns.find((t) => t.role === 'user' && t.taskId === m.task_id)
      turn.createdAt = userForTask?.createdAt != null ? userForTask.createdAt + 1 : m.created_at
    }
  }
}

export function rebuildTerminalState(messages: Message[], events: SessionEvent[], activeTask?: Task | null) {
  const sorted = [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))
  let state: TerminalRuntimeState = { turns: [], timeline: [], tools: [], lastSeq: 0 }

  for (const evt of sorted) {
    state = applyEvent(state, evt, { appendAssistantDelta: true, ignoreSeqGuard: true })
  }

  for (const m of messages) {
    if (m.role !== 'user') continue
    const exists = state.turns.some((t) => t.id === m.id)
    if (!exists) {
      state.turns.push({
        id: m.id,
        role: 'user',
        content: m.content,
        taskId: m.task_id,
        createdAt: m.created_at,
        reasoning: [],
        tools: [],
        blocks: [],
      })
    }
  }

  mergeAssistantMessagesFromDb(state, messages)

  state.turns = sortTurnsChronologically(state.turns)

  if (activeTask) {
    state.activeTaskId = activeTask.id
    state.taskState = activeTask.state
  }
  return state
}

/** Attach server-rehydrated pending interactions (survives reload when in-memory gate was lost). */
export function mergePendingInteractions(
  state: TerminalRuntimeState,
  pending: Record<string, unknown>[],
): TerminalRuntimeState {
  if (!pending.length) return state
  const turns = state.turns.map((t) => ({ ...t, blocks: [...t.blocks] }))
  let changed = false

  for (const raw of pending) {
    const iid = String(raw.id || raw.interaction_id || '')
    if (!iid) continue
    const taskId = String(raw.task_id || '') || null
    let turn = taskId ? turns.find((t) => t.role === 'assistant' && t.taskId === taskId) : undefined
    if (!turn) {
      turn = {
        id: `assistant-${taskId || iid}`,
        role: 'assistant',
        taskId,
        content: '',
        reasoning: [],
        tools: [],
        blocks: [],
        createdAt: Number(raw.created_at) || undefined,
      }
      turns.push(turn)
      changed = true
    }
    if (turn.blocks.some((b) => b.kind === 'interaction' && b.data.id === iid)) continue
    turn.blocks.push({
      kind: 'interaction',
      data: {
        id: iid,
        interaction_type: (raw.interaction_type as 'approval' | 'input_request') || 'approval',
        title: String(raw.title || ''),
        message: String(raw.message || ''),
        status: 'pending',
        files: raw.files as InteractionBlockState['files'],
        fields: raw.fields as InteractionBlockState['fields'],
        createdAt: Number(raw.created_at) || undefined,
      },
    })
    changed = true
  }

  if (!changed) return state
  return { ...state, turns: sortTurnsChronologically(turns) }
}
