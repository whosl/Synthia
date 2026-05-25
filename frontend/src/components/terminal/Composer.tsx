import { Send, Square } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const send = () => { const q = text.trim(); if (!q || disabled) return; setText(''); onSend(q) }
  const inputPlaceholder =
    placeholder ??
    (running ? t('terminal.composerRunning') : t('terminal.composerPlaceholder'))
  const showStatus = statusActive ?? (running || stopping)
  return (
    <div className="composer-anchor">
      <div className="composer">
    <div className={`composer-input-wrap${showStatus ? ' has-status' : ''}`}>
      {showStatus && (
        <span
          className="terminal-status-dot composer-status-dot"
          role="status"
          aria-label={stopping ? t('terminal.synthiaStopping') : t('terminal.synthiaRunning')}
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
        aria-label={stopping ? t('terminal.stopAgent') : t('terminal.stopAgent')}
        title={stopping ? t('terminal.stopping') : t('terminal.stop')}
      >
        <Square size={16} />
      </Button>
    ) : (
      <Button className="primary composer-action" onClick={send} aria-label={t('terminal.send')} title={t('terminal.send')}>
        <Send size={16} />
      </Button>
    )}
      </div>
    </div>
  )
}
