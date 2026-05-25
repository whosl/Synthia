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
  it('shows at least 1 second for sub-second durations', () => {
    expect(formatWorkedDuration(0)).toBe('1 s')
    expect(formatWorkedDuration(0.4)).toBe('1 s')
  })

  it('formats worked duration with minutes and seconds', () => {
    expect(formatWorkedDuration(45)).toBe('45 s')
    expect(formatWorkedDuration(75)).toBe('1 min 15 s')
    expect(formatWorkedDuration(120)).toBe('2 min')
  })

  it('formats summary line', () => {
    const line = formatWorkGroupSummaryLine({ elapsedSec: 90, toolCount: 3 })
    expect(line).toBe('Run time 90s · called 3 tools')
  })

  it('counts tools in work members', () => {
    const summary = buildWorkGroupSummary([toolEntry('a'), toolEntry('b')], null)
    expect(summary.toolCount).toBe(2)
    expect(summary.elapsedSec).toBeGreaterThan(0)
  })
})
