import { describe, expect, it } from 'vitest'
import { groupChatEntries, isWorkPhaseComplete, partitionRunGroupMembers } from './chatGrouping'
import type { AssistantTextPayload } from './types'
import type { TimelineEntry } from './types'

function entry(
  key: string,
  kind: TimelineEntry['kind'],
  payload: TimelineEntry['payload'],
): TimelineEntry {
  return { key, id: key, seq: 1, kind, taskId: null, createdAt: 1, payload }
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

  it('wraps middle blocks in work group only after final assistant completes', () => {
    const work = [
      entry('reason:1', 'reasoning', { text: 'thinking', state: 'done' }),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'completed' }),
    ]
    const final = entry('text:final', 'assistant_text', {
      streamId: 's1',
      text: 'All done',
      partial: false,
    } satisfies AssistantTextPayload)
    expect(isWorkPhaseComplete(work, final)).toBe(true)

    const items = groupChatEntries([
      entry('user:1', 'user', { text: 'hi', messageId: 'm1' }),
      ...work,
      final,
    ])
    expect(items).toHaveLength(3)
    expect(items[0]?.type).toBe('entry')
    expect(items[1]?.type).toBe('work_group')
    expect(items[2]?.type).toBe('entry')
    if (items[1]?.type === 'work_group') {
      expect(items[1].members).toHaveLength(2)
    }
  })

  it('shows flat tool batches while turn is still running', () => {
    const items = groupChatEntries([
      entry('user:1', 'user', { text: 'go', messageId: 'm1' }),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'running' }),
    ])
    expect(items).toHaveLength(2)
    expect(items[1]?.type).toBe('tool_group')
    expect(items.some((i) => i.type === 'work_group')).toBe(false)
  })

  it('starts a new tool group after a pending approval', () => {
    const items = groupChatEntries([
      entry('interaction:done', 'interaction', {
        interaction_type: 'approval',
        title: 'First',
        message: '',
        status: 'approved',
      }),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'completed' }),
      entry('interaction:wait', 'interaction', {
        interaction_type: 'approval',
        title: 'Second',
        message: '',
        status: 'pending',
      }),
    ])
    expect(items).toHaveLength(2)
    expect(items[0]?.type).toBe('tool_group')
    expect(items[1]?.type).toBe('entry')
    if (items[0]?.type === 'tool_group') {
      expect(items[0].members).toHaveLength(2)
    }
    if (items[1]?.type === 'entry') {
      expect(items[1].entry.kind).toBe('interaction')
    }
  })

  it('does not show work group while an interaction is still pending', () => {
    const work = [
      entry('interaction:a', 'interaction', {
        interaction_type: 'approval',
        title: 'Approve patch',
        message: '',
        status: 'pending',
      }),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'completed' }),
    ]
    const final = entry('text:final', 'assistant_text', {
      streamId: 's1',
      text: 'Done',
      partial: false,
    } satisfies AssistantTextPayload)
    expect(isWorkPhaseComplete(work, final)).toBe(false)

    const items = groupChatEntries([
      entry('user:1', 'user', { text: 'hi', messageId: 'm1' }),
      ...work,
      final,
    ])
    expect(items.some((i) => i.type === 'work_group')).toBe(false)
  })

  it('shows flat work items while final assistant is still streaming', () => {
    const items = groupChatEntries([
      entry('user:1', 'user', { text: 'go', messageId: 'm1' }),
      entry('tool:t1', 'tool', { toolcallId: 't1', name: 'grep_tool', state: 'completed' }),
      entry('text:partial', 'assistant_text', { streamId: 's1', text: 'Typing…', partial: true }),
    ])
    expect(items.some((i) => i.type === 'work_group')).toBe(false)
    expect(items.filter((i) => i.type === 'entry')).toHaveLength(2)
  })
})
