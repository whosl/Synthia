import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { detectHardwareTargets, listHardwareTargets, type HardwareTarget } from '../api/hardware'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { formatTime } from '../lib/time'
import './HardwarePage.css'

export default function HardwarePage() {
  const [targets, setTargets] = useState<HardwareTarget[]>([])
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    listHardwareTargets()
      .then((d) => setTargets(d.targets || []))
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const detect = async () => {
    setDetecting(true)
    setError(null)
    try {
      await detectHardwareTargets()
      refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="page syn-hw">
      <PageStickyTop>
        <div className="page-header syn-hw__header">
          <div>
            <h1 className="page-title">Hardware Targets</h1>
            <p className="page-subtitle">Detect boards, open sessions, and program bitstreams</p>
          </div>
          <button
            type="button"
            className="syn-button syn-button--primary"
            onClick={detect}
            disabled={detecting}
          >
            {detecting ? 'Detecting…' : 'Detect'}
          </button>
        </div>
      </PageStickyTop>
      {error && <p className="syn-error">{error}</p>}
      <Panel title="Targets">
        <table className="syn-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Part</th>
              <th>State</th>
              <th>Host</th>
              <th>Serial</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <code>{t.part}</code>
                </td>
                <td>
                  <span className={`syn-pill syn-pill--${t.state}`}>{t.state}</span>
                </td>
                <td>{t.host || '—'}</td>
                <td>
                  <code className="syn-mono-sm">{t.serial}</code>
                </td>
                <td className="muted">{t.last_seen_at ? formatTime(t.last_seen_at) : '—'}</td>
                <td>
                  {t.state === 'available' && (
                    <Link to={`/hardware/${t.id}/program`} style={{ color: 'var(--accent)' }}>
                      Program…
                    </Link>
                  )}
                </td>
              </tr>
            ))}
            {targets.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No targets — click Detect or register manually via API.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}
