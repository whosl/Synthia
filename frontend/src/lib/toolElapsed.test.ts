import { describe, expect, it } from 'vitest'
import { estimateToolElapsedMs, resolveToolElapsedMs } from './toolElapsed'

describe('toolElapsed', () => {
  it('uses backend elapsed_ms when positive', () => {
    expect(
      resolveToolElapsedMs({
        id: 'tc1',
        name: 'read_file_tool',
        state: 'completed',
        elapsedMs: 842,
      }),
    ).toBe(842)
  })

  it('estimates when elapsed_ms is zero', () => {
    const ms = resolveToolElapsedMs({
      id: 'tc2',
      name: 'read_file_tool',
      state: 'completed',
      elapsedMs: 0,
    })
    expect(ms).toBeGreaterThanOrEqual(80)
    expect(ms).toBeLessThan(600)
  })

  it('vivado tools get longer estimates', () => {
    const ms = estimateToolElapsedMs('run_vivado_synth_tool', 'abc')
    expect(ms).toBeGreaterThanOrEqual(25_000)
  })
})
