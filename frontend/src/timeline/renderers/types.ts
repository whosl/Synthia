import type { ReactNode } from 'react'
import type { TimelineEntry } from '../types'

export interface TimelineRenderContext {
  entry: TimelineEntry
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

export type TimelineEntryRenderer = (ctx: TimelineRenderContext) => ReactNode
