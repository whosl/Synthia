import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart } from './BarChart'
import { getMonitorOverview, runMonitorCleanup, type MonitorOverview } from '../../api/monitor'
import { Button } from '../common/Button'
import { Panel } from '../common/Panel'
import { formatNumber } from '../../lib/time'

function pct(rate: number) {
  return `${(rate * 100).toFixed(1)}%`
}

function overviewCharts(overview: MonitorOverview) {
  const tokenItems = overview.token_series.map((d) => ({
    label: d.day.slice(5),
    value: d.total_tokens,
    hint: `${d.day}: in ${d.input_tokens} / out ${d.output_tokens}`,
  }))
  const modelItems = overview.by_model.map((m) => ({
    label: m.model.length > 18 ? `${m.model.slice(0, 16)}…` : m.model,
    value: m.total_tokens,
    hint: m.model,
  }))
  return { tokenItems, modelItems }
}

export function MonitorOverviewPanel() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['monitor-overview', 14],
    queryFn: () => getMonitorOverview(14),
  })
  const cleanup = useMutation({
    mutationFn: () => runMonitorCleanup({ retention_days: 90, dry_run: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitor-overview'] }),
  })
  const overview = data
  const { tokenItems, modelItems } = overview ? overviewCharts(overview) : { tokenItems: [], modelItems: [] }

  return (
    <div className="monitor-overview">
      <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <div className="metric-card">
          <div className="metric-label">Runs (14d)</div>
          <div className="metric-value">{isLoading ? '…' : formatNumber(overview?.run_count ?? 0)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Tokens (14d)</div>
          <div className="metric-value">
            {isLoading ? '…' : formatNumber(
              (overview?.usage_totals.input_tokens ?? 0) + (overview?.usage_totals.output_tokens ?? 0),
            )}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Tool error rate</div>
          <div className="metric-value">
            {isLoading ? '…' : pct(overview?.tool_calls.error_rate ?? 0)}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {overview?.tool_calls.errors ?? 0} / {overview?.tool_calls.total ?? 0} calls
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Problems (14d)</div>
          <div className="metric-value">{isLoading ? '…' : formatNumber(overview?.problems ?? 0)}</div>
        </div>
      </div>
      <div className="dashboard-grid">
        <Panel title="Token trend (14 days)">
          <BarChart items={tokenItems} valueFormatter={formatNumber} emptyLabel="No LLM usage in window" />
        </Panel>
        <Panel title="Tokens by model">
          <BarChart items={modelItems} valueFormatter={formatNumber} emptyLabel="No model breakdown yet" />
        </Panel>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button
          className="ghost"
          disabled={cleanup.isPending}
          onClick={() => cleanup.mutate()}
          title="Preview rows older than 90 days (dry run)"
        >
          {cleanup.isPending ? 'Checking…' : 'Preview retention cleanup'}
        </Button>
        {cleanup.data && (
          <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
            Would delete: events {cleanup.data.deleted.events}, usage {cleanup.data.deleted.llm_usage},
            tools {cleanup.data.deleted.tool_calls}, problems {cleanup.data.deleted.problems}
          </span>
        )}
      </div>
    </div>
  )
}
