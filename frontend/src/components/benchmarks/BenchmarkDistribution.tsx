import type { BenchmarkSuiteDetail } from '../../api/benchmarks'

export function BenchmarkDistribution({ suite }: { suite: BenchmarkSuiteDetail }) {
  const total = suite.total_cases || 1
  const succ = suite.completed_cases || 0
  const fail = suite.failed_cases || 0
  const pending = Math.max(0, total - succ - fail)

  const succPct = (succ / total) * 100
  const failPct = (fail / total) * 100
  const pendPct = (pending / total) * 100

  return (
    <div className="syn-bench-dist">
      <div className="syn-bench-dist__bar">
        <div
          className="syn-bench-dist__seg syn-bench-dist__seg--success"
          style={{ width: `${succPct}%` }}
        />
        <div
          className="syn-bench-dist__seg syn-bench-dist__seg--failed"
          style={{ width: `${failPct}%` }}
        />
        <div
          className="syn-bench-dist__seg syn-bench-dist__seg--pending"
          style={{ width: `${pendPct}%` }}
        />
      </div>
      <div className="syn-bench-dist__legend">
        <span className="syn-bench-dist__label syn-bench-dist__label--success">{succ} success</span>
        <span className="syn-bench-dist__label syn-bench-dist__label--failed">{fail} failed</span>
        {pending > 0 && <span className="syn-bench-dist__label">{pending} pending</span>}
      </div>
    </div>
  )
}
