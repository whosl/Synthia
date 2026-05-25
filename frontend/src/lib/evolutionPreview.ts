import type { EvolutionCandidate, EvolutionCandidatePreview, EvolutionSurface } from '../api/evolution'

function signalOf(candidate: EvolutionCandidate): Record<string, unknown> {
  return (candidate.signal_source || {}) as Record<string, unknown>
}

function suggestedPayload(candidate: EvolutionCandidate): Record<string, unknown> | null {
  const signal = signalOf(candidate)
  const fromSignal = signal.suggested_payload
  if (fromSignal && typeof fromSignal === 'object' && !Array.isArray(fromSignal)) {
    return fromSignal as Record<string, unknown>
  }
  const meta = candidate.metadata || {}
  const fromMeta = meta.suggested_payload
  if (fromMeta && typeof fromMeta === 'object' && !Array.isArray(fromMeta)) {
    return fromMeta as Record<string, unknown>
  }
  return null
}

function promptTextForSignal(candidate: EvolutionCandidate): { mode: string; text: string; effect: string } {
  const signal = signalOf(candidate)
  const signalName = String(signal.signal || '')
  const mode = String((candidate.metadata?.suggested_overlay_mode as string | undefined) || 'append')

  if (signalName === 'repeated_failure') {
    const rate = Number(signal.first_run_success ?? 0)
    const pct = Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '0%'
    const text =
      `This project currently shows first-run success of ${pct}. ` +
      'Be cautious about synthesis errors: run `parse_vivado_log_tool` and ' +
      '`match_error_cases_tool` before proposing fixes, and prefer minimal patches.'
    return { mode, text, effect: 'Appended after the baseline system prompt.' }
  }

  if (signalName === 'negative_feedback') {
    return {
      mode,
      text:
        'Recent user feedback was negative. Pause and ask clarifying questions ' +
        'before requesting tool approvals. Surface evidence (message IDs, log ' +
        'excerpts, WNS) in every diagnosis section.',
      effect: 'Appended after the baseline system prompt.',
    }
  }

  if (signalName === 'approval_drop') {
    return {
      mode,
      text:
        'Users have been rejecting recent approval requests. Make every ' +
        '`approval_request` minimal: cite specific evidence, propose only one ' +
        'concrete action at a time, and never bundle unrelated file changes.',
      effect: 'Appended after the baseline system prompt.',
    }
  }

  const text = String(candidate.rationale || candidate.title || '').trim()
  const effect =
    mode === 'replace'
      ? 'Replaces the baseline system prompt entirely.'
      : mode === 'prepend'
        ? 'Prepended before the baseline system prompt.'
        : 'Appended after the baseline system prompt.'
  return { mode, text, effect }
}

function kbCasePreview(candidate: EvolutionCandidate): Record<string, unknown> {
  const signal = signalOf(candidate)
  const pattern =
    String(signal.normalized_signature || '').trim() ||
    String(signal.sample_message || '').trim().slice(0, 120) ||
    candidate.title ||
    '(unspecified)'
  const likely = Array.isArray(signal.likely_causes)
    ? [...(signal.likely_causes as unknown[])]
    : []
  if (!likely.length && typeof signal.sample_message === 'string' && signal.sample_message.trim()) {
    likely.push(`Detected from recurring problem: ${signal.sample_message.trim().slice(0, 200)}`)
  }
  const actions = Array.isArray(signal.suggested_actions)
    ? [...(signal.suggested_actions as unknown[])]
    : ['Investigate using parse_vivado_log_tool and match_error_cases_tool']
  return {
    pattern,
    likely_causes: likely,
    suggested_actions: actions,
    category: String(signal.sample_category || 'vivado'),
    normalized_signature: pattern,
  }
}

/** Client-side mirror of backend preview_candidate_payload (fallback when API unavailable). */
export function buildLocalApplyPreview(candidate: EvolutionCandidate): EvolutionCandidatePreview {
  const surface = candidate.surface as EvolutionSurface
  const suggested = suggestedPayload(candidate)

  if (surface === 'prompt') {
    const { mode, text, effect } = promptTextForSignal(candidate)
    return {
      candidate_id: candidate.id,
      surface,
      scope: candidate.scope,
      payload: { mode, text },
      prompt_mode: mode,
      prompt_text: text,
      prompt_effect: effect,
    }
  }

  if (surface === 'flow_template') {
    const templatesRaw = (suggested?.templates || {}) as Record<string, unknown>
    const templates: Record<string, string> = {}
    for (const [name, body] of Object.entries(templatesRaw)) {
      if (typeof body === 'string' && body.trim()) templates[name] = body
    }
    return {
      candidate_id: candidate.id,
      surface,
      scope: candidate.scope,
      payload: { templates },
      flow_templates: templates,
    }
  }

  if (surface === 'routing') {
    const payload = {
      weights: (suggested?.weights as Record<string, number> | undefined) || {},
      rules: (suggested?.rules as Array<Record<string, unknown>> | undefined) || [],
    }
    return {
      candidate_id: candidate.id,
      surface,
      scope: candidate.scope,
      payload,
      routing_weights: payload.weights,
      routing_rules: payload.rules,
    }
  }

  if (surface === 'kb') {
    const kb = kbCasePreview(candidate)
    return {
      candidate_id: candidate.id,
      surface,
      scope: candidate.scope,
      payload: { kb_case_id: null, pattern: kb.pattern, kb_case_preview: kb },
    }
  }

  if (surface === 'tool') {
    const payload = {
      disabled: Array.isArray(suggested?.disabled) ? suggested?.disabled : [],
      additional_tools: Array.isArray(suggested?.additional_tools) ? suggested?.additional_tools : [],
    }
    return {
      candidate_id: candidate.id,
      surface,
      scope: candidate.scope,
      payload,
    }
  }

  return {
    candidate_id: candidate.id,
    surface,
    scope: candidate.scope,
    payload: suggested || {},
  }
}
