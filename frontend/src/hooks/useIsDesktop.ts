import { useEffect, useState } from 'react'

const QUERY = '(min-width: 769px)'

export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(QUERY).matches : true,
  )

  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const onChange = () => setDesktop(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return desktop
}
