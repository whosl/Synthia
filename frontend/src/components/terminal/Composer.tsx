import { Send, Square } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../common/Button'

export function Composer({ disabled, running, stopping, onSend, onStop }: { disabled?: boolean; running?: boolean; stopping?: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [text, setText] = useState('')
  const send = () => { const q = text.trim(); if (!q) return; setText(''); onSend(q) }
  return <div className="composer">
    <input className="input mono" value={text} disabled={disabled} placeholder={running ? 'Agent is running…' : 'Ask about synthesis, timing, constraints…'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
    {running || stopping ? (
      <Button
        className="danger composer-action"
        onClick={onStop}
        disabled={stopping}
        aria-label={stopping ? 'Stopping agent' : 'Stop agent'}
        title={stopping ? 'Stopping…' : 'Stop'}
      >
        <Square size={16} />
      </Button>
    ) : (
      <Button className="primary composer-action" onClick={send} aria-label="Send message" title="Send">
        <Send size={16} />
      </Button>
    )}
  </div>
}
