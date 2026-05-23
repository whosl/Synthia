import { Bot, User } from 'lucide-react'
import { Markdown } from '../common/Markdown'
import type { TerminalTurn } from '../../lib/eventReducer'
import { formatTime } from '../../lib/time'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ApprovalBlock } from './ApprovalBlock'
import { InputRequestBlock } from './InputRequestBlock'

interface MessageTurnProps {
  turn: TerminalTurn
  onInteractionRespond?: (interactionId: string, response: Record<string, any>) => void
}

export function MessageTurn({ turn, onInteractionRespond }: MessageTurnProps) {
  if (turn.role === 'user') {
    return <div className="message-turn user"><div className="message-bubble">
      <div className="message-meta"><User size={14} /> You {turn.createdAt && <span>{formatTime(turn.createdAt)}</span>}</div>
      {turn.content}
    </div></div>
  }

  return <div className="message-turn assistant"><div className="assistant-stack">
    <div className="message-meta assistant-meta"><Bot size={15} color="var(--accent)" /> EdAgent {turn.stopped && <span className="status stopped">stopped</span>}{turn.partial && !turn.stopped && <span className="status stopped">partial</span>}</div>
    <div className="assistant-blocks">
      {turn.blocks.map((block) => {
        switch (block.kind) {
          case 'text':
            return block.data.text.trim()
              ? <div key={block.data.id} className="message-bubble assistant-text-bubble"><Markdown text={block.data.text} /></div>
              : null
          case 'reasoning':
            return <ReasoningBlock key={block.data.id} {...block.data} />
          case 'tool':
            return <ToolCallBlock key={block.data.id} tool={block.data} />
          case 'interaction':
            if (block.data.interaction_type === 'approval') {
              return <ApprovalBlock
                key={block.data.id}
                id={block.data.id}
                title={block.data.title}
                message={block.data.message}
                files={block.data.files || []}
                status={block.data.status as 'pending' | 'approved' | 'rejected'}
                onApprove={(id, files) => onInteractionRespond?.(id, { approved: true, approved_files: files })}
                onReject={(id) => onInteractionRespond?.(id, { approved: false })}
              />
            }
            return <InputRequestBlock
              key={block.data.id}
              id={block.data.id}
              title={block.data.title}
              message={block.data.message}
              fields={(block.data.fields || []) as any}
              status={block.data.status === 'responded' ? 'responded' : 'pending'}
              response={block.data.response}
              onSubmit={(id, values) => onInteractionRespond?.(id, values)}
            />
        }
      })}
      {turn.blocks.length === 0 && !turn.content && <div className="working-indicator"><span className="working-dot" /><span className="working-text">Working...</span></div>}
    </div>
  </div></div>
}
