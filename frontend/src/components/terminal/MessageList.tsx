import type { TerminalTurn } from '../../lib/eventReducer'
import { EmptyState } from '../common/EmptyState'
import { MessageTurn } from './MessageTurn'

interface MessageListProps {
  turns: TerminalTurn[]
  onInteractionRespond?: (interactionId: string, response: Record<string, any>) => void
}

export function MessageList({ turns, onInteractionRespond }: MessageListProps) {
  if (!turns.length) return <EmptyState title="No messages yet" detail="Ask about synthesis, timing, constraints, or Vivado reports." />
  return <div>{turns.map((turn) => <MessageTurn key={turn.id} turn={turn} onInteractionRespond={onInteractionRespond} />)}</div>
}
