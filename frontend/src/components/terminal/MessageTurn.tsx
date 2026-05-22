import { Bot, User } from 'lucide-react'
import { Markdown } from '../common/Markdown'
import type { TerminalTurn } from '../../lib/eventReducer'
import { formatTime } from '../../lib/time'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallBlock } from './ToolCallBlock'

export function MessageTurn({ turn }: { turn: TerminalTurn }) {
  if (turn.role === 'user') {
    return <div className="message-turn user"><div className="message-bubble">
      <div className="message-meta"><User size={14} /> You {turn.createdAt && <span>{formatTime(turn.createdAt)}</span>}</div>
      {turn.content}
    </div></div>
  }

  return <div className="message-turn assistant"><div className="assistant-stack">
    <div className="message-meta assistant-meta"><Bot size={15} color="var(--accent)" /> EdAgent {turn.partial && <span className="status stopped">partial</span>}</div>
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
        }
      })}
      {turn.blocks.length === 0 && !turn.content && <div className="message-bubble"><span className="muted">Waiting for response…</span></div>}
    </div>
  </div></div>
}
