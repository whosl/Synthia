import { describe, expect, it } from 'vitest'
import type { EvolutionCandidate } from '../api/evolution'
import { buildLocalApplyPreview } from './evolutionPreview'

describe('buildLocalApplyPreview', () => {
  it('extracts flow_template Tcl from metadata suggested_payload', () => {
    const tcl = 'read_verilog {rtl/top.v}\nsynth_design -top top\n'
    const candidate = {
      id: 'abc',
      scope: 'project',
      surface: 'flow_template',
      title: 'Promote synth',
      status: 'pending',
      created_by: 'test',
      created_at: 0,
      metadata: {
        suggested_payload: { templates: { synth: tcl } },
      },
    } as EvolutionCandidate

    const preview = buildLocalApplyPreview(candidate)
    expect(preview.flow_templates?.synth).toBe(tcl)
  })

  it('synthesizes repeated_failure prompt text', () => {
    const candidate = {
      id: 'abc',
      scope: 'project',
      surface: 'prompt',
      title: 't',
      status: 'pending',
      created_by: 'test',
      created_at: 0,
      signal_source: {
        signal: 'repeated_failure',
        first_run_success: 0.15,
      },
    } as EvolutionCandidate

    const preview = buildLocalApplyPreview(candidate)
    expect(preview.prompt_text).toContain('15%')
    expect(preview.prompt_text).toContain('parse_vivado_log_tool')
  })
})
