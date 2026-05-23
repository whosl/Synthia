import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ShellStore {
  navCollapsed: boolean
  setNavCollapsed: (collapsed: boolean) => void
  toggleNavCollapsed: () => void
}

export const useShellStore = create<ShellStore>()(
  persist(
    (set) => ({
      navCollapsed: false,
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      toggleNavCollapsed: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
    }),
    { name: 'edagent-shell' },
  ),
)
