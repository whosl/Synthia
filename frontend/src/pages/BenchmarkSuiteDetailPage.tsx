import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { getBenchmarkSuite, runBenchmarkSuite } from '../api/benchmarks'
import { BenchmarkDistribution } from '../components/benchmarks/BenchmarkDistribution'
import { BenchmarkTable } from '../components/benchmarks/BenchmarkTable'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import './BenchmarksPage.css'

export default function BenchmarkSuiteDetailPage() {
  const { suiteId = '' } = useParams()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['benchmark', suiteId],
    queryFn: () => getBenchmarkSuite(suiteId),
    enabled: !!suiteId,
    refetchInterval: 5000,
  })
  const suite = q.data

  const runMut = useMutation({
    mutationFn: () => runBenchmarkSuite(suiteId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['benchmark', suiteId] }),
  })

  if (!suite) {
    return <div className="page muted">Loading…</div>
  }

  const canRun = suite.state === 'draft' || suite.state === 'cancelled' || suite.state === 'completed' || suite.state === 'partial'

  return (
    <div className="page syn-bench-detail">
      <PageStickyTop>
        <div className="page-header" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <h1 className="page-title">{suite.name}</h1>
          <span className={`syn-pill syn-pill--${suite.state}`}>{suite.state}</span>
          {canRun && (
            <button
              type="button"
              className="syn-button syn-button--primary"
              disabled={runMut.isPending || suite.state === 'running' || suite.state === 'queued'}
              onClick={() => runMut.mutate()}
            >
              Run Suite
            </button>
          )}
        </div>
      </PageStickyTop>

      <BenchmarkDistribution suite={suite} />

      <Panel title="Cases">
        <BenchmarkTable cases={suite.cases ?? []} />
      </Panel>

      <div className="syn-bench-detail__exports muted">
        Export:{' '}
        <a href={`/api/v1/benchmarks/${suiteId}/export/markdown`} download>
          Markdown
        </a>
        {' · '}
        <a href={`/api/v1/benchmarks/${suiteId}/export/csv`} download>
          CSV
        </a>
        {' · '}
        <a href={`/api/v1/benchmarks/${suiteId}/export/json`} download>
          JSON
        </a>
        {' · '}
        <a href={`/api/v1/benchmarks/${suiteId}/export/zip`} download>
          ZIP
        </a>
      </div>
    </div>
  )
}
