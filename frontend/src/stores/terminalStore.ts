import { create } from 'zustand'

type TerminalView = 'chat' | 'timeline' | 'memory'
export type RightPanelTab = 'run' | 'artifacts' | 'vivado' | 'debug'

interface TerminalStore {
  view: TerminalView
  rightPanelOpen: boolean
  rightPanelTab: RightPanelTab
  collapsed: Record<string, boolean>
  toast: { message: string; kind: 'error' | 'info' } | null
  setView: (view: TerminalView) => void
  setRightPanelOpen: (open: boolean) => void
  setRightPanelTab: (tab: RightPanelTab) => void
  /** @param defaultCollapsed fold state when id has never been toggled (default true) */
  toggleCollapsed: (id: string, defaultCollapsed?: boolean) => void
  showToast: (message: string, kind?: 'error' | 'info') => void
  clearToast: () => void
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  view: 'chat',
  rightPanelOpen: false,
  rightPanelTab: 'run',
  collapsed: {},
  toast: null,
  setView: (view) => set({ view }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
  toggleCollapsed: (id, defaultCollapsed = true) => set((s) => {
    const isCollapsed = s.collapsed[id] ?? defaultCollapsed
    return { collapsed: { ...s.collapsed, [id]: !isCollapsed } }
  }),
  showToast: (message, kind = 'info') => set({ toast: { message, kind } }),
  clearToast: () => set({ toast: null }),
}))
