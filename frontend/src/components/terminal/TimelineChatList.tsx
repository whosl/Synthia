import { getChatEntries } from '../../timeline/reducer'
import type { SessionTimelineState } from '../../timeline/types'
import { EmptyState } from '../common/EmptyState'
import { TimelineEntryView } from './TimelineEntryView'

interface TimelineChatListProps {
  timeline: SessionTimelineState
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

export function TimelineChatList({ timeline, onInteractionRespond }: TimelineChatListProps) {
  const entries = getChatEntries(timeline)

  if (!entries.length) {
    return <EmptyState title="No messages yet" detail="Ask about synthesis, timing, constraints, or Vivado reports." />
  }

  return (
    <div className="timeline-chat-list">
      {entries.map((entry) => (
        <TimelineEntryView
          key={entry.key}
          entry={entry}
          onInteractionRespond={onInteractionRespond}
        />
      ))}
    </div>
  )
}
