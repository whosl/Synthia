import { useCallback, useRef, type MouseEvent } from 'react'

export function useLongPress(onLongPress: () => void, delayMs = 480) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firedRef = useRef(false)

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const onPointerDown = useCallback(() => {
    firedRef.current = false
    clear()
    timerRef.current = setTimeout(() => {
      firedRef.current = true
      onLongPress()
    }, delayMs)
  }, [clear, delayMs, onLongPress])

  const onPointerUp = useCallback(() => {
    clear()
  }, [clear])

  const onPointerLeave = useCallback(() => {
    clear()
  }, [clear])

  const onPointerCancel = useCallback(() => {
    clear()
  }, [clear])

  const onClickCapture = useCallback((e: MouseEvent) => {
    if (firedRef.current) {
      e.preventDefault()
      e.stopPropagation()
      firedRef.current = false
    }
  }, [])

  return {
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
    onClickCapture,
  }
}
