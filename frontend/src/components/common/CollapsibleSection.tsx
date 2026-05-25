/** Height animation via CSS grid 0fr → 1fr (respects prefers-reduced-motion in CSS). */

export function CollapsibleSection({
  open,
  children,
  className = '',
  innerClassName = '',
}: {
  open: boolean
  children: React.ReactNode
  className?: string
  innerClassName?: string
}) {
  return (
    <div
      className={`collapse-section${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden={!open}
    >
      <div className={`collapse-section-inner${innerClassName ? ` ${innerClassName}` : ''}`}>
        {children}
      </div>
    </div>
  )
}
