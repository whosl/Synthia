import { describe, expect, it } from 'vitest'
import { groupChatEntries, partitionRunGroupMembers } from './chatGrouping'
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
})
