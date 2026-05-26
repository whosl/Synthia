import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
  const taRef = useRef<HTMLTextAreaElement>(null)

  const send = () => {
    const q = text.trim()
    if (!q || disabled || running) return
    setText('')
    onSend(q)
    taRef.current?.focus()
  }

  const inputPlaceholder =
    placeholder ??
    (running ? t('terminal.composerRunning') : t('terminal.composerPlaceholder'))

  const showStatus = statusActive ?? (running || stopping)

  return (
    <div className="composer-anchor">
      <div className="composer">
        <div className="composer-hint" aria-hidden>
          ⌘K commands · Enter send · Shift+Enter newline
        </div>
        <div className={`composer-row${showStatus ? ' has-status' : ''}`}>
          {showStatus && (
            <span
              className="terminal-status-dot composer-status-dot"
              role="status"
              aria-label={stopping ? t('terminal.synthiaStopping') : t('terminal.synthiaRunning')}
            />
          )}
          <textarea
            ref={taRef}
            value={text}
            disabled={disabled}
            placeholder={inputPlaceholder}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                send()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {running || stopping ? (
            <button
              type="button"
              className="btn-stop"
              onClick={onStop}
              disabled={stopping}
              aria-label={t('terminal.stop')}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn-send"
              onClick={send}
              disabled={disabled || !text.trim()}
              aria-label={t('terminal.send')}
            >
              ↩
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
