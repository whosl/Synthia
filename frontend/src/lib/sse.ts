import { getSessionStreamUrl, normalizeEvent } from '../api/events'
import { ALL_WIRE_EVENT_TYPES } from './events/catalog'
import type { SessionEvent } from '../api/types'

/** Union of catalog + runtime-fetched types (deduped). */
let subscribedTypes: string[] = [...ALL_WIRE_EVENT_TYPES]

export function setSubscribedWireEventTypes(types: string[]) {
  subscribedTypes = [...new Set([...ALL_WIRE_EVENT_TYPES, ...types])]
}

export function getSubscribedWireEventTypes(): readonly string[] {
  return subscribedTypes
}

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

    const dispatch = (raw: MessageEvent) => {
      try {
        const event = normalizeEvent(JSON.parse(raw.data))
        if (event.event_type !== 'message.user.created' && event.seq <= this.lastSeq) return
        this.lastSeq = Math.max(this.lastSeq, event.seq || 0)
        this.onEvent(event)
      } catch {
        // Keep stream alive on malformed events.
      }
    }

    for (const type of subscribedTypes) {
      this.es.addEventListener(type, dispatch)
    }

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
