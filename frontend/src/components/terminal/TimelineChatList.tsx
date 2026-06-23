import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, CircleDotDashed, Octagon, Wrench } from 'lucide-react'
import { buildTranscriptDisplayItems, type TranscriptDisplayItem } from '../../timeline/chatGrouping'
import { getChatEntries } from '../../timeline/reducer'
import type {
  InteractionEntryPayload,
  SessionTimelineState,
  ToolEntryPayload,
  TranscriptTurn,
} from '../../timeline/types'
import { EmptyState } from '../common/EmptyState'
import { ChatEnterItem, useSeedChatEnterKeys } from './ChatEnterAnimation'
import { TimelineEntryView } from './TimelineEntryView'
import { ToolRunGroup } from './ToolRunGroup'

interface TimelineChatListProps {
  timeline: SessionTimelineState
  taskActive?: boolean
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

function renderDisplayItems(
  items: TranscriptDisplayItem['items'],
  taskActive: boolean,
  onInteractionRespond?: TimelineChatListProps['onInteractionRespond'],
) {
  return items.map((item) => {
    if (item.type === 'tool_group') {
      return (
        <ToolRunGroup
          key={item.key}
          groupKey={item.key}
          members={item.members}
          taskActive={taskActive}
          onInteractionRespond={onInteractionRespond}
        />
      )
    }
    return (
      <TimelineEntryView
        key={item.key}
        entry={item.entry}
        onInteractionRespond={onInteractionRespond}
      />
    )
  })
}

function formatTurnElapsed(startedAt?: number, updatedAt?: number): string | null {
  if (!startedAt || !updatedAt || updatedAt <= startedAt) return null
  const seconds = Math.max(1, Math.round(updatedAt - startedAt))
  if (seconds < 60) return `${seconds}s`
  const min = Math.floor(seconds / 60)
  const sec = seconds % 60
  return `${min}m ${sec}s`
}

function TurnHeader({ turn }: { turn: TranscriptTurn }) {
  const { t } = useTranslation()
  const toolCount = turn.items.filter((entry) => entry.kind === 'tool').length
  const pendingApprovals = turn.items.filter((entry) => (
    entry.kind === 'interaction'
    && (entry.payload as InteractionEntryPayload).status === 'pending'
  )).length
  const failedTools = turn.items.filter((entry) => (
    entry.kind === 'tool'
    && ['error', 'rejected', 'stopped'].includes((entry.payload as ToolEntryPayload).state)
  )).length
  const elapsed = formatTurnElapsed(turn.startedAt, turn.updatedAt)
  const statusIcon =
    turn.status === 'error' ? <AlertTriangle size={13} />
      : turn.status === 'stopped' ? <Octagon size={13} />
        : turn.status === 'running' ? <CircleDotDashed size={13} />
          : <CheckCircle2 size={13} />

  return (
    <div className="transcript-turn-header">
      <span className={`turn-status-pill status-${turn.status}`}>
        {statusIcon}
        {t(`turn.status.${turn.status}`, turn.status)}
      </span>
      {elapsed && <span>{t('turn.elapsed', { elapsed })}</span>}
      {toolCount > 0 && (
        <span>
          <Wrench size={12} />
          {t('turn.tools', { count: toolCount })}
        </span>
      )}
      {failedTools > 0 && <span className="turn-header-error">{t('turn.failures', { count: failedTools })}</span>}
      {pendingApprovals > 0 && <span className="turn-header-blocked">{t('turn.blocked')}</span>}
    </div>
  )
}

export function TimelineChatList({ timeline, taskActive = false, onInteractionRespond }: TimelineChatListProps) {
  const { t } = useTranslation()
  const entries = getChatEntries(timeline)
  const displayItems = useMemo(
    () => buildTranscriptDisplayItems(entries, timeline.activeTaskId, timeline.taskState),
    [entries, timeline.activeTaskId, timeline.taskState],
  )
  const itemKeys = useMemo(() => displayItems.map((item) => item.key), [displayItems])

  useSeedChatEnterKeys(itemKeys)

  if (!displayItems.length) {
    return <EmptyState title={t('terminal.noMessages')} detail={t('terminal.noMessagesDetail')} />
  }

  return (
    <div className="timeline-chat-list">
      {displayItems.map((item) => (
        <ChatEnterItem key={item.key} itemKey={item.key}>
          {item.type === 'turn' ? (
            <div className={`transcript-turn status-${item.turn.status}`} data-task-id={item.turn.taskId || undefined}>
              <TurnHeader turn={item.turn} />
              <TimelineEntryView
                entry={item.turn.user}
                onInteractionRespond={onInteractionRespond}
              />
              {renderDisplayItems(
                item.items,
                taskActive && item.turn.status === 'running',
                onInteractionRespond,
              )}
            </div>
          ) : (
            <div className="transcript-orphan-group">
              {renderDisplayItems(item.items, taskActive, onInteractionRespond)}
            </div>
          )}
        </ChatEnterItem>
      ))}
    </div>
  )
}
