import { useCallback, useEffect, useState } from 'react'
import { approvePatch, getPatch, rejectPatch, type PatchRecord } from '../../api/patches'
import { canUserDo, useMe } from '../../hooks/usePermissions'
import { Button } from '../common/Button'
import { DiffViewer } from './DiffViewer'

export interface PatchApprovalCardProps {
  patchId: string
  onResolved?: () => void
}

export function PatchApprovalCard({ patchId, onResolved }: PatchApprovalCardProps) {
  const [patch, setPatch] = useState<PatchRecord | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const me = useMe()

  const load = useCallback(async () => {
    if (!patchId) return
    const data = await getPatch(patchId)
    setPatch(data.patch)
  }, [patchId])

  useEffect(() => {
    load().catch((e: unknown) => setError(String(e)))
  }, [load])

  if (!patch) {
    return <div className="patch-card patch-card--loading">Loading patch…</div>
  }

  const risk = patch.risk_assessment || {}
  const overall = typeof risk === 'object' && risk.overall ? String(risk.overall) : patch.risk_level
  const requiresStrong = Boolean(
    typeof risk === 'object' && risk.requires_strong_approval,
  )
  const isTerminal = ['applied', 'rejected', 'reverted', 'superseded'].includes(patch.state)
  const canApprove = canUserDo(
    me,
    requiresStrong ? 'patch.approve' : 'patch.approve.low',
  )
  const canReject = canUserDo(me, 'patch.reject')

  const decide = async (action: 'approve' | 'reject') => {
    if (requiresStrong && action === 'approve' && !reason.trim()) {
      setError('Strong approval requires a reason')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result =
        action === 'approve'
          ? await approvePatch(patchId, reason)
          : await rejectPatch(patchId, reason)
      setPatch(result.patch)
      onResolved?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`patch-card patch-card--${overall}`}>
      <div className="patch-card__header">
        <span className={`patch-card__risk patch-card__risk--${overall}`}>{overall}</span>
        <strong className="patch-card__title">{patch.title}</strong>
        <span className="patch-card__state">{patch.state}</span>
      </div>
      {patch.rationale && <p className="patch-card__rationale">{patch.rationale}</p>}
      <div className="patch-card__changes">
        {(patch.changes || []).map((c, i) => (
          <DiffViewer key={`${c.path}-${i}`} diffText={c.diff_text || ''} filename={c.path} />
        ))}
      </div>
      {!isTerminal && (
        <>
          {requiresStrong && (
            <textarea
              className="patch-card__reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Reason required for RTL changes"
            />
          )}
          {error && <div className="patch-card__error">{error}</div>}
          <div className="patch-card__actions">
            {canReject && (
              <Button className="ghost" disabled={busy} onClick={() => decide('reject')}>
                Reject
              </Button>
            )}
            {canApprove && (
              <Button className="primary" disabled={busy} onClick={() => decide('approve')}>
                {busy ? '…' : 'Approve & Apply'}
              </Button>
            )}
            {!canApprove && !canReject && (
              <span className="patch-card__muted">You do not have permission to approve this patch.</span>
            )}
          </div>
        </>
      )}
      {patch.state === 'applied' && patch.spawned_run_id && (
        <div className="patch-card__rerun">Applied · spawned run {patch.spawned_run_id}</div>
      )}
    </div>
  )
}
