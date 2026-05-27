import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { listBenchmarkSuites } from '../api/benchmarks'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { formatTime } from '../lib/time'
import './BenchmarksPage.css'

export default function BenchmarksPage() {
  const q = useQuery({
    queryKey: ['benchmarks'],
    queryFn: () => listBenchmarkSuites({ limit: 100 }),
    refetchInterval: 5000,
  })
  const suites = q.data?.suites ?? []

  return (
    <div className="page syn-benchmarks">
      <PageStickyTop>
        <div className="page-header">
          <h1 className="page-title">Benchmarks</h1>
          <p className="page-subtitle">Batch runs with unified metrics and exports</p>
        </div>
      </PageStickyTop>
      <Panel title="Suites">
        <table className="syn-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Progress</th>
              <th>Success</th>
              <th>Failed</th>
              <th>Created</th>
              <th>Export</th>
            </tr>
          </thead>
          <tbody>
            {suites.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/benchmarks/${s.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
                    {s.name}
                  </Link>
                </td>
                <td>
                  <span className={`syn-pill syn-pill--${s.state}`}>{s.state}</span>
                </td>
                <td>
                  {(s.completed_cases ?? 0) + (s.failed_cases ?? 0)}/{s.total_cases}
                </td>
                <td className="syn-cell--success">{s.completed_cases}</td>
                <td className="syn-cell--danger">{s.failed_cases}</td>
                <td className="muted">{formatTime(s.created_at)}</td>
                <td className="muted">
                  <a href={`/api/v1/benchmarks/${s.id}/export/csv`}>CSV</a>
                  {' · '}
                  <a href={`/api/v1/benchmarks/${s.id}/export/zip`}>ZIP</a>
                </td>
              </tr>
            ))}
            {!suites.length && !q.isLoading && (
              <tr>
                <td colSpan={7} className="muted">
                  No benchmark suites yet. Use CLI: edagent benchmark run …
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}
