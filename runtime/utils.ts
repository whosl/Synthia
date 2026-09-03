/** Runtime-wide shared helpers. Each was previously duplicated across 3–5 files. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Glob-pattern workspace path matcher. Supports the `dir/**` suffix convention
 * used by task read/write scopes: a pattern ending in `/**` matches every path
 * under that directory; an exact pattern matches only that path.
 */
export function matchesPath(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return pattern === path;
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Connector job-state helpers ──

export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
  "lost",
  "unknown_effect",
]);

/**
 * Map a Connector job state to a VivadoResult status.
 * Shared by remote-connector and core-api-connector (identical semantics).
 */
export function jobStateToResultStatus(state: string): string {
  switch (state) {
    case "succeeded": return "succeeded";
    case "timeout": return "timeout";
    case "lost": return "lost";
    case "unknown_effect": return "unknown_effect";
    default: return "failed";
  }
}

export function toSourceInput(f: { path: string; content: string; mediaType?: string }) {
  return {
    path: f.path,
    content: f.content,
    ...(f.mediaType ? { mediaType: f.mediaType } : {}),
  };
}
