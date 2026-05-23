export interface BarChartItem {
  label: string
  value: number
  hint?: string
}

interface BarChartProps {
  items: BarChartItem[]
  valueFormatter?: (n: number) => string
  emptyLabel?: string
}

export function BarChart({ items, valueFormatter = (n) => String(n), emptyLabel = 'No data' }: BarChartProps) {
  const max = Math.max(1, ...items.map((i) => i.value))
  if (!items.length) {
    return <div className="chart-empty muted">{emptyLabel}</div>
  }
  return (
    <div className="bar-chart" role="img" aria-label="Bar chart">
      {items.map((item) => (
        <div className="bar-chart-row" key={item.label} title={item.hint || item.label}>
          <span className="bar-chart-label mono">{item.label}</span>
          <div className="bar-chart-track">
            <div
              className="bar-chart-fill"
              style={{ width: `${Math.max(4, (item.value / max) * 100)}%` }}
            />
          </div>
          <span className="bar-chart-value mono">{valueFormatter(item.value)}</span>
        </div>
      ))}
    </div>
  )
}
