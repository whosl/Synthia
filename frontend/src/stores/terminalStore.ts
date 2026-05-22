import { create } from 'zustand'

type TerminalView = 'chat' | 'timeline'

interface TerminalStore {
  view: TerminalView
  debugOpen: boolean
  collapsed: Record<string, boolean>
  setView: (view: TerminalView) => void
  setDebugOpen: (open: boolean) => void
  toggleCollapsed: (id: string) => void
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  view: 'chat',
  debugOpen: true,
  collapsed: {},
  setView: (view) => set({ view }),
  setDebugOpen: (debugOpen) => set({ debugOpen }),
  toggleCollapsed: (id) => set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
}))
