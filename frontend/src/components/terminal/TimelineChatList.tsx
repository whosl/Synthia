import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { groupChatEntries } from '../../timeline/chatGrouping'
import { getChatEntries } from '../../timeline/reducer'
import type { SessionTimelineState } from '../../timeline/types'
import { EmptyState } from '../common/EmptyState'
import { ChatEnterItem, useSeedChatEnterKeys } from './ChatEnterAnimation'
import { TimelineEntryView } from './TimelineEntryView'
import { ToolRunGroup } from './ToolRunGroup'

interface TimelineChatListProps {
  timeline: SessionTimelineState
  taskActive?: boolean
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

export function TimelineChatList({ timeline, taskActive = false, onInteractionRespond }: TimelineChatListProps) {
  const { t } = useTranslation()
  const entries = getChatEntries(timeline)
  const displayItems = useMemo(() => groupChatEntries(entries), [entries])
  const itemKeys = useMemo(() => displayItems.map((item) => item.key), [displayItems])

  useSeedChatEnterKeys(itemKeys)

  if (!displayItems.length) {
    return <EmptyState title={t('terminal.noMessages')} detail={t('terminal.noMessagesDetail')} />
  }

  return (
    <div className="timeline-chat-list">
      {displayItems.map((item) => (
        <ChatEnterItem key={item.key} itemKey={item.key}>
          {item.type === 'tool_group' ? (
            <ToolRunGroup
              groupKey={item.key}
              members={item.members}
              taskActive={taskActive}
              onInteractionRespond={onInteractionRespond}
            />
          ) : (
            <TimelineEntryView
              entry={item.entry}
              onInteractionRespond={onInteractionRespond}
            />
          )}
        </ChatEnterItem>
      ))}
    </div>
  )
}
