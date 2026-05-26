export interface TrendPoint {
  label: string
  value: number
  run_id?: string
  created_at?: number
}

interface TrendLineProps {
  points: TrendPoint[]
  valueFormatter?: (n: number) => string
  emptyLabel?: string
}

export function TrendLine({ points, valueFormatter = (n) => n.toFixed(3), emptyLabel }: TrendLineProps) {
  if (!points.length) {
    return <div className="chart-empty muted">{emptyLabel ?? '—'}</div>
  }
  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 320
  const h = 120
  const pad = 12
  const coords = points.map((p, i) => {
    const x = pad + (i / Math.max(1, points.length - 1)) * (w - pad * 2)
    const y = pad + (1 - (p.value - min) / span) * (h - pad * 2)
    return { x, y, p }
  })
  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')

  return (
    <div className="trend-line-wrap">
      <svg className="trend-line-svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Trend line">
        <path className="trend-line-path" d={pathD} fill="none" strokeWidth="2" />
        {coords.map((c) => (
          <circle key={c.p.label + c.p.value} className="trend-line-dot" cx={c.x} cy={c.y} r="3" />
        ))}
      </svg>
      <div className="trend-line-labels">
        {points.map((p) => (
          <div key={p.label + String(p.value)} className="trend-line-label-row">
            <span className="mono muted">{p.label}</span>
            <span className="mono">{valueFormatter(p.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
