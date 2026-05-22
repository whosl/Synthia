export function Panel({ title, actions, children }: { title?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return <div className="panel">
    {title && <div className="panel-header"><span>{title}</span>{actions}</div>}
    <div className="panel-body">{children}</div>
  </div>
}
