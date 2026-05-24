import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  GitBranch,
  Layers,
  Play,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  approveEvolutionCandidate,
  type EvolutionCandidate,
  type EvolutionCandidateStatus,
  type EvolutionOverlay,
  type EvolutionSurface,
  listEvolutionCandidates,
  listEvolutionOverlays,
  mergeEvolutionCandidate,
  rejectEvolutionCandidate,
  retireEvolutionOverlay,
  rollbackEvolutionCandidate,
  runEvolutionGenerators,
} from '../api/evolution'
import { listProjects } from '../api/projects'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { Modal } from '../components/common/Modal'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { formatTime } from '../lib/time'

const SURFACE_LABELS: Record<EvolutionSurface, string> = {
  kb: 'Knowledge Base',
  prompt: 'System Prompt',
  tool: 'Tool Set',
  flow_template: 'Tcl Flow Template',
  routing: 'Agent Routing',
}

const SURFACE_OPTIONS: Array<{ value: '' | EvolutionSurface; label: string }> = [
  { value: '', label: 'All surfaces' },
  { value: 'prompt', label: 'Prompt' },
  { value: 'kb', label: 'KB' },
  { value: 'flow_template', label: 'Flow template' },
  { value: 'routing', label: 'Routing' },
  { value: 'tool', label: 'Tool' },
]

const STATUS_OPTIONS: Array<{ value: '' | EvolutionCandidateStatus; label: string }> = [
  { value: 'pending', label: 'Pending review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'merged', label: 'Merged' },
  { value: 'rolled_back', label: 'Rolled back' },
  { value: 'trialing', label: 'In trial' },
  { value: '', label: 'All statuses' },
]

const SUPPRESS_OPTIONS = [
  { value: 0, label: 'No suppression' },
  { value: 7, label: 'Silence 7 days' },
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
]

function pickProject<T extends { id: string; name?: string }>(rows: T[], id: string): T | undefined {
  return rows.find((r) => r.id === id)
}

function previewPayload(candidate: EvolutionCandidate): string {
  const signal = candidate.signal_source || {}
  const meta = candidate.metadata || {}
  const body = {
    surface: candidate.surface,
    scope: candidate.scope,
    signal,
    metadata: meta,
  }
  return JSON.stringify(body, null, 2)
}

export default function EvolutionPage() {
  const [status, setStatus] = useState<EvolutionCandidateStatus | ''>('pending')
  const [surface, setSurface] = useState<EvolutionSurface | ''>('')
  const [projectId, setProjectId] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const qc = useQueryClient()

  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: () => listProjects({ limit: 200 }) })
  // Background polling so generators firing from other sessions become visible
  // without explicit user action. /api/v1/sessions/{id}/stream is per-session,
  // and the evolution page spans all sessions, so a 6s poll is the simplest path.
  const candidatesQ = useQuery({
    queryKey: ['evolution', 'candidates', status, surface, projectId],
    queryFn: () =>
      listEvolutionCandidates({
        status,
        surface,
        project_id: projectId || undefined,
        limit: 200,
      }),
    refetchInterval: 6000,
    refetchOnWindowFocus: true,
  })
  const overlaysQ = useQuery({
    queryKey: ['evolution', 'overlays', projectId],
    queryFn: () =>
      listEvolutionOverlays({
        project_id: projectId || undefined,
        state: 'active',
        limit: 200,
      }),
    refetchInterval: 6000,
    refetchOnWindowFocus: true,
  })

  const candidates = candidatesQ.data?.candidates ?? []
  const overlays = overlaysQ.data?.overlays ?? []
  const selected = useMemo(
    () => candidates.find((c) => c.id === selectedId) ?? null,
    [candidates, selectedId],
  )

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['evolution'] })
  }

  const approveMut = useMutation({
    mutationFn: (id: string) => approveEvolutionCandidate(id, { reviewed_by: 'user' }),
    onSuccess: refresh,
  })
  const rejectMut = useMutation({
    mutationFn: (args: { id: string; suppressDays: number; reason: string }) =>
      rejectEvolutionCandidate(args.id, {
        reviewed_by: 'user',
        suppress_days: args.suppressDays,
        reason: args.reason || undefined,
      }),
    onSuccess: refresh,
  })
  const mergeMut = useMutation({
    mutationFn: (id: string) => mergeEvolutionCandidate(id, { reviewed_by: 'user' }),
    onSuccess: refresh,
  })
  const rollbackMut = useMutation({
    mutationFn: (args: { id: string; reason: string }) =>
      rollbackEvolutionCandidate(args.id, { reviewed_by: 'user', reason: args.reason || undefined }),
    onSuccess: refresh,
  })
  const retireOverlayMut = useMutation({
    mutationFn: (id: string) => retireEvolutionOverlay(id),
    onSuccess: refresh,
  })
  const runGeneratorsMut = useMutation({
    mutationFn: () => runEvolutionGenerators({ project_id: projectId || undefined }),
    onSuccess: refresh,
  })

  return (
    <div className="page evolution-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Evolution</h1>
          <p className="page-subtitle">
            Review what Synthia learned. Approve a candidate to apply an overlay; rollback restores
            the previous behavior immediately.
          </p>
        </div>
        <div className="evolution-toolbar">
          <Button
            className="ghost"
            onClick={() => runGeneratorsMut.mutate()}
            disabled={runGeneratorsMut.isPending}
            title="Re-run all generators against the latest signals"
          >
            <Play size={14} /> Run generators
          </Button>
        </div>
      </div>

      <Panel
        title="Filters"
        className="evolution-filters-panel"
      >
        <div className="evolution-filters">
          <label className="evolution-filter">
            <span className="muted">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as EvolutionCandidateStatus | '')}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="evolution-filter">
            <span className="muted">Surface</span>
            <select value={surface} onChange={(e) => setSurface(e.target.value as EvolutionSurface | '')}>
              {SURFACE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="evolution-filter">
            <span className="muted">Project</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {(projectsQ.data?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.id}</option>
              ))}
            </select>
          </label>
          <span className="muted evolution-filter-count">
            {candidatesQ.isLoading ? 'Loading…' : `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`}
          </span>
        </div>
      </Panel>

      <div className="evolution-grid">
        <Panel title="Candidates">
          {!candidates.length && !candidatesQ.isLoading && (
            <EmptyState
              title="Nothing to review"
              detail={
                status === 'pending'
                  ? 'No pending candidates. Run a few tasks or click Run generators to backfill.'
                  : 'No candidates match this filter.'
              }
            />
          )}
          {!!candidates.length && (
            <ul className="evolution-list">
              {candidates.map((c) => (
                <li
                  key={c.id}
                  className={`evolution-list-item${c.id === selectedId ? ' active' : ''}`}
                >
                  <button
                    type="button"
                    className="evolution-list-row"
                    onClick={() => setSelectedId(c.id)}
                  >
                    <div className="evolution-list-row-top">
                      <span className={`evolution-surface tag-${c.surface}`}>
                        {SURFACE_LABELS[c.surface] || c.surface}
                      </span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="evolution-list-row-title">{c.title}</div>
                    <div className="evolution-list-row-meta muted">
                      <span>{c.scope}</span>
                      <span>·</span>
                      <span>{c.created_by}</span>
                      <span>·</span>
                      <span>{formatTime(c.created_at)}</span>
                      {c.confidence != null && (
                        <>
                          <span>·</span>
                          <span>conf {Math.round(Number(c.confidence) * 100)}%</span>
                        </>
                      )}
                    </div>
                  </button>
                  <ChevronRight size={14} className="evolution-list-chevron muted" />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Active overlays"
          actions={
            projectId ? (
              <span className="muted" style={{ fontSize: 11 }}>
                Project: {pickProject(projectsQ.data?.projects ?? [], projectId)?.name || projectId}
              </span>
            ) : (
              <span className="muted" style={{ fontSize: 11 }}>All projects</span>
            )
          }
        >
          {!overlays.length && (
            <EmptyState
              title="No overlays active"
              detail="Resolvers fall through to baseline until a candidate is approved."
            />
          )}
          {!!overlays.length && (
            <ul className="evolution-overlay-list">
              {overlays.map((o) => (
                <OverlayCard
                  key={o.id}
                  overlay={o}
                  onRetire={() => retireOverlayMut.mutate(o.id)}
                  retiring={retireOverlayMut.isPending && retireOverlayMut.variables === o.id}
                />
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {selected && (
        <CandidateDetailModal
          candidate={selected}
          onClose={() => setSelectedId(null)}
          onApprove={() => approveMut.mutateAsync(selected.id).then(() => setSelectedId(null))}
          onReject={(suppressDays, reason) =>
            rejectMut
              .mutateAsync({ id: selected.id, suppressDays, reason })
              .then(() => setSelectedId(null))
          }
          onMerge={() => mergeMut.mutateAsync(selected.id).then(() => setSelectedId(null))}
          onRollback={(reason) =>
            rollbackMut.mutateAsync({ id: selected.id, reason }).then(() => setSelectedId(null))
          }
          busy={
            approveMut.isPending ||
            rejectMut.isPending ||
            mergeMut.isPending ||
            rollbackMut.isPending
          }
        />
      )}
    </div>
  )
}

function OverlayCard({
  overlay,
  onRetire,
  retiring,
}: {
  overlay: EvolutionOverlay
  onRetire: () => void
  retiring: boolean
}) {
  const payload = overlay.payload || {}
  return (
    <li className="evolution-overlay-card">
      <div className="evolution-overlay-card-head">
        <span className={`evolution-surface tag-${overlay.surface}`}>
          {SURFACE_LABELS[overlay.surface] || overlay.surface}
        </span>
        <StatusBadge status={overlay.state} />
        <span className="muted" style={{ fontSize: 11 }}>{overlay.scope}</span>
      </div>
      <div className="evolution-overlay-card-name">{overlay.name || overlay.id}</div>
      <pre className="evolution-payload mono">{JSON.stringify(payload, null, 2)}</pre>
      <div className="evolution-overlay-card-foot">
        <span className="muted" style={{ fontSize: 11 }}>
          Applied {formatTime(overlay.created_at)}
          {overlay.parent_overlay_id && (
            <>
              {' · '}
              <span title={overlay.parent_overlay_id}>has parent</span>
            </>
          )}
        </span>
        <Button className="ghost" onClick={onRetire} disabled={retiring} title="Manually retire">
          <X size={14} /> Retire
        </Button>
      </div>
    </li>
  )
}

function CandidateDetailModal({
  candidate,
  onClose,
  onApprove,
  onReject,
  onMerge,
  onRollback,
  busy,
}: {
  candidate: EvolutionCandidate
  onClose: () => void
  onApprove: () => Promise<unknown>
  onReject: (suppressDays: number, reason: string) => Promise<unknown>
  onMerge: () => Promise<unknown>
  onRollback: (reason: string) => Promise<unknown>
  busy: boolean
}) {
  const [suppressDays, setSuppressDays] = useState<number>(0)
  const [rejectReason, setRejectReason] = useState<string>('')
  const [rollbackReason, setRollbackReason] = useState<string>('')

  const canApprove = candidate.status === 'pending' || candidate.status === 'trialing'
  const canReject = canApprove
  const canMerge = (candidate.status === 'pending' || candidate.status === 'approved') && candidate.scope !== 'global'
  const canRollback = candidate.status === 'approved'

  return (
    <Modal open title={candidate.title} onClose={onClose} className="evolution-modal">
      <div className="evolution-modal-meta">
        <span className={`evolution-surface tag-${candidate.surface}`}>
          {SURFACE_LABELS[candidate.surface] || candidate.surface}
        </span>
        <StatusBadge status={candidate.status} />
        <span className="muted" style={{ fontSize: 11 }}>
          {candidate.scope} · {candidate.created_by} · {formatTime(candidate.created_at)}
        </span>
        {candidate.applied_overlay_id && (
          <span className="muted mono" style={{ fontSize: 11 }} title={candidate.applied_overlay_id}>
            overlay {candidate.applied_overlay_id.slice(0, 8)}…
          </span>
        )}
      </div>

      {candidate.rationale && (
        <section className="evolution-modal-section">
          <h3 className="evolution-modal-section-title">
            <Sparkles size={14} /> Why this candidate fired
          </h3>
          <p className="evolution-rationale">{candidate.rationale}</p>
        </section>
      )}

      <section className="evolution-modal-section">
        <h3 className="evolution-modal-section-title">
          <Layers size={14} /> Signal &amp; payload
        </h3>
        <pre className="evolution-payload mono">{previewPayload(candidate)}</pre>
      </section>

      {Object.keys(candidate.metadata ?? {}).length > 0 && (
        <section className="evolution-modal-section evolution-metadata">
          {Object.entries(candidate.metadata ?? {}).map(([k, v]) => (
            <div key={k} className="evolution-metadata-row">
              <span className="muted mono">{k}</span>
              <span className="mono">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
            </div>
          ))}
        </section>
      )}

      <section className="evolution-modal-section evolution-actions-section">
        <div className="evolution-action-row">
          <Button
            className="primary"
            disabled={!canApprove || busy}
            onClick={() => onApprove()}
            title={
              canApprove ? 'Apply this candidate as an active overlay' : 'Only pending/trialing candidates can be approved'
            }
          >
            <Check size={14} /> Approve &amp; apply
          </Button>
          {canMerge && (
            <Button
              className="ghost"
              disabled={busy}
              onClick={() => onMerge()}
              title={`Promote scope (${candidate.scope} → ${candidate.scope === 'session' ? 'project' : 'global'})`}
            >
              <ArrowUpRight size={14} /> Merge to {candidate.scope === 'session' ? 'project' : 'global'}
            </Button>
          )}
          {canRollback && (
            <Button
              className="ghost"
              disabled={busy}
              onClick={() => onRollback(rollbackReason)}
              title="Retire the applied overlay and restore the parent overlay (if any)"
            >
              <RotateCcw size={14} /> Rollback overlay
            </Button>
          )}
        </div>

        {canRollback && (
          <label className="evolution-action-aux">
            <span className="muted">Rollback reason (optional)</span>
            <input
              type="text"
              value={rollbackReason}
              onChange={(e) => setRollbackReason(e.target.value)}
              placeholder="e.g. metrics regressed"
            />
          </label>
        )}

        {canReject && (
          <div className="evolution-reject-block">
            <h4 className="evolution-modal-section-title evolution-reject-title">
              <AlertTriangle size={14} /> Reject this candidate
            </h4>
            <div className="evolution-reject-row">
              <label className="evolution-action-aux">
                <span className="muted">Suppression window</span>
                <select
                  value={suppressDays}
                  onChange={(e) => setSuppressDays(Number(e.target.value))}
                >
                  {SUPPRESS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="evolution-action-aux evolution-action-aux-grow">
                <span className="muted">Reason (optional)</span>
                <input
                  type="text"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="e.g. noisy signal"
                />
              </label>
              <Button
                className="danger"
                disabled={busy}
                onClick={() => onReject(suppressDays, rejectReason)}
              >
                <X size={14} /> Reject
              </Button>
            </div>
            {suppressDays > 0 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Generator will not re-fire the same signal for {suppressDays} day{suppressDays === 1 ? '' : 's'}.
              </p>
            )}
          </div>
        )}

        {candidate.status === 'rejected' && (candidate.metadata as Record<string, unknown> | undefined)?.suppressed_until ? (
          <p className="muted" style={{ fontSize: 12 }}>
            <GitBranch size={12} /> Suppressed until{' '}
            {formatTime(Number((candidate.metadata as Record<string, unknown>).suppressed_until))}
          </p>
        ) : null}
      </section>
    </Modal>
  )
}
