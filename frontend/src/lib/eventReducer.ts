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
  state: 'running' | 'completed' | 'error'
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

export type TurnBlock =
  | { kind: 'text'; data: TextBlockState }
  | { kind: 'reasoning'; data: ReasoningBlockState }
  | { kind: 'tool'; data: ToolBlockState }

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

const assistantTurn = (state: TerminalRuntimeState, taskId?: string | null) => {
  // Find existing assistant turn for this task (preserves position in interleaved list)
  if (taskId) {
    const existing = state.turns.find((t) => t.role === 'assistant' && t.taskId === taskId)
    if (existing) return existing
  }
  const last = state.turns[state.turns.length - 1]
  if (last?.role === 'assistant' && last.taskId === taskId) return last
  const turn: TerminalTurn = { id: `assistant-${taskId || Date.now()}`, role: 'assistant', taskId, content: '', reasoning: [], tools: [], blocks: [] }
  state.turns.push(turn)
  return turn
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

export function applyEvent(state: TerminalRuntimeState, event: SessionEvent, options: { appendAssistantDelta?: boolean } = {}): TerminalRuntimeState {
  if (event.seq && event.seq <= state.lastSeq) return state
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
        next.turns.push({
          id: String(payload.message_id || event.id),
          role: 'user',
          content: text,
          taskId,
          createdAt: event.created_at,
          reasoning: [],
          tools: [],
          blocks: [],
        })
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
        const turn = assistantTurn(next, taskId)
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
      const turn = assistantTurn(next, taskId)
      turn.partial = false
      pushTimeline('Assistant response completed', String(payload.text || ''), 'done')
      break
    }
    case 'message.assistant.stopped': {
      const turn = assistantTurn(next, taskId)
      turn.partial = true
      turn.stopped = true
      pushTimeline('Assistant response stopped', undefined, 'stopped')
      break
    }
    case 'reasoning.delta': {
      const turn = assistantTurn(next, taskId)
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
      const turn = assistantTurn(next, taskId)
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
      const update = (t: ToolBlockState) => (tcid && t.id === tcid) || (!tcid && t.name === name && t.state === 'running')
        ? { ...t, state: 'completed' as const, result: String(payload.result || '') }
        : t
      next.tools = next.tools.map(update)
      next.turns = next.turns.map((turn) => ({ ...turn, tools: turn.tools.map(update), blocks: turn.blocks.map(b => b.kind === 'tool' ? { ...b, data: update(b.data) } : b) }))
      pushTimeline(`Tool completed: ${name}`, String(payload.result || ''), 'completed')
      break
    }
    case 'tool.error':
      pushTimeline(`Tool error: ${String(payload.tool_name || 'tool')}`, String(payload.error || ''), 'error')
      break
    default:
      pushTimeline(event.event_type, JSON.stringify(payload).slice(0, 180), String(payload.state || ''))
  }

  return next
}

export function rebuildTerminalState(messages: Message[], events: SessionEvent[], activeTask?: Task | null) {
  const replayableAssistantTasks = new Set(
    events
      .filter((evt) => evt.task_id && evt.event_type === 'message.assistant.delta')
      .map((evt) => evt.task_id),
  )
  // Keep all messages in order; clear blocks for those rebuilt from deltas
  let state = stateFromMessages(messages)
  state.turns = state.turns.map((turn) => {
    if (turn.role === 'assistant' && replayableAssistantTasks.has(turn.taskId || '')) {
      return { ...turn, content: '', blocks: [], reasoning: [], tools: [] }
    }
    return turn
  })
  for (const evt of events) {
    state = applyEvent(state, evt, { appendAssistantDelta: true })
  }
  if (activeTask) {
    state.activeTaskId = activeTask.id
    state.taskState = activeTask.state
  }
  return state
}
