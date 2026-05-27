import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  closeHardwareSession,
  listBitstreamArtifacts,
  openHardwareSession,
  requestProgram,
  type BitstreamArtifact,
  type ProgramJob,
} from '../api/hardware'
import { ProgramConfirmModal } from '../components/hardware/ProgramConfirmModal'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import './ProgramFlowPage.css'

export default function ProgramFlowPage() {
  const { targetId = '' } = useParams()
  const [bitArts, setBitArts] = useState<BitstreamArtifact[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [job, setJob] = useState<ProgramJob | null>(null)
  const [session, setSession] = useState<{ id: string } | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!targetId) return
    listBitstreamArtifacts()
      .then((d) => setBitArts(d.artifacts || []))
      .catch((e) => setError(String(e)))
    openHardwareSession(targetId)
      .then(setSession)
      .catch((e) => setError(String(e)))
  }, [targetId])

  const startRequest = async () => {
    if (!selected || !session) return
    setBusy(true)
    setError(null)
    try {
      const d = await requestProgram(session.id, selected)
      setJob(d.job)
      setShowConfirm(true)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const closeAndCloseSession = () => {
    setShowConfirm(false)
    if (session) {
      closeHardwareSession(session.id).catch(() => {})
    }
  }

  return (
    <div className="page syn-program-flow">
      <PageStickyTop>
        <h1 className="page-title">Program target: {targetId.slice(0, 8)}</h1>
      </PageStickyTop>
      {error && <p className="syn-error">{error}</p>}
      <Panel title="Programming flow">
        <ol className="syn-program-flow__steps">
          <li className={selected ? 'is-done' : 'is-active'}>
            <h2>1. Select .bit artifact</h2>
            <ul className="syn-art-pick">
              {bitArts.map((a) => (
                <li
                  key={a.id}
                  className={selected === a.id ? 'is-selected' : ''}
                  onClick={() => setSelected(a.id)}
                  onKeyDown={(e) => e.key === 'Enter' && setSelected(a.id)}
                  role="button"
                  tabIndex={0}
                >
                  <span>{a.path?.split(/[/\\]/).pop() ?? a.id}</span>
                  <code className="syn-mono-sm">sha256: {a.sha256?.slice(0, 12) ?? '—'}…</code>
                  {a.size_bytes != null && (
                    <span className="syn-art-pick__size">{(a.size_bytes / 1024).toFixed(0)} KB</span>
                  )}
                </li>
              ))}
              {bitArts.length === 0 && <li className="muted">No .bit artifacts found.</li>}
            </ul>
          </li>
          <li className={selected ? 'is-active' : ''}>
            <h2>2. Confirm & request approval</h2>
            <button
              type="button"
              className="syn-button syn-button--danger"
              disabled={!selected || !session || busy}
              onClick={startRequest}
            >
              {busy ? 'Requesting…' : 'Request approval'}
            </button>
          </li>
        </ol>
      </Panel>
      {showConfirm && job && (
        <ProgramConfirmModal job={job} targetId={targetId} onClose={closeAndCloseSession} />
      )}
    </div>
  )
}
