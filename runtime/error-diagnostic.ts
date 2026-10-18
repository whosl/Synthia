export const MAX_ERROR_DIAGNOSTIC_CHARS = 8192;

/** Bounded stack/cause chain, including non-Error throws and cyclic causes. */
export function errorDiagnostic(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    if (seen.has(current)) { parts.push("[cyclic cause]"); break; }
    seen.add(current);
    parts.push(current instanceof Error ? current.stack || `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  const text = parts.join("\nCaused by: ");
  return text.length <= MAX_ERROR_DIAGNOSTIC_CHARS ? text : `${text.slice(0, MAX_ERROR_DIAGNOSTIC_CHARS - 14)}…[truncated]`;
}
