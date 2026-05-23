import { getSessionStreamUrl, normalizeEvent } from '../api/events'
import type { SessionEvent } from '../api/types'

const EVENT_TYPES = [
  'session.created','session.updated','session.archived','task.created','task.started','task.stopping','task.stopped','task.done','task.error',
  'message.user.created','message.assistant.delta','message.assistant.completed','message.assistant.stopped','reasoning.delta','reasoning.summary',
  'tool.started','tool.delta','tool.completed','tool.error','llm.started','llm.usage','llm.completed','llm.error','eda.started','eda.log','eda.problem_detected','eda.completed','eda.error',
  'vivado.command.started','vivado.command.stdout','vivado.command.stderr','vivado.command.log','vivado.command.completed','vivado.command.error','problem.detected','kb.candidate.created','artifact.created'
]

export class SessionEventStream {
  private es: EventSource | null = null
  private closed = false
  private retry: number | null = null
  private lastSeq: number
  private attempt = 0
  private visibilityHandler: (() => void) | null = null

  constructor(
    private sessionId: string,
    afterSeq: number,
    private onEvent: (event: SessionEvent) => void,
    private onStatus?: (status: 'connecting' | 'open' | 'closed' | 'error') => void,
  ) {
    this.lastSeq = afterSeq
  }

  connect() {
    this.closed = false
    this.onStatus?.('connecting')
    this.es = new EventSource(getSessionStreamUrl(this.sessionId, this.lastSeq))
    this.es.onopen = () => {
      this.attempt = 0
      this.onStatus?.('open')
    }
    this.es.onerror = () => {
      this.onStatus?.('error')
      this.es?.close()
      this.es = null
      if (!this.closed && !this.retry) {
        const delay = Math.min(1500 * Math.pow(2, this.attempt), 30_000) * (0.8 + Math.random() * 0.4)
        this.attempt++
        this.retry = window.setTimeout(() => {
          this.retry = null
          if (!this.closed) this.connect()
        }, delay)
      }
    }
    for (const type of EVENT_TYPES) {
      this.es.addEventListener(type, (raw) => {
        try {
          const event = normalizeEvent(JSON.parse((raw as MessageEvent).data))
          if (event.seq <= this.lastSeq) return
          this.lastSeq = event.seq
          this.onEvent(event)
        } catch {
          // Keep stream alive on malformed events.
        }
      })
    }
    // Reconnect when page becomes visible after being hidden
    if (!this.visibilityHandler) {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'visible' && !this.closed && this.es?.readyState === EventSource.CLOSED) {
          this.reconnect()
        }
      }
      document.addEventListener('visibilitychange', this.visibilityHandler)
    }
  }

  reconnect() {
    this.es?.close()
    if (!this.closed) this.connect()
  }

  disconnect() {
    this.closed = true
    if (this.retry) window.clearTimeout(this.retry)
    this.retry = null
    this.es?.close()
    this.es = null
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    this.onStatus?.('closed')
  }

  getLastSeq() { return this.lastSeq }
}
