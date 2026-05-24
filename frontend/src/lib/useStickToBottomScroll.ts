import { type DependencyList, useCallback, useLayoutEffect, useRef } from 'react'

const DEFAULT_THRESHOLD_PX = 96

export function isScrollNearBottom(el: HTMLElement, thresholdPx = DEFAULT_THRESHOLD_PX): boolean {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  return distance <= thresholdPx
}

/**
 * Auto-scroll only while the user is already near the bottom (or after pinToBottom).
 */
export function useStickToBottomScroll(
  scrollDeps: DependencyList,
  options?: { thresholdPx?: number },
) {
  const ref = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const skipTrackRef = useRef(false)
  const thresholdPx = options?.thresholdPx ?? DEFAULT_THRESHOLD_PX

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = ref.current
    if (!el) return
    skipTrackRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  const pinToBottom = useCallback(() => {
    stickRef.current = true
    scrollToBottom()
  }, [scrollToBottom])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (skipTrackRef.current) {
      skipTrackRef.current = false
      stickRef.current = isScrollNearBottom(el, thresholdPx)
      return
    }
    stickRef.current = isScrollNearBottom(el, thresholdPx)
  }, [thresholdPx])

  useLayoutEffect(() => {
    if (!stickRef.current) return
    scrollToBottom()
  }, [scrollToBottom, ...scrollDeps])

  return { ref, onScroll, pinToBottom, scrollToBottom }
}
