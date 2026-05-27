import { Link } from 'react-router-dom'
import type { BenchmarkCaseRow } from '../../api/benchmarks'

export function BenchmarkTable({ cases }: { cases: BenchmarkCaseRow[] }) {
  return (
    <table className="syn-table syn-bench-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Name</th>
          <th>State</th>
          <th>WNS</th>
          <th>LUT</th>
          <th>FF</th>
          <th>BRAM</th>
          <th>DSP</th>
          <th>Bit</th>
          <th>Time</th>
          <th>Run</th>
        </tr>
      </thead>
      <tbody>
        {cases.map((c) => {
          const m = (c.metrics || {}) as Record<string, unknown>
          return (
            <tr key={c.id} className={`syn-bench-row syn-bench-row--${c.state}`}>
              <td>{c.sequence}</td>
              <td>{c.name}</td>
              <td>
                <span className={`syn-pill syn-pill--${c.state}`}>{c.state}</span>
              </td>
              <td>{fmt(m.WNS)}</td>
              <td>{fmt(m.LUT)}</td>
              <td>{fmt(m.FF)}</td>
              <td>{fmt(m.BRAM)}</td>
              <td>{fmt(m.DSP)}</td>
              <td>{m.bitstream_exists ? '✓' : '—'}</td>
              <td>{((c.elapsed_ms || 0) / 1000).toFixed(1)}s</td>
              <td>
                {c.run_id ? (
                  <Link to={`/runs/${c.run_id}`} style={{ color: 'var(--accent)' }}>
                    open
                  </Link>
                ) : (
                  ''
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  return String(v)
}
