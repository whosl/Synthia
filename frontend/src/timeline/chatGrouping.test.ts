import { describe, expect, it } from 'vitest'
import {
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
): TimelineEntry {
  return { key, id: key, seq, kind, taskId: null, createdAt: seq, payload }
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

  it('routes pending approvals to the dock instead of inline chat', () => {
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
    expect(filterInlineChatEntries(all).map((e) => e.key)).toEqual(['interaction:done', 'tool:t1'])

    const items = groupChatEntries(all)
    expect(items.some((i) => i.type === 'entry' && i.entry.key === pending.key)).toBe(false)
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('tool_group')
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
