import { Send, Square } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../common/Button'

export function Composer({
  disabled,
  running,
  stopping,
  statusActive,
  placeholder,
  onSend,
  onStop,
}: {
  disabled?: boolean
  running?: boolean
  stopping?: boolean
  statusActive?: boolean
  placeholder?: string
  onSend: (text: string) => void
  onStop: () => void
}) {
  const [text, setText] = useState('')
  const send = () => { const q = text.trim(); if (!q || disabled) return; setText(''); onSend(q) }
  const inputPlaceholder =
    placeholder ??
    (running ? 'synthia is running…' : 'Ask about synthesis, timing, constraints…')
  const showStatus = statusActive ?? (running || stopping)
  return (
    <div className="composer-anchor">
      <div className="composer">
    <div className={`composer-input-wrap${showStatus ? ' has-status' : ''}`}>
      {showStatus && (
        <span
          className="terminal-status-dot composer-status-dot"
          role="status"
          aria-label={stopping ? 'synthia stopping' : 'synthia running'}
        />
      )}
      <input
        className="input mono"
        value={text}
        disabled={disabled}
        placeholder={inputPlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
      />
    </div>
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
    </div>
  )
}
