import type { TimelineHandlerContext } from '../context'
import type { SessionTimelineState } from '../types'

export type TimelineEventHandler = (ctx: TimelineHandlerContext) => SessionTimelineState

export type TimelineHandlerRegistration = {
  wireTypes: string[]
  handler: TimelineEventHandler
}
