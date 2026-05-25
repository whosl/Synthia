import type { ReactNode } from 'react'

/** Sticky page chrome: title, subtitle, and optional toolbar stay fixed while content scrolls. */
export function PageStickyTop({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`page-sticky-top${className ? ` ${className}` : ''}`}>{children}</div>
}
