import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

interface ChatEnterContextValue {
  /** True only the first time this item key appears after initial history seed. */
  consumeEnter: (itemKey: string) => boolean
  seedKeys: (keys: string[]) => void
  reset: () => void
}

const ChatEnterContext = createContext<ChatEnterContextValue | null>(null)

export function ChatEnterProvider({
  sessionId,
  children,
}: {
  sessionId: string
  children: ReactNode
}) {
  const seenRef = useRef(new Set<string>())
  const seededRef = useRef(false)

  const reset = useCallback(() => {
    seenRef.current = new Set()
    seededRef.current = false
  }, [])

  useLayoutEffect(() => {
    reset()
  }, [sessionId, reset])

  const seedKeys = useCallback((keys: string[]) => {
    if (seededRef.current || keys.length === 0) return
    for (const k of keys) seenRef.current.add(k)
    seededRef.current = true
  }, [])

  const consumeEnter = useCallback((itemKey: string) => {
    if (!seededRef.current) return false
    if (seenRef.current.has(itemKey)) return false
    seenRef.current.add(itemKey)
    return true
  }, [])

  const value: ChatEnterContextValue = { consumeEnter, seedKeys, reset }

  return <ChatEnterContext.Provider value={value}>{children}</ChatEnterContext.Provider>
}

export function ChatEnterItem({ itemKey, children }: { itemKey: string; children: ReactNode }) {
  const ctx = useContext(ChatEnterContext)
  const [enter] = useState(() => ctx?.consumeEnter(itemKey) ?? false)

  return (
    <div className={enter ? 'chat-item-enter' : undefined} data-chat-item-key={itemKey}>
      {children}
    </div>
  )
}

/** Seed all current list keys once so history does not animate on load. */
export function useSeedChatEnterKeys(keys: string[]) {
  const ctx = useContext(ChatEnterContext)
  useLayoutEffect(() => {
    if (!ctx || keys.length === 0) return
    ctx.seedKeys(keys)
  }, [ctx, keys])
}
