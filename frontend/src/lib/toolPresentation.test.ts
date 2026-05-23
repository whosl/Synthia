import { describe, expect, it } from 'vitest'
import {
  buildFailureCard,
  buildToolGroupSummary,
  computeToolGroupElapsedSec,
  formatToolGroupSummaryLine,
  inferStage,
  parseToolOutcome,
  pickPrimaryFailure,
  toolEntryToViewModel,
} from './toolPresentation'

describe('toolPresentation', () => {
  it('parses execution_failed vivado JSON', () => {
    const parsed = parseToolOutcome(JSON.stringify({
      edagent_outcome: 'execution_failed',
      scope: 'vivado_synth',
      success: false,
      error: '[Common 17-69] File not found: uart_rx.v',
      stderr: 'read_verilog /remote/uart_rx.v\n',
      elapsed_sec: 29.6,
    }))
    expect(parsed.outcome).toBe('execution_failed')
    expect(parsed.stage).toBe('read_verilog')
  })

  it('builds synthesis failure card', () => {
    const tool = toolEntryToViewModel({
      toolcallId: 'tc1',
      name: 'run_vivado_synth_tool',
      state: 'error',
      result: JSON.stringify({
        edagent_outcome: 'execution_failed',
        scope: 'vivado_synth',
        error: '[Common 17-69] File not found',
        stderr: 'read_verilog foo.v',
        elapsed_sec: 29.6,
      }),
      elapsedMs: 29600,
    })
    const card = buildFailureCard(tool)
    expect(card?.title).toBe('Synthesis Failed')
    expect(card?.stage).toBe('read_verilog')
    expect(card?.action).toMatch(/RTL/i)
  })

  it('formats group summary line', () => {
    const tools = [
      toolEntryToViewModel({ toolcallId: 'a', name: 'grep_tool', state: 'completed', result: '{}' }),
      toolEntryToViewModel({ toolcallId: 'b', name: 'read_tool', state: 'completed', result: '{}' }),
      toolEntryToViewModel({
        toolcallId: 'c',
        name: 'run_vivado_synth_tool',
        state: 'error',
        result: JSON.stringify({ edagent_outcome: 'execution_failed', stderr: 'read_verilog x' }),
      }),
    ]
    const primary = pickPrimaryFailure(tools)
    const summary = buildToolGroupSummary(tools, primary)
    const line = formatToolGroupSummaryLine(summary)
    expect(line).toContain('2 tools completed in')
    expect(line).toMatch(/in \d+ s$/)
    expect(line).not.toContain('tool error')
    expect(summary.tail).toContain('read_verilog')
  })

  it('sums group elapsed from tool durations', () => {
    const tools = [
      toolEntryToViewModel({
        toolcallId: 'a',
        name: 'grep_tool',
        state: 'completed',
        elapsedMs: 1500,
      }),
      toolEntryToViewModel({
        toolcallId: 'b',
        name: 'read_tool',
        state: 'completed',
        elapsedMs: 2500,
      }),
    ]
    expect(computeToolGroupElapsedSec(tools)).toBeGreaterThanOrEqual(4)
  })

  it('infers stage from stderr', () => {
    expect(inferStage('ERROR: [Synth 8-439] read_verilog module')).toBe('read_verilog')
  })
})
