export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return <div className={className ? `panel ${className}` : 'panel'}>
    {title && <div className="panel-header"><span>{title}</span>{actions}</div>}
    <div className="panel-body">{children}</div>
  </div>
}
