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

/**
 * Find or create an assistant turn keyed by taskId.
 * Strict matching: only reuse if taskId matches exactly.
 */
const assistantTurn = (state: TerminalRuntimeState, taskId?: string | null) => {
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

/** Mark the latest reasoning block as done (if any is still running). */
const closeReasoningBlock = (turn: TerminalTurn) => {
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    if (turn.blocks[i].kind === 'reasoning' && turn.blocks[i].data && (turn.blocks[i].data as ReasoningBlockState).state === 'running') {
      ;(turn.blocks[i].data as ReasoningBlockState).state = 'done'
      break
    }
  }
}

export function stateFromMessages(messages: Message[]): TerminalRuntimeState {
  return {
    turns: messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
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

  const pushTimeline = (title: string, detail?: string, tState?: string) => {
    next.timeline.push({ id: event.id, seq: event.seq, type: event.event_type, title, detail, state: tState, createdAt: event.created_at })
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
          blocks: text ? [{ kind: 'text', data: { id: `text-${event.id}`, text } }] : [],
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
        closeReasoningBlock(turn)
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
      closeReasoningBlock(turn)
      if (text && !turn.content) {
        const tb = ensureTextBlock(turn)
        tb.text = text
        turn.content = text
      }
      pushTimeline('Assistant response completed', (text || turn.content || '').slice(0, 80), 'done')
      break
    }
    case 'message.assistant.stopped': {
      const turn = assistantTurn(next, taskId)
      turn.partial = true
      turn.stopped = true
      closeReasoningBlock(turn)
      if (text && !turn.content) {
        const tb = ensureTextBlock(turn)
        tb.text = text
        turn.content = text
      }
      pushTimeline('Assistant response stopped', undefined, 'stopped')
      break
    }
    case 'reasoning.delta': {
      const turn = assistantTurn(next, taskId)
      const lastBlock = turn.blocks[turn.blocks.length - 1]
      if (lastBlock && lastBlock.kind === 'reasoning' && lastBlock.data.state === 'running') {
        lastBlock.data.text += text
      } else {
        const block: ReasoningBlockState = { id: `reason-${event.id}`, text, state: 'running', startedAt: event.created_at }
        turn.reasoning.push(block)
        turn.blocks.push({ kind: 'reasoning', data: block })
      }
      break
    }
    case 'reasoning.summary': {
      const turn = assistantTurn(next, taskId)
      closeReasoningBlock(turn)
      pushTimeline('Reasoning completed', text.slice(0, 120), 'done')
      break
    }
    case 'tool.started': {
      const turn = assistantTurn(next, taskId)
      closeReasoningBlock(turn)
      const tool: ToolBlockState = {
        id: String(payload.toolcall_id || event.id),
        name: String(payload.tool_name || payload.name || 'tool'),
        state: 'running',
        args: typeof payload.args === 'string' ? payload.args : (payload.args ? JSON.stringify(payload.args) : undefined),
        startedAt: event.created_at,
      }
      next.tools.push(tool)
      turn.tools.push(tool)
      turn.blocks.push({ kind: 'tool', data: tool })
      pushTimeline(`Tool: ${tool.name}`, tool.args?.slice(0, 80), 'running')
      break
    }
    case 'tool.completed': {
      const tcid = String(payload.toolcall_id || '')
      const name = String(payload.tool_name || payload.name || 'tool')
      const elapsed = payload.elapsed_ms as number | undefined
      const update = (t: ToolBlockState): ToolBlockState => {
        if (tcid && t.id === tcid) return { ...t, state: 'completed', result: String(payload.result || ''), elapsedMs: elapsed }
        if (!tcid && t.name === name && t.state === 'running') return { ...t, state: 'completed', result: String(payload.result || ''), elapsedMs: elapsed }
        return t
      }
      next.tools = next.tools.map(update)
      next.turns = next.turns.map((turn) => ({
        ...turn,
        tools: turn.tools.map(update),
        blocks: turn.blocks.map(b => b.kind === 'tool' ? { ...b, data: update(b.data) } : b)
      }))
      pushTimeline(`Tool done: ${name}`, String(payload.result || '').slice(0, 80), 'completed')
      break
    }
    case 'tool.error': {
      const tcid = String(payload.toolcall_id || '')
      const name = String(payload.tool_name || payload.name || 'tool')
      const errorText = String(payload.error || payload.message || '')
      const update = (t: ToolBlockState): ToolBlockState => {
        if (tcid && t.id === tcid) return { ...t, state: 'error', error: errorText }
        if (!tcid && t.name === name && t.state === 'running') return { ...t, state: 'error', error: errorText }
        return t
      }
      next.tools = next.tools.map(update)
      next.turns = next.turns.map((turn) => ({
        ...turn,
        tools: turn.tools.map(update),
        blocks: turn.blocks.map(b => b.kind === 'tool' ? { ...b, data: update(b.data) } : b)
      }))
      pushTimeline(`Tool error: ${name}`, errorText.slice(0, 120), 'error')
      break
    }
    case 'run.started':
    case 'run.completed':
    case 'run.error':
      pushTimeline(event.event_type, String(payload.name || payload.run_type || ''), String(payload.state || ''))
      break
    case 'memory.updated':
      pushTimeline('Memory updated', String(payload.summary || '').slice(0, 80))
      break
    case 'problem.detected':
      pushTimeline('Problem detected', String(payload.message || payload.signature || '').slice(0, 120), 'error')
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
  let state = stateFromMessages(
    messages.filter((m) => !(m.role === 'assistant' && m.task_id && replayableAssistantTasks.has(m.task_id))),
  )
  for (const evt of events) {
    state = applyEvent(state, evt, { appendAssistantDelta: true })
  }
  if (activeTask) {
    state.activeTaskId = activeTask.id
    state.taskState = activeTask.state
  }
  return state
}
