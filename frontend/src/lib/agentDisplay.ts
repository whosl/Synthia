import i18n from './i18n'

/** User-facing agent name in timeline audit and labels */
export const AGENT_DISPLAY_NAME = i18n.t('app.brand')

/** Rewrite legacy audit titles that used "Assistant" */
export function formatAuditTitle(title: string): string {
  if (!title.startsWith('Assistant ')) return title
  return `${AGENT_DISPLAY_NAME} ${title.slice('Assistant '.length)}`
}
