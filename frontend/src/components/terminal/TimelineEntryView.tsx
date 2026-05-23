import { Bot, User } from 'lucide-react'
import { Markdown } from '../common/Markdown'
import type { TimelineEntry } from '../../timeline/types'
import type {
  AssistantTextPayload,
  InteractionEntryPayload,
  ReasoningEntryPayload,
  ToolEntryPayload,
  UserEntryPayload,
} from '../../timeline/types'
import { formatTime } from '../../lib/time'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ApprovalBlock } from './ApprovalBlock'
import { InputRequestBlock } from './InputRequestBlock'

interface TimelineEntryViewProps {
  entry: TimelineEntry
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

export function TimelineEntryView({ entry, onInteractionRespond }: TimelineEntryViewProps) {
  if (entry.kind === 'user') {
    const p = entry.payload as UserEntryPayload
    return (
      <div className="message-turn user">
        <div className="message-bubble">
          <div className="message-meta">
            <User size={14} /> You {entry.createdAt && <span>{formatTime(entry.createdAt)}</span>}
          </div>
          {p.text}
        </div>
      </div>
    )
  }

  const stickyPending =
    entry.kind === 'interaction'
    && (entry.payload as InteractionEntryPayload).status === 'pending'
    && (entry.payload as InteractionEntryPayload).interaction_type === 'approval'

  return (
    <div className={`message-turn assistant timeline-entry kind-${entry.kind}${stickyPending ? ' sticky-pending-approval' : ''}`}>
      {entry.kind === 'assistant_text' && (
        <div className="assistant-stack">
          <div className="message-meta assistant-meta">
            <Bot size={15} color="var(--accent)" /> EdAgent
            {(entry.payload as AssistantTextPayload).stopped && <span className="status stopped">stopped</span>}
            {(entry.payload as AssistantTextPayload).partial && !(entry.payload as AssistantTextPayload).stopped && (
              <span className="status stopped">partial</span>
            )}
          </div>
          {(entry.payload as AssistantTextPayload).text.trim() ? (
            <div className="message-bubble assistant-text-bubble">
              <Markdown text={(entry.payload as AssistantTextPayload).text} />
            </div>
          ) : null}
        </div>
      )}

      {entry.kind === 'reasoning' && (
        <ReasoningBlock
          id={entry.id}
          {...(entry.payload as ReasoningEntryPayload)}
        />
      )}

      {entry.kind === 'tool' && (
        <ToolCallBlock
          tool={{
            id: (entry.payload as ToolEntryPayload).toolcallId,
            name: (entry.payload as ToolEntryPayload).name,
            state: (entry.payload as ToolEntryPayload).state,
            args: (entry.payload as ToolEntryPayload).args,
            result: (entry.payload as ToolEntryPayload).result,
            startedAt: entry.createdAt,
          }}
        />
      )}

      {entry.kind === 'interaction' && (entry.payload as InteractionEntryPayload).interaction_type === 'approval' && (
        <ApprovalBlock
          id={entry.id}
          title={(entry.payload as InteractionEntryPayload).title}
          message={(entry.payload as InteractionEntryPayload).message}
          reason={(entry.payload as InteractionEntryPayload).reason}
          files={(entry.payload as InteractionEntryPayload).files || []}
          status={(entry.payload as InteractionEntryPayload).status as 'pending' | 'approved' | 'rejected'}
          response={(entry.payload as InteractionEntryPayload).response}
          onApprove={(iid, files) => onInteractionRespond?.(iid, { approved: true, approved_files: files })}
          onReject={(iid) => onInteractionRespond?.(iid, { approved: false })}
        />
      )}

      {entry.kind === 'interaction' && (entry.payload as InteractionEntryPayload).interaction_type === 'input_request' && (
        <InputRequestBlock
          id={entry.id}
          title={(entry.payload as InteractionEntryPayload).title}
          message={(entry.payload as InteractionEntryPayload).message}
          fields={((entry.payload as InteractionEntryPayload).fields || []) as any}
          status={(entry.payload as InteractionEntryPayload).status === 'responded' ? 'responded' : 'pending'}
          response={(entry.payload as InteractionEntryPayload).response as unknown as Record<string, string> | undefined}
          onSubmit={(iid, values) => onInteractionRespond?.(iid, values)}
        />
      )}
    </div>
  )
}
