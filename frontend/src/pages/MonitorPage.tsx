import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { listRuns } from '../api/monitor'
import { EmptyState } from '../components/common/EmptyState'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { MonitorOverviewPanel } from '../components/monitor/MonitorOverviewPanel'
import { formatDuration, formatTime } from '../lib/time'

export default function MonitorPage() {
  const { data, isLoading } = useQuery({ queryKey: ['runs'], queryFn: () => listRuns({ limit: 100 }) })
  const runs = data?.runs ?? []
  return <div className="page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Monitor</h1>
        <p className="page-subtitle">Usage trends, tool reliability, and run traces (Phase 4)</p>
      </div>
    </div>
    <MonitorOverviewPanel />
    <Panel title="Recent runs">
      <table className="table">
        <thead><tr><th>Run</th><th>Type</th><th>Status</th><th>Started</th><th>Elapsed</th><th>Session</th></tr></thead>
        <tbody>{runs.map((r) => <tr key={r.id}>
          <td><Link to={`/monitor/runs/${r.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>{r.name}</Link><div className="muted mono" style={{ fontSize: 11 }}>{r.id}</div></td>
          <td className="mono">{r.run_type}</td>
          <td><StatusBadge status={r.state} /></td>
          <td className="muted">{formatTime(r.started_at)}</td>
          <td className="mono">{formatDuration(r.elapsed_ms)}</td>
          <td className="mono muted" style={{ fontSize: 11 }}>{r.session_id}</td>
        </tr>)}</tbody>
      </table>
      {!isLoading && !runs.length && <EmptyState title="No runs recorded" detail="Start a terminal task to populate monitor traces." />}
    </Panel>
  </div>
}
