import type { PropsWithChildren } from 'react'
import { clsx } from 'clsx'

export function Panel({ title, actions, children, className }: PropsWithChildren<{ title?: string; actions?: React.ReactNode; className?: string }>) {
  return <section className={clsx('panel', className)}>
    {title && <div className="panel-header"><span>{title}</span><span>{actions}</span></div>}
    <div className="panel-body">{children}</div>
  </section>
}
