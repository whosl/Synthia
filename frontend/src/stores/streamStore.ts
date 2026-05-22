import { create } from 'zustand'

type StreamStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed'

interface StreamStore {
  lastSeqBySession: Record<string, number>
  statusBySession: Record<string, StreamStatus>
  setLastSeq: (sessionId: string, seq: number) => void
  getLastSeq: (sessionId: string) => number
  setStatus: (sessionId: string, status: StreamStatus) => void
}

export const useStreamStore = create<StreamStore>((set, get) => ({
  lastSeqBySession: {},
  statusBySession: {},
  setLastSeq: (sessionId, seq) => set((s) => ({ lastSeqBySession: { ...s.lastSeqBySession, [sessionId]: Math.max(seq, s.lastSeqBySession[sessionId] || 0) } })),
  getLastSeq: (sessionId) => get().lastSeqBySession[sessionId] || 0,
  setStatus: (sessionId, status) => set((s) => ({ statusBySession: { ...s.statusBySession, [sessionId]: status } })),
}))
