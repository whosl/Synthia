import { describe, expect, it } from 'vitest'
import {
  buildTranscriptDisplayItems,
  buildTranscriptTurns,
  collectPendingApprovalEntries,
  filterInlineChatEntries,
  groupChatEntries,
  partitionRunGroupMembers,
} from './chatGrouping'
import type { AssistantTextPayload } from './types'
import type { TimelineEntry } from './types'

function entry(
  key: string,
  kind: TimelineEntry['kind'],
  payload: TimelineEntry['payload'],
  seq = 1,
  taskId: string | null = null,
): TimelineEntry {
  return { key, id: key, seq, kind, taskId, createdAt: seq, payload }
}

function displayKeys(items: ReturnType<typeof groupChatEntries>): string[] {
  return items.map((item) => {
    if (item.type === 'entry') return item.entry.key
    return item.key
  })
}

describe('groupChatEntries', () => {
  it('groups adjacent approval then tool into one run group', () => {
    const items = groupChatEntries([
      entry('interaction:a', 'interaction', {
        interaction_type: 'approval',
        title: 'Run Vivado',
        message: '',
        status: 'approved',
      }),
      entry('tool:t1', 'tool', {
        toolcallId: 't1',
        name: 'run_vivado_script_tool',
        state: 'completed',
      }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('tool_group')
    if (items[0]?.type === 'tool_group') {
      expect(items[0].members).toHaveLength(2)
      const { approvals, tools } = partitionRunGroupMembers(items[0].members)
      expect(approvals).toHaveLength(1)
      expect(tools).toHaveLength(1)
    }
  })

  it('does not group approval separated by assistant text', () => {
    const items = groupChatEntries([
      entry('interaction:a', 'interaction', {
        interaction_type: 'approval',
        title: 'A',
        message: '',
        status: 'approved',
      }),
      entry('text:1', 'assistant_text', { streamId: 's', text: 'hello' }),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep', state: 'completed' }),
    ])
    expect(items).toHaveLength(3)
    expect(items[0]?.type).toBe('tool_group')
    expect(items[1]?.type).toBe('entry')
    expect(items[2]?.type).toBe('tool_group')
    if (items[0]?.type === 'tool_group') {
      expect(partitionRunGroupMembers(items[0].members).tools).toHaveLength(0)
    }
  })

  it('preserves event order without moving final assistant to the end', () => {
    const items = groupChatEntries([
      entry('user:1', 'user', { text: 'hi', messageId: 'm1' }, 1),
      entry('text:mid', 'assistant_text', { streamId: 's1', text: 'Working…', partial: false }, 2),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'completed' }, 3),
      entry('text:final', 'assistant_text', {
        streamId: 's2',
        text: 'All done',
        partial: false,
      } satisfies AssistantTextPayload, 4),
    ])
    expect(displayKeys(items)).toEqual([
      'user:1',
      'text:mid',
      'tool-group:tool:t1',
      'text:final',
    ])
  })

  it('keeps assistant text before tools when events arrive in that order', () => {
    const items = groupChatEntries([
      entry('user:1', 'user', { text: 'go', messageId: 'm1' }, 1),
      entry('text:first', 'assistant_text', { streamId: 's1', text: 'Let me check', partial: false }, 2),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'completed' }, 3),
    ])
    expect(displayKeys(items)).toEqual(['user:1', 'text:first', 'tool-group:tool:t1'])
  })

  it('shows flat tool batches while turn is still running', () => {
    const items = groupChatEntries([
      entry('user:1', 'user', { text: 'go', messageId: 'm1' }),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'running' }),
    ])
    expect(items).toHaveLength(2)
    expect(items[1]?.type).toBe('tool_group')
  })

  it('keeps pending approvals inline while also collecting them for the dock', () => {
    const pending = entry('interaction:wait', 'interaction', {
      interaction_type: 'approval',
      title: 'Second',
      message: '',
      status: 'pending',
    }, 30)
    const all = [
      entry('interaction:done', 'interaction', {
        interaction_type: 'approval',
        title: 'First',
        message: '',
        status: 'approved',
      }, 10),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'completed' }, 20),
      pending,
    ]
    expect(collectPendingApprovalEntries(all)).toEqual([pending])
    expect(filterInlineChatEntries(all).map((e) => e.key)).toEqual(['interaction:done', 'tool:t1', 'interaction:wait'])

    const items = groupChatEntries(all)
    expect(items.some((i) => i.type === 'entry' && i.entry.key === pending.key)).toBe(true)
    expect(items).toHaveLength(2)
    expect(items[0]?.type).toBe('tool_group')
  })

  it('groups entries by task id under the owning user turn', () => {
    const items = groupChatEntries([
      entry('user:a', 'user', { text: 'first', messageId: 'a' }, 1, 'task-a'),
      entry('user:b', 'user', { text: 'second', messageId: 'b' }, 2, 'task-b'),
      entry('tool:a', 'tool', { toolcallId: 'a', name: 'grep_tool', state: 'completed' }, 3, 'task-a'),
      entry('text:b', 'assistant_text', { streamId: 'b', text: 'done' }, 4, 'task-b'),
    ])
    expect(displayKeys(items)).toEqual([
      'user:a',
      'tool-group:tool:a',
      'user:b',
      'text:b',
    ])
  })

  it('shows assistant entries in timeline order while streaming', () => {
    const items = groupChatEntries([
      entry('user:1', 'user', { text: 'go', messageId: 'm1' }, 1),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'completed' }, 2),
      entry('text:partial', 'assistant_text', { streamId: 's1', text: 'Typing…', partial: true }, 3),
    ])
    expect(displayKeys(items)).toEqual(['user:1', 'tool-group:tool:t1', 'text:partial'])
  })
})

describe('buildTranscriptTurns', () => {
  function summarize(blocks: ReturnType<typeof buildTranscriptDisplayItems>): string[] {
    return blocks.map((block) => {
      if (block.type === 'orphan') {
        return `orphan:${block.items.map((item) => item.key).join(',')}`
      }
      return `turn:${block.turn.user.key}:${block.items.map((item) => item.key).join(',')}`
    })
  }

  it('projects interleaved task entries under their owning user turns', () => {
    const blocks = buildTranscriptDisplayItems([
      entry('user:a', 'user', { text: 'first', messageId: 'a' }, 1, 'task-a'),
      entry('user:b', 'user', { text: 'second', messageId: 'b' }, 2, 'task-b'),
      entry('tool:a', 'tool', { toolcallId: 'a', name: 'grep_tool', state: 'completed' }, 3, 'task-a'),
      entry('text:b', 'assistant_text', { streamId: 'b', text: 'done' }, 4, 'task-b'),
    ])
    expect(summarize(blocks)).toEqual([
      'turn:user:a:tool-group:tool:a',
      'turn:user:b:text:b',
    ])
  })

  it('keeps task entries that arrive before the owning user in that turn', () => {
    const blocks = buildTranscriptDisplayItems([
      entry('tool:a', 'tool', { toolcallId: 'a', name: 'grep_tool', state: 'completed' }, 1, 'task-a'),
      entry('user:a', 'user', { text: 'first', messageId: 'a' }, 2, 'task-a'),
    ])
    expect(summarize(blocks)).toEqual(['turn:user:a:tool-group:tool:a'])
  })

  it('emits orphan groups for task entries without an owning user', () => {
    const blocks = buildTranscriptDisplayItems([
      entry('tool:a', 'tool', { toolcallId: 'a', name: 'grep_tool', state: 'completed' }, 1, 'task-a'),
      entry('text:x', 'assistant_text', { streamId: 'x', text: 'orphan' }, 2, null),
    ])
    expect(summarize(blocks)).toEqual(['orphan:tool-group:tool:a,text:x'])
  })

  it('keeps pending approvals inline and resolved approvals grouped with following tools', () => {
    const pending = entry('interaction:pending', 'interaction', {
      interaction_type: 'approval',
      title: 'Pending',
      message: '',
      status: 'pending',
    }, 2, 'task-a')
    const blocks = buildTranscriptDisplayItems([
      entry('user:a', 'user', { text: 'go', messageId: 'a' }, 1, 'task-a'),
      pending,
      entry('interaction:approved', 'interaction', {
        interaction_type: 'approval',
        title: 'Approved',
        message: '',
        status: 'approved',
      }, 3, 'task-a'),
      entry('tool:a', 'tool', { toolcallId: 'a', name: 'run_tool', state: 'completed' }, 4, 'task-a'),
    ])
    expect(collectPendingApprovalEntries([pending])).toEqual([pending])
    expect(summarize(blocks)).toEqual([
      'turn:user:a:interaction:pending,tool-group:interaction:approved',
    ])
  })

  it('derives turn status from active, error, and stopped items', () => {
    const active = buildTranscriptTurns([
      entry('user:a', 'user', { text: 'go', messageId: 'a' }, 1, 'task-a'),
      entry('tool:a', 'tool', { toolcallId: 'a', name: 'run_tool', state: 'running' }, 2, 'task-a'),
    ], 'task-a', 'running')
    expect(active[0]).toMatchObject({ status: 'running' })

    const failed = buildTranscriptTurns([
      entry('user:a', 'user', { text: 'go', messageId: 'a' }, 1, 'task-a'),
      entry('error:a', 'error', { title: 'Task failed', message: 'boom' }, 2, 'task-a'),
    ])
    expect(failed[0]).toMatchObject({ status: 'error' })

    const stopped = buildTranscriptTurns([
      entry('user:a', 'user', { text: 'go', messageId: 'a' }, 1, 'task-a'),
      entry('tool:a', 'tool', { toolcallId: 'a', name: 'run_tool', state: 'stopped' }, 2, 'task-a'),
    ])
    expect(stopped[0]).toMatchObject({ status: 'stopped' })
  })

  it('suppresses duplicate run.error rows when a failed tool already provides the primary failure', () => {
    const blocks = buildTranscriptDisplayItems([
      entry('user:a', 'user', { text: 'go', messageId: 'a' }, 1, 'task-a'),
      entry('tool:a', 'tool', {
        toolcallId: 'a',
        name: 'run_vivado_synth_tool',
        state: 'error',
        error: 'failed',
      }, 2, 'task-a'),
      entry('error:run', 'error', {
        title: 'Run failed',
        message: 'failed',
        source: 'run.error',
      }, 3, 'task-a'),
      entry('error:task', 'error', {
        title: 'Task failed',
        message: 'task failed',
        source: 'task.error',
      }, 4, 'task-a'),
    ])

    expect(summarize(blocks)).toEqual([
      'turn:user:a:tool-group:tool:a,error:task',
    ])
  })
})
