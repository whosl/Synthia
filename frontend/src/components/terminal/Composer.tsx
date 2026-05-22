import { Send, Square } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../common/Button'

export function Composer({ disabled, running, stopping, onSend, onStop }: { disabled?: boolean; running?: boolean; stopping?: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [text, setText] = useState('')
  const send = () => { const q = text.trim(); if (!q) return; setText(''); onSend(q) }
  return <div className="composer">
    <input className="input mono" value={text} disabled={disabled} placeholder={running ? 'Agent is running…' : 'Ask about synthesis, timing, constraints…'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
    {running || stopping ? <Button className="danger" onClick={onStop} disabled={stopping}><Square size={14} /> {stopping ? 'Stopping…' : 'Stop'}</Button> : <Button className="primary" onClick={send}><Send size={14} /> Send</Button>}
  </div>
}
