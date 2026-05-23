import { create } from 'zustand'

type TerminalView = 'chat' | 'timeline'
export type RightPanelTab = 'summary' | 'terminal' | 'files' | 'vivado'

interface TerminalStore {
  view: TerminalView
  rightPanelOpen: boolean
  rightPanelTab: RightPanelTab
  collapsed: Record<string, boolean>
  setView: (view: TerminalView) => void
  setRightPanelOpen: (open: boolean) => void
  setRightPanelTab: (tab: RightPanelTab) => void
  toggleCollapsed: (id: string) => void
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  view: 'chat',
  rightPanelOpen: true,
  rightPanelTab: 'summary',
  collapsed: {},
  setView: (view) => set({ view }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
  toggleCollapsed: (id) => set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
}))
