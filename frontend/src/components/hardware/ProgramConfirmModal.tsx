import { useEffect, useState } from 'react'
import { approveProgram, getProgramJob, rejectProgram, type ProgramJob } from '../../api/hardware'
import { getApiToken } from '../../api/client'
import './ProgramConfirmModal.css'

interface Props {
  job: ProgramJob
  targetId: string
  onClose: () => void
}

export function ProgramConfirmModal({ job, targetId, onClose }: Props) {
  const [currentJob, setCurrentJob] = useState<ProgramJob>(job)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    const t = window.setInterval(() => {
      getProgramJob(job.id)
        .then((d) => {
          setCurrentJob(d)
          if (['succeeded', 'failed', 'aborted'].includes(d.state)) {
            window.clearInterval(t)
          }
        })
        .catch(() => {})
    }, 2000)
    return () => window.clearInterval(t)
  }, [job.id])

  const approve = async () => {
    if (!reason.trim() || !confirmed) {
      setError('reason and explicit confirmation required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const d = await approveProgram(job.id, reason)
      setCurrentJob(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    await rejectProgram(job.id, reason || 'cancelled')
    onClose()
  }

  const state = currentJob.state
  const isTerminal = ['succeeded', 'failed', 'aborted'].includes(state)
  const token = getApiToken()
  const logHref =
    currentJob.log_artifact_id && token
      ? `/api/v1/artifacts/${currentJob.log_artifact_id}/download`
      : undefined

  return (
    <div className="syn-modal-backdrop" role="presentation">
      <div className="syn-modal syn-modal--danger" role="dialog" aria-modal="true">
        <h2>Hardware programming approval</h2>
        <div className="syn-program-confirm__details">
          <div>
            <strong>Target:</strong> <code>{targetId}</code>
          </div>
          <div>
            <strong>Bitstream sha256:</strong> <code>{currentJob.bitstream_sha256}</code>
          </div>
          <div>
            <strong>File:</strong>{' '}
            <code>{currentJob.bitstream_path?.split(/[/\\]/).pop()}</code>
          </div>
          <div>
            <strong>State:</strong>{' '}
            <span className={`syn-pill syn-pill--${state}`}>{state}</span>
          </div>
          {currentJob.error_message && (
            <div className="syn-program-confirm__err">Error: {currentJob.error_message}</div>
          )}
        </div>
        {state === 'pending_approval' && (
          <>
            <p className="syn-warning">
              You are about to flash this bitstream to a physical FPGA. This is irreversible.
              Verify the sha256, target ownership, and board power before approving.
            </p>
            <label className="syn-program-confirm__checkbox">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I confirm I have verified the above
            </label>
            <textarea
              className="syn-program-confirm__reason"
              placeholder="Reason for this programming (will be audited)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
            {error && <div className="syn-error">{error}</div>}
            <div className="syn-modal__actions">
              <button type="button" className="syn-button" onClick={reject}>
                Cancel
              </button>
              <button
                type="button"
                className="syn-button syn-button--danger"
                disabled={busy || !confirmed || !reason.trim()}
                onClick={approve}
              >
                {busy ? 'Programming…' : 'Approve & Flash'}
              </button>
            </div>
          </>
        )}
        {state === 'programming' && (
          <div className="syn-program-confirm__progress">Programming in progress… (30–60s typical)</div>
        )}
        {isTerminal && (
          <div className="syn-modal__actions">
            <button type="button" className="syn-button syn-button--primary" onClick={onClose}>
              Close
            </button>
            {logHref && (
              <a className="syn-button" href={logHref} download>
                Download log
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
