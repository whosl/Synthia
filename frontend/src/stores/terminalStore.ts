import { create } from 'zustand'

type TerminalView = 'chat' | 'timeline' | 'memory'
export type RightPanelTab = 'run' | 'artifacts' | 'vivado' | 'debug'

interface TerminalStore {
  view: TerminalView
  rightPanelOpen: boolean
  rightPanelTab: RightPanelTab
  collapsed: Record<string, boolean>
  setView: (view: TerminalView) => void
  setRightPanelOpen: (open: boolean) => void
  setRightPanelTab: (tab: RightPanelTab) => void
  /** @param defaultCollapsed fold state when id has never been toggled (default true) */
  toggleCollapsed: (id: string, defaultCollapsed?: boolean) => void
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  view: 'chat',
  rightPanelOpen: false,
  rightPanelTab: 'run',
  collapsed: {},
  setView: (view) => set({ view }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
  toggleCollapsed: (id, defaultCollapsed = true) => set((s) => {
    const isCollapsed = s.collapsed[id] ?? defaultCollapsed
    return { collapsed: { ...s.collapsed, [id]: !isCollapsed } }
  }),
}))
