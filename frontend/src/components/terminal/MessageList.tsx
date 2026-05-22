import type { TerminalTurn } from '../../lib/eventReducer'
import { EmptyState } from '../common/EmptyState'
import { MessageTurn } from './MessageTurn'

export function MessageList({ turns }: { turns: TerminalTurn[] }) {
  if (!turns.length) return <EmptyState title="No messages yet" detail="Ask about synthesis, timing, constraints, or Vivado reports." />
  return <div>{turns.map((turn) => <MessageTurn key={turn.id} turn={turn} />)}</div>
}
