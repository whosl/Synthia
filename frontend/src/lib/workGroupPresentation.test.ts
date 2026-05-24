import { describe, expect, it } from 'vitest'
import {
  buildWorkGroupSummary,
  formatWorkGroupSummaryLine,
  formatWorkedDuration,
} from './workGroupPresentation'
import type { TimelineEntry } from '../timeline/types'

function toolEntry(id: string, state: 'completed' | 'running' = 'completed'): TimelineEntry {
  return {
    key: `tool:${id}`,
    id,
    seq: 1,
    kind: 'tool',
    taskId: 'task-1',
    createdAt: 100,
    payload: {
      toolcallId: id,
      name: 'grep_tool',
      state,
      elapsedMs: 2000,
      startedAtMs: 100_000,
    },
  }
}

describe('workGroupPresentation', () => {
  it('formats worked duration with minutes and seconds', () => {
    expect(formatWorkedDuration(45)).toBe('45 s')
    expect(formatWorkedDuration(75)).toBe('1 min 15 s')
    expect(formatWorkedDuration(120)).toBe('2 min')
  })

  it('formats summary line', () => {
    const line = formatWorkGroupSummaryLine({ elapsedSec: 90, toolCount: 3 })
    expect(line).toBe('worked for 1 min 30 s · 3 tools called')
  })

  it('counts tools in work members', () => {
    const summary = buildWorkGroupSummary([toolEntry('a'), toolEntry('b')], null)
    expect(summary.toolCount).toBe(2)
    expect(summary.elapsedSec).toBeGreaterThan(0)
  })
})
