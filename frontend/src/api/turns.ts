import { request } from './client'
import type { TranscriptTurnItem, TranscriptTurnRow } from './types'

function normalizeTurnItem(item: TranscriptTurnItem): TranscriptTurnItem {
  if (item.payload) return item
  if (!item.payload_json) return { ...item, payload: {} }
  try {
    const payload = JSON.parse(item.payload_json)
    return { ...item, payload: payload && typeof payload === 'object' ? payload : {} }
  } catch {
    return { ...item, payload: { raw: item.payload_json } }
  }
}

export async function listTurns(sessionId: string, limit = 200, rebuild = false) {
  const qs = new URLSearchParams()
  if (limit) qs.set('limit', String(limit))
  if (rebuild) qs.set('rebuild', 'true')
  const data = await request<{ turns: TranscriptTurnRow[]; last_event_seq?: number }>(
    `/sessions/${sessionId}/turns${qs.size ? `?${qs}` : ''}`,
  )
  return {
    lastEventSeq: data.last_event_seq ?? 0,
    turns: data.turns.map((turn) => ({
      ...turn,
      items: (turn.items || []).map(normalizeTurnItem),
    })),
  }
}
