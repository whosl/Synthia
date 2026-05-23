import type { TimelineEntry } from '../../timeline/types'
import { renderTimelineEntryShell } from '../../timeline/renderers'

interface TimelineEntryViewProps {
  entry: TimelineEntry
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

export function TimelineEntryView({ entry, onInteractionRespond }: TimelineEntryViewProps) {
  return (
    <>
      {renderTimelineEntryShell({ entry, onInteractionRespond })}
    </>
  )
}
