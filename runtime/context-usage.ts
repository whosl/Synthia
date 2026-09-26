/** Request-local observations; historical usage is never a pending-request estimate. */
export interface ContextUsageSnapshot {
  estimatedPromptTokens: number | null;
  requestState: "idle" | "preparing" | "pending" | "measured" | "unreported" | "failed" | "restored";
  compactionState: "none" | "running" | "applied" | "failed";
  measuredAt: string | null;
  failure: "rate_limit" | "context_limit" | "request_failed" | null;
}

export interface ContextUsage extends ContextUsageSnapshot {
  promptTokens: number | null;
  contextWindow: number;
  windowSource: "configured" | "default";
}

export function newContextUsage(): ContextUsageSnapshot {
  return { estimatedPromptTokens: null, requestState: "idle", compactionState: "none", measuredAt: null, failure: null };
}

export function contextFailure(error: unknown): ContextUsageSnapshot["failure"] {
  const text = error instanceof Error ? error.message : String(error);
  if (/429|rate.limit|1308/i.test(text)) return "rate_limit";
  if (/context[_ ]length|too many tokens|maximum context|context window|token limit|exceeds the model|prompt is too long|\[1261\]|context_budget_exceeded/i.test(text)) return "context_limit";
  return "request_failed";
}

export function contextUsageDto(usage: ContextUsage) {
  return {
    prompt_tokens: usage.promptTokens,
    context_window: usage.contextWindow,
    window_source: usage.windowSource,
    estimated_prompt_tokens: usage.estimatedPromptTokens,
    request_state: usage.requestState,
    compaction_state: usage.compactionState,
    measured_at: usage.measuredAt,
    failure: usage.failure,
  };
}
