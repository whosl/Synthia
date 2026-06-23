import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../api/types'
import {
  applyOptimisticUser,
  applyTimelineEvent,
  ensureEmptyTurnPlaceholders,
  getChatEntries,
  mergeAssistantMessagesFromDb,
  rebuildTimelineFromTurns,
  rebuildTimelineFromSources,
  removeOptimisticUserEntries,
} from './reducer'
import { emptyTimelineState } from './types'

function evt(
  seq: number,
  event_type: string,
  payload: Record<string, unknown> = {},
  task_id = 'task-1',
): SessionEvent {
  return {
    id: `e-${seq}`,
    session_id: 's1',
    seq,
    event_type,
    task_id,
    payload,
    created_at: 1000 + seq,
  } as SessionEvent
}

describe('timeline reducer', () => {
  it('orders tool and assistant text by stream_id and seq', () => {
    const events = [
      evt(1, 'assistant.stream.opened', { stream_id: 'task-1-s0', segment_index: 0 }),
      evt(2, 'message.assistant.delta', { text: 'Hello', stream_id: 'task-1-s0' }),
      evt(3, 'assistant.stream.completed', { stream_id: 'task-1-s0' }),
      evt(4, 'assistant.stream.opened', { stream_id: 'task-1-s1', segment_index: 1 }),
      evt(5, 'tool.started', { toolcall_id: 'tc1', tool_name: 'grep_tool', args: '{}' }),
      evt(6, 'message.assistant.delta', { text: 'After tool', stream_id: 'task-1-s1' }),
    ]
    const state = rebuildTimelineFromSources(events, [], [])
    const entries = getChatEntries(state)
    expect(entries.map((e) => e.kind)).toEqual(['assistant_text', 'tool', 'assistant_text'])
    expect((entries[0].payload as { text: string }).text).toBe('Hello')
    expect((entries[2].payload as { text: string }).text).toBe('After tool')
  })

  it('prefers event stream over DB when DB text is not longer', () => {
    const events = [
      evt(1, 'assistant.stream.opened', { stream_id: 'task-1-s0' }),
      evt(2, 'message.assistant.delta', { text: 'Short plus entire task monologue repeated again', stream_id: 'task-1-s0' }),
      evt(3, 'assistant.stream.completed', { stream_id: 'task-1-s0' }),
      evt(4, 'message.assistant.completed', { stream_id: 'task-1-s0' }),
    ]
    const messages = [{
      id: 'm1',
      role: 'assistant' as const,
      content: 'Short',
      task_id: 'task-1',
      created_at: 99,
    }]
    const state = rebuildTimelineFromSources(events, messages as any, [])
    const texts = getChatEntries(state)
      .filter((e) => e.kind === 'assistant_text')
      .map((e) => (e.payload as { text: string }).text)
    expect(texts).toEqual(['Short plus entire task monologue repeated again'])
  })

  it('backfills assistant text from DB when events are missing', () => {
    const messages = [{
      id: 'm1',
      role: 'assistant' as const,
      content: 'Recovered from messages table',
      task_id: 'task-1',
      created_at: 200,
    }]
    const state = rebuildTimelineFromSources([], messages as any, [])
    const assistant = getChatEntries(state).find((e) => e.kind === 'assistant_text')
    expect((assistant!.payload as { text: string }).text).toBe('Recovered from messages table')
  })

  it('places DB assistant backfill inside turn not at timeline end', () => {
    const events = [
      evt(10, 'message.user.created', { message_id: 'u1', text: 'q1' }, 'task-a'),
      evt(20, 'tool.started', { toolcall_id: 't1', tool_name: 'grep_tool' }, 'task-a'),
      evt(30, 'message.user.created', { message_id: 'u2', text: 'q2' }, 'task-b'),
    ]
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'q1', task_id: 'task-a', created_at: 10 },
      {
        id: 'a1',
        role: 'assistant' as const,
        content: 'Answer A from database',
        task_id: 'task-a',
        created_at: 9_999_999_999,
      },
      { id: 'u2', role: 'user' as const, content: 'q2', task_id: 'task-b', created_at: 30 },
    ]
    const state = rebuildTimelineFromSources(events, messages as any, [])
    const chat = getChatEntries(state)
    const assistantIdx = chat.findIndex((e) => e.kind === 'assistant_text')
    const secondUserIdx = chat.findIndex((e) => e.key === 'user:u2')
    expect(assistantIdx).toBeGreaterThan(-1)
    expect(assistantIdx).toBeLessThan(secondUserIdx)
    expect((chat[assistantIdx]!.payload as { text: string }).text).toBe('Answer A from database')
  })

  it('backfills longer DB text when event stream only has a short fragment', () => {
    const events = [
      evt(1, 'message.user.created', { message_id: 'u1', text: 'go' }),
      evt(2, 'assistant.stream.opened', { stream_id: 'task-1-s0' }),
      evt(3, 'message.assistant.delta', { text: 'Hi', stream_id: 'task-1-s0' }),
      evt(4, 'assistant.stream.completed', { stream_id: 'task-1-s0' }),
      evt(5, 'message.assistant.completed', { stream_id: 'task-1-s0' }),
    ]
    const messages = [{
      id: 'a1',
      role: 'assistant' as const,
      content: 'Hi — plus the full detailed conclusion that was truncated from events',
      task_id: 'task-1',
      created_at: 50,
    }]
    const state = rebuildTimelineFromSources(events, messages as any, [])
    const assistants = getChatEntries(state).filter((e) => e.kind === 'assistant_text')
    expect(assistants).toHaveLength(1)
    expect((assistants[0]!.payload as { text: string }).text).toContain('truncated from events')
  })

  it('skips empty-turn placeholder while task is still active', () => {
    let state = emptyTimelineState()
    state = applyTimelineEvent(state, evt(1, 'message.user.created', { message_id: 'u1', text: 'run' }), {
      ignoreSeqGuard: true,
    })
    state = applyTimelineEvent(state, evt(2, 'tool.started', { toolcall_id: 'tc1', tool_name: 'grep_tool' }))
    state = ensureEmptyTurnPlaceholders(state, 'task-1')
    expect(getChatEntries(state).some((e) => e.kind === 'assistant_text')).toBe(false)
  })

  it('injects empty-turn placeholder for legacy tool-only turns', () => {
    let state = emptyTimelineState()
    state = applyTimelineEvent(state, evt(1, 'message.user.created', { message_id: 'u1', text: 'run synth' }), {
      ignoreSeqGuard: true,
    })
    state = applyTimelineEvent(state, evt(2, 'tool.started', { toolcall_id: 'tc1', tool_name: 'grep_tool' }))
    state = applyTimelineEvent(state, evt(3, 'tool.completed', { toolcall_id: 'tc1', tool_name: 'grep_tool', result: 'ok' }))
    state = applyTimelineEvent(state, evt(4, 'task.done', { task_id: 'task-1' }))
    state = ensureEmptyTurnPlaceholders(state)
    const assistant = getChatEntries(state).find((e) => e.kind === 'assistant_text')
    expect((assistant!.payload as { emptyTurn?: boolean }).emptyTurn).toBe(true)
  })

  it('creates empty assistant entry on message.assistant.completed with empty flag', () => {
    let state = emptyTimelineState()
    state = applyTimelineEvent(state, evt(1, 'assistant.stream.opened', { stream_id: 'task-1-s0' }))
    state = applyTimelineEvent(state, evt(2, 'message.assistant.completed', { stream_id: 'task-1-s0', empty: true }))
    const assistant = getChatEntries(state).find((e) => e.kind === 'assistant_text')
    expect((assistant!.payload as { emptyTurn?: boolean }).emptyTurn).toBe(true)
  })

  it('removes optimistic user entries', () => {
    let state = applyOptimisticUser(emptyTimelineState(), 'hi')
    expect(getChatEntries(state).some((e) => e.key.startsWith('optimistic-user:'))).toBe(true)
    state = removeOptimisticUserEntries(state)
    expect(getChatEntries(state).some((e) => e.key.startsWith('optimistic-user:'))).toBe(false)
  })

  it('replaces optimistic user with server message', () => {
    let state = applyOptimisticUser(emptyTimelineState(), 'hi')
    expect(getChatEntries(state).some((e) => e.key.startsWith('optimistic-user:'))).toBe(true)
    state = applyTimelineEvent(state, evt(10, 'message.user.created', { message_id: 'm1', text: 'hi' }), {
      ignoreSeqGuard: true,
    })
    const users = getChatEntries(state).filter((e) => e.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0].key).toBe('user:m1')
  })

  it('creates tool entry on completed without prior started (reject-only)', () => {
    let state = emptyTimelineState()
    state = applyTimelineEvent(state, evt(1, 'tool.completed', {
      toolcall_id: 'tc0',
      tool_name: 'run_vivado_synth_tool',
      state: 'rejected',
      result: '{"edagent_outcome":"user_rejected"}',
      elapsed_ms: 5,
      started_at: 1000,
    }))
    const tool = getChatEntries(state).find((e) => e.kind === 'tool')
    expect((tool!.payload as { state: string }).state).toBe('rejected')
  })

  it('does not reset tool to running after rejected completed', () => {
    let state = emptyTimelineState()
    state = applyTimelineEvent(state, evt(1, 'tool.started', {
      toolcall_id: 'tc1',
      tool_name: 'run_vivado_synth_tool',
      started_at: 1000,
    }))
    state = applyTimelineEvent(state, evt(2, 'tool.completed', {
      toolcall_id: 'tc1',
      tool_name: 'run_vivado_synth_tool',
      state: 'rejected',
      result: '{"edagent_outcome":"user_rejected"}',
      elapsed_ms: 12,
    }))
    state = applyTimelineEvent(state, evt(3, 'tool.started', {
      toolcall_id: 'tc1',
      tool_name: 'run_vivado_synth_tool',
      started_at: 1001,
    }))
    const tool = getChatEntries(state).find((e) => e.kind === 'tool')
    expect(tool).toBeDefined()
    expect((tool!.payload as { state: string }).state).toBe('rejected')
    expect((tool!.payload as { elapsedMs?: number }).elapsedMs).toBe(12)
  })

  it('legacy replay without stream_id uses segment counter on tool.started', () => {
    let state = emptyTimelineState()
    state = applyTimelineEvent(state, evt(1, 'message.assistant.delta', { text: 'A' }), { appendAssistantDelta: true })
    state = applyTimelineEvent(state, evt(2, 'tool.started', { toolcall_id: 't1', tool_name: 'grep_tool' }))
    state = applyTimelineEvent(state, evt(3, 'message.assistant.delta', { text: 'B' }), { appendAssistantDelta: true })
    const texts = getChatEntries(state)
      .filter((e) => e.kind === 'assistant_text')
      .map((e) => (e.payload as { text: string }).text)
    expect(texts).toEqual(['A', 'B'])
  })

  it('rebuilds chat entries from turns API rows as the primary transcript source', () => {
    const state = rebuildTimelineFromTurns([
      {
        id: 'turn-1',
        session_id: 's1',
        task_id: 'task-a',
        user_message_id: 'u1',
        status: 'done',
        started_at: 1,
        updated_at: 5,
        items: [
          {
            id: 'ti-user',
            turn_id: 'turn-1',
            session_id: 's1',
            task_id: 'task-a',
            item_key: 'user:u1',
            item_type: 'user',
            status: 'completed',
            seq: 1,
            created_at: 1,
            payload: { text: 'run', message_id: 'u1' },
          },
          {
            id: 'ti-assistant',
            turn_id: 'turn-1',
            session_id: 's1',
            task_id: 'task-a',
            item_key: 'assistant:task-a-s0',
            item_type: 'assistant_text',
            status: 'completed',
            seq: 2,
            created_at: 2,
            stream_id: 'task-a-s0',
            payload: { stream_id: 'task-a-s0', text: 'done', partial: false },
          },
          {
            id: 'ti-tool',
            turn_id: 'turn-1',
            session_id: 's1',
            task_id: 'task-a',
            item_key: 'tool:tc1',
            item_type: 'tool',
            status: 'completed',
            seq: 3,
            created_at: 3,
            tool_call_id: 'tc1',
            payload: { toolcall_id: 'tc1', tool_name: 'grep_tool', state: 'completed', result: 'ok' },
          },
        ],
      },
    ], [], null, 99)

    const chat = getChatEntries(state)
    expect(chat.map((entry) => entry.key)).toEqual(['user:u1', 'assistant:task-a-s0', 'tool:tc1'])
    expect(chat.every((entry) => entry.taskId === 'task-a')).toBe(true)
    expect(state.lastSeq).toBe(99)
    expect(state.tools).toHaveLength(1)
    expect(state.tools[0].name).toBe('grep_tool')
  })

  it('merges pending interactions onto turns API transcript rows', () => {
    const state = rebuildTimelineFromTurns([
      {
        id: 'turn-1',
        session_id: 's1',
        task_id: 'task-a',
        user_message_id: 'u1',
        status: 'running',
        started_at: 1,
        updated_at: 1,
        items: [
          {
            id: 'ti-user',
            turn_id: 'turn-1',
            session_id: 's1',
            task_id: 'task-a',
            item_key: 'user:u1',
            item_type: 'user',
            status: 'completed',
            seq: 1,
            created_at: 1,
            payload_json: '{"text":"approve?","message_id":"u1"}',
          },
        ],
      },
    ], [{
      id: 'ia1',
      task_id: 'task-a',
      interaction_type: 'approval',
      title: 'Run Vivado',
      message: 'Proceed',
      created_at: 2,
    }])

    const pending = getChatEntries(state).find((entry) => entry.key === 'interaction:ia1')
    expect(pending?.kind).toBe('interaction')
    expect(pending?.taskId).toBe('task-a')
    expect((pending?.payload as { status?: string }).status).toBe('pending')
  })

  it('filters completed empty assistant stream rows from turns unless explicitly marked empty', () => {
    const state = rebuildTimelineFromTurns([
      {
        id: 'turn-1',
        session_id: 's1',
        task_id: 'task-a',
        user_message_id: 'u1',
        status: 'done',
        started_at: 1,
        updated_at: 4,
        items: [
          {
            id: 'ti-user',
            turn_id: 'turn-1',
            session_id: 's1',
            task_id: 'task-a',
            item_key: 'user:u1',
            item_type: 'user',
            status: 'completed',
            seq: 1,
            created_at: 1,
            payload: { text: 'run', message_id: 'u1' },
          },
          {
            id: 'ti-empty',
            turn_id: 'turn-1',
            session_id: 's1',
            task_id: 'task-a',
            item_key: 'assistant:empty-stream',
            item_type: 'assistant_text',
            status: 'completed',
            seq: 2,
            created_at: 2,
            payload: { stream_id: 'empty-stream', text: '', partial: false, empty_turn: false },
          },
          {
            id: 'ti-explicit-empty',
            turn_id: 'turn-1',
            session_id: 's1',
            task_id: 'task-a',
            item_key: 'assistant:explicit-empty',
            item_type: 'assistant_text',
            status: 'completed',
            seq: 3,
            created_at: 3,
            payload: { stream_id: 'explicit-empty', text: '', partial: false, empty_turn: true },
          },
        ],
      },
    ])

    expect(getChatEntries(state).map((entry) => entry.key)).toEqual([
      'user:u1',
      'assistant:explicit-empty',
    ])
  })
})
