/** User-facing agent name in timeline audit and labels */
export const AGENT_DISPLAY_NAME = 'Synthia'

/** Rewrite legacy audit titles that used "Assistant" */
export function formatAuditTitle(title: string): string {
  if (!title.startsWith('Assistant ')) return title
  return `${AGENT_DISPLAY_NAME} ${title.slice('Assistant '.length)}`
}
