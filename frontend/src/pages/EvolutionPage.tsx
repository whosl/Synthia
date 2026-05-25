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
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import {
  abortEvolutionTrial,
  approveEvolutionCandidate,
  decideEvolutionTrial,
  type EvalRun,
  type EvalSetDescriptor,
  type EvolutionCandidate,
  type EvolutionCandidateStatus,
  type EvolutionOverlay,
  type EvolutionSurface,
  type EvolutionTrial,
  getEvolutionConfig,
  getEvolutionCandidate,
  getEvolutionCandidatePreview,
  type EvolutionCandidatePreview,
  listEvalRuns,
  listEvalSets,
  listEvolutionCandidates,
  listEvolutionOverlays,
  listEvolutionTrials,
  mergeEvolutionCandidate,
  queueEvalRun,
  rejectEvolutionCandidate,
  retireEvolutionOverlay,
  rollbackEvolutionCandidate,
  runEvolutionGenerators,
  setEvolutionTrialFlag,
} from '../api/evolution'
import { listProjects } from '../api/projects'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Modal } from '../components/common/Modal'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { formatTime } from '../lib/time'
import { buildLocalApplyPreview } from '../lib/evolutionPreview'
import { EvolutionKbTab } from './EvolutionKbTab'

type EvolutionTab = 'candidates' | 'overlays' | 'trials' | 'kb'

const TAB_IDS: EvolutionTab[] = ['candidates', 'overlays', 'trials', 'kb']

function parseTab(value: string | null): EvolutionTab {
  if (value && TAB_IDS.includes(value as EvolutionTab)) return value as EvolutionTab
  return 'candidates'
}

const SURFACE_KEY_MAP: Record<EvolutionSurface, string> = {
  kb: 'evolution.surfaces.knowledgeBase',
  prompt: 'evolution.surfaces.systemPrompt',
  tool: 'evolution.surfaces.toolSet',
  flow_template: 'evolution.surfaces.tclFlowTemplate',
  routing: 'evolution.surfaces.agentRouting',
}

function pickProject<T extends { id: string; name?: string }>(rows: T[], id: string): T | undefined {
  return rows.find((r) => r.id === id)
}

function ApplyPreviewSection({
  candidate,
}: {
  candidate: EvolutionCandidate
}) {
  const { t } = useTranslation()
  const showPreview = candidate.status === 'pending' || candidate.status === 'trialing'
  const previewQ = useQuery({
    queryKey: ['evolution-candidate-preview', candidate.id],
    queryFn: async () => {
      try {
        const remote = await getEvolutionCandidatePreview(candidate.id)
        return { preview: remote.preview, source: 'server' as const }
      } catch {
        try {
          const detail = await getEvolutionCandidate(candidate.id)
          if (detail.candidate.apply_preview) {
            return { preview: detail.candidate.apply_preview, source: 'server' as const }
          }
        } catch {
          // fall through to local synthesis
        }
        return { preview: buildLocalApplyPreview(candidate), source: 'local' as const }
      }
    },
    enabled: showPreview,
  })

  if (!showPreview) return null

  const preview = previewQ.data?.preview
  const previewSource = previewQ.data?.source

  return (
    <section className="evolution-modal-section evolution-apply-preview">
      <h3 className="evolution-modal-section-title">
        <Check size={14} /> {t('evolution.applyPreview')}
        {previewSource === 'local' && (
          <span className="evolution-apply-preview-tag" title={t('evolution.previewTooltip')}>
            {t('evolution.localEstimate')}
          </span>
        )}
      </h3>
      {previewQ.isLoading && (
        <p className="muted evolution-apply-preview-loading">{t('evolution.loadingPreview')}</p>
      )}
      {previewQ.isError && !preview && (
        <p className="evolution-apply-preview-error">
          {t('evolution.previewError')}
        </p>
      )}
      {preview && (
        <ApplyPreviewBody preview={preview} candidate={candidate} />
      )}
    </section>
  )
}

function ApplyPreviewBody({
  preview,
  candidate,
}: {
  preview: EvolutionCandidatePreview
  candidate: EvolutionCandidate
}) {
  const { t } = useTranslation()

  if (candidate.surface === 'prompt') {
    const mode = preview.prompt_mode || 'append'
    const text = preview.prompt_text || ''
    return (
      <>
        <p className="muted evolution-apply-preview-hint">
          {preview.prompt_effect || t('evolution.promptEffect')}
        </p>
        <div className="evolution-apply-preview-meta">
          <span className="evolution-apply-preview-tag">{t('evolution.mode')}: {mode}</span>
        </div>
        {text ? (
          <pre className="evolution-payload mono evolution-prompt-preview">{text}</pre>
        ) : (
          <p className="muted">{t('evolution.noPromptText')}</p>
        )}
      </>
    )
  }

  if (candidate.surface === 'flow_template' && preview.flow_templates) {
    const entries = Object.entries(preview.flow_templates)
    if (!entries.length) {
      return <p className="muted">{t('evolution.noFlowTemplates')}</p>
    }
    return (
      <>
        <p className="muted evolution-apply-preview-hint">
          {t('evolution.flowTemplateHint')}
        </p>
        {entries.map(([name, body]) => (
          <div key={name} className="evolution-flow-template-block">
            <div className="evolution-apply-preview-meta">
              <span className="evolution-apply-preview-tag">{name}</span>
            </div>
            <pre className="evolution-payload mono">{body}</pre>
          </div>
        ))}
      </>
    )
  }

  if (candidate.surface === 'routing') {
    const rules = preview.routing_rules || []
    const weights = preview.routing_weights || {}
    return (
      <>
        <p className="muted evolution-apply-preview-hint">
          {t('evolution.routingHint')}
        </p>
        {!!Object.keys(weights).length && (
          <>
            <div className="evolution-apply-preview-meta">
              <span className="evolution-apply-preview-tag">{t('evolution.weights')}</span>
            </div>
            <pre className="evolution-payload mono">{JSON.stringify(weights, null, 2)}</pre>
          </>
        )}
        {!!rules.length && (
          <>
            <div className="evolution-apply-preview-meta">
              <span className="evolution-apply-preview-tag">{t('evolution.rules')}</span>
            </div>
            <pre className="evolution-payload mono">{JSON.stringify(rules, null, 2)}</pre>
          </>
        )}
        {!rules.length && !Object.keys(weights).length && (
          <p className="muted">{t('evolution.routingEmpty')}</p>
        )}
      </>
    )
  }

  if (candidate.surface === 'kb') {
    const kbPreview = (preview.payload.kb_case_preview || {}) as Record<string, unknown>
    return (
      <>
        <p className="muted evolution-apply-preview-hint">
          {t('evolution.kbHint')}
        </p>
        <pre className="evolution-payload mono">{JSON.stringify(kbPreview, null, 2)}</pre>
      </>
    )
  }

  if (candidate.surface === 'tool') {
    if (preview.validation_error) {
      return (
        <>
          <p className="evolution-apply-preview-error">{preview.validation_error}</p>
          <pre className="evolution-payload mono">{JSON.stringify(preview.payload, null, 2)}</pre>
        </>
      )
    }
    return (
      <>
        <p className="muted evolution-apply-preview-hint">
          {t('evolution.toolHint')}
        </p>
        <pre className="evolution-payload mono">{JSON.stringify(preview.payload, null, 2)}</pre>
      </>
    )
  }

  return (
    <pre className="evolution-payload mono">{JSON.stringify(preview.payload, null, 2)}</pre>
  )
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

interface ToolSourceEntry {
  name: string
  description: string
  source: string
}

function extractToolSources(candidate: EvolutionCandidate): ToolSourceEntry[] {
  const signal = candidate.signal_source as Record<string, unknown> | undefined
  const meta = candidate.metadata as Record<string, unknown> | undefined
  const containers: unknown[] = []
  const fromSignal = (signal?.suggested_payload as Record<string, unknown> | undefined)?.additional_tools
  if (Array.isArray(fromSignal)) containers.push(...fromSignal)
  const fromMeta = (meta?.suggested_payload as Record<string, unknown> | undefined)?.additional_tools
  if (Array.isArray(fromMeta)) containers.push(...fromMeta)
  const seen = new Set<string>()
  const out: ToolSourceEntry[] = []
  for (const raw of containers) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name : ''
    const source = typeof entry.source === 'string' ? entry.source : ''
    if (!name || !source || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      description: typeof entry.description === 'string' ? entry.description : '',
      source,
    })
  }
  return out
}

export default function EvolutionPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = parseTab(searchParams.get('tab'))
  const [status, setStatus] = useState<EvolutionCandidateStatus | ''>('pending')
  const [surface, setSurface] = useState<EvolutionSurface | ''>('')
  const [projectId, setProjectId] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const setActiveTab = (tab: EvolutionTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (tab === 'candidates') next.delete('tab')
      else next.set('tab', tab)
      return next
    }, { replace: true })
  }

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

  const configQ = useQuery({
    queryKey: ['evolution', 'config', projectId],
    queryFn: () => getEvolutionConfig(projectId || undefined),
    refetchOnWindowFocus: true,
  })

  const trialsQ = useQuery({
    queryKey: ['evolution', 'trials', projectId],
    queryFn: () =>
      listEvolutionTrials({
        project_id: projectId || undefined,
        state: 'running',
        limit: 50,
      }),
    refetchInterval: 6000,
    refetchOnWindowFocus: true,
  })

  const evalSetsQ = useQuery({
    queryKey: ['evolution', 'eval-sets'],
    queryFn: () => listEvalSets(),
    refetchOnWindowFocus: false,
  })

  const evalRunsQ = useQuery({
    queryKey: ['evolution', 'eval-runs', projectId],
    queryFn: () => listEvalRuns({ limit: 20 }),
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
  })

  const candidates = candidatesQ.data?.candidates ?? []
  const evolutionCandidates = useMemo(
    () => candidates.filter((c) => c.surface !== 'kb'),
    [candidates],
  )
  const selectedFromList = useMemo(
    () => candidates.find((c) => c.id === selectedId) ?? null,
    [candidates, selectedId],
  )
  const selectedDetailQ = useQuery({
    queryKey: ['evolution', 'candidate-detail', selectedId],
    queryFn: () => getEvolutionCandidate(selectedId!),
    enabled: !!selectedId && !selectedFromList,
  })
  const selected = selectedFromList ?? selectedDetailQ.data?.candidate ?? null
  const overlays = overlaysQ.data?.overlays ?? []
  const trials = trialsQ.data?.trials ?? []

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['evolution'] })
    qc.invalidateQueries({ queryKey: ['kb-candidates'] })
    qc.invalidateQueries({ queryKey: ['legacy-kb'] })
  }

  const approveMut = useMutation({
    mutationFn: (args: { id: string; confirmSourceReviewed?: boolean }) =>
      approveEvolutionCandidate(args.id, {
        reviewed_by: 'user',
        confirm_source_reviewed: args.confirmSourceReviewed,
      }),
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
  const trialFlagMut = useMutation({
    mutationFn: (args: { surface: EvolutionSurface; enabled: boolean }) =>
      setEvolutionTrialFlag({
        project_id: projectId,
        surface: args.surface,
        enabled: args.enabled,
      }),
    onSuccess: refresh,
  })
  const decideTrialMut = useMutation({
    mutationFn: (args: { id: string; decision: 'variant_wins' | 'baseline_wins' | 'tie' }) =>
      decideEvolutionTrial(args.id, { decision: args.decision, reviewed_by: 'user' }),
    onSuccess: refresh,
  })
  const abortTrialMut = useMutation({
    mutationFn: (args: { id: string; reason?: string }) =>
      abortEvolutionTrial(args.id, { reason: args.reason }),
    onSuccess: refresh,
  })
  const queueEvalMut = useMutation({
    mutationFn: (args: { eval_set: string; note?: string }) =>
      queueEvalRun({
        eval_set: args.eval_set,
        project_id: projectId || undefined,
        note: args.note,
      }),
    onSuccess: refresh,
  })

  const surfaceOptions: Array<{ value: '' | EvolutionSurface; label: string }> = [
    { value: '', label: t('evolution.surfaceOptions.all') },
    { value: 'prompt', label: t('evolution.surfaceOptions.prompt') },
    { value: 'flow_template', label: t('evolution.surfaceOptions.flowTemplate') },
    { value: 'routing', label: t('evolution.surfaceOptions.routing') },
    { value: 'tool', label: t('evolution.surfaceOptions.tool') },
  ]

  const tabLabels: Record<EvolutionTab, string> = {
    candidates: t('evolution.tabs.candidates'),
    overlays: t('evolution.tabs.overlays'),
    trials: t('evolution.tabs.trials'),
    kb: t('evolution.tabs.kb'),
  }

  const tabCounts: Record<EvolutionTab, number | undefined> = {
    candidates: evolutionCandidates.length,
    overlays: overlays.length,
    trials: trials.length,
    kb: undefined,
  }

  const statusOptions: Array<{ value: '' | EvolutionCandidateStatus; label: string }> = [
    { value: 'pending', label: t('evolution.statusOptions.pendingReview') },
    { value: 'approved', label: t('evolution.statusOptions.approved') },
    { value: 'rejected', label: t('evolution.statusOptions.rejected') },
    { value: 'merged', label: t('evolution.statusOptions.merged') },
    { value: 'rolled_back', label: t('evolution.statusOptions.rolledBack') },
    { value: 'trialing', label: t('evolution.statusOptions.inTrial') },
    { value: '', label: t('evolution.statusOptions.all') },
  ]

  return (
    <div className="page evolution-page">
      <PageStickyTop>
        <div className="page-header">
          <div className="page-header-main">
            <div className="page-title-row">
              <h1 className="page-title">{t('evolution.title')}</h1>
              <Button
                className={`ghost page-header-action${runGeneratorsMut.isPending ? ' is-spinning' : ''}`}
                onClick={() => runGeneratorsMut.mutate()}
                disabled={runGeneratorsMut.isPending}
                aria-busy={runGeneratorsMut.isPending}
                title={t('evolution.runGeneratorsTooltip')}
              >
                <Play size={14} aria-hidden /> {t('evolution.runGenerators')}
              </Button>
            </div>
            <p className="page-subtitle">
              {t('evolution.subtitle')}
            </p>
          </div>
        </div>

        <div className="evolution-tabs" role="tablist" aria-label={t('evolution.tabs.label')}>
          {TAB_IDS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`evolution-tab${activeTab === tab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tabLabels[tab]}
              {tabCounts[tab] != null && tabCounts[tab]! > 0 && (
                <span className="evolution-tab-count">{tabCounts[tab]}</span>
              )}
            </button>
          ))}
        </div>

        {activeTab === 'candidates' && (
        <Panel className="evolution-filters-panel">
          <div className="evolution-filters">
            <label className="evolution-filter">
              <span className="muted">{t('evolution.status')}</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as EvolutionCandidateStatus | '')}>
                {statusOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="evolution-filter">
              <span className="muted">{t('evolution.surface')}</span>
              <select value={surface} onChange={(e) => setSurface(e.target.value as EvolutionSurface | '')}>
                {surfaceOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="evolution-filter">
              <span className="muted">{t('evolution.project')}</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">{t('evolution.allProjects')}</option>
                {(projectsQ.data?.projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name || p.id}</option>
                ))}
              </select>
            </label>
            <span className="muted evolution-filter-count">
              {candidatesQ.isLoading
                ? t('evolution.loading')
                : evolutionCandidates.length === 1
                  ? t('evolution.candidateCount', { n: evolutionCandidates.length, count: evolutionCandidates.length })
                  : t('evolution.candidateCount_plural', { n: evolutionCandidates.length, count: evolutionCandidates.length })
              }
            </span>
          </div>
        </Panel>
        )}
      </PageStickyTop>

      {activeTab === 'candidates' && (
        <>
          <Panel title={t('evolution.candidates')}>
            {!evolutionCandidates.length && !candidatesQ.isLoading && (
              <EmptyState
                title={t('evolution.nothingToReview')}
                detail={
                  status === 'pending'
                    ? t('evolution.noPendingCandidatesDetail')
                    : t('evolution.noMatchingCandidates')
                }
              />
            )}
            {!!evolutionCandidates.length && (
              <ul className="evolution-list">
                {evolutionCandidates.map((c) => {
                  const confPct = Math.round(Number(c.confidence) * 100)
                  return (
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
                            {t(SURFACE_KEY_MAP[c.surface]) || c.surface}
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
                              <span>{t('evolution.conf', { pct: confPct, n: confPct })}</span>
                            </>
                          )}
                        </div>
                      </button>
                      <ChevronRight size={14} className="evolution-list-chevron muted" />
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>

          <EvalSection
            sets={evalSetsQ.data?.sets ?? []}
            runs={evalRunsQ.data?.runs ?? []}
            runnerImplemented={evalSetsQ.data?.runner_implemented === true}
            onQueue={(set, note) => queueEvalMut.mutate({ eval_set: set, note })}
            busy={queueEvalMut.isPending}
          />
        </>
      )}

      {activeTab === 'overlays' && (
        <div className="evolution-tab-toolbar">
          <label className="evolution-filter">
            <span className="muted">{t('evolution.project')}</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t('evolution.allProjects')}</option>
              {(projectsQ.data?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.id}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {activeTab === 'overlays' && (
        <Panel
          title={t('evolution.activeOverlays')}
          actions={
            projectId ? (
              <span className="muted" style={{ fontSize: 11 }}>
                {t('evolution.project')}: {pickProject(projectsQ.data?.projects ?? [], projectId)?.name || projectId}
              </span>
            ) : (
              <span className="muted" style={{ fontSize: 11 }}>{t('evolution.allProjects')}</span>
            )
          }
        >
          {!overlays.length && (
            <EmptyState
              title={t('evolution.noOverlaysActive')}
              detail={t('evolution.noOverlaysDetail')}
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
      )}

      {activeTab === 'trials' && (
        <div className="evolution-tab-toolbar">
          <label className="evolution-filter">
            <span className="muted">{t('evolution.project')}</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t('evolution.allProjects')}</option>
              {(projectsQ.data?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.id}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {activeTab === 'trials' && (
        <>
          <TrialsSection
            trials={trials}
            loading={trialsQ.isLoading}
            onDecide={(id, decision) => decideTrialMut.mutate({ id, decision })}
            onAbort={(id, reason) => abortTrialMut.mutate({ id, reason })}
            busy={decideTrialMut.isPending || abortTrialMut.isPending}
          />
          {projectId && configQ.data ? (
            <TrialConfigPanel
              config={configQ.data}
              busy={trialFlagMut.isPending}
              onToggle={(surface, enabled) => trialFlagMut.mutate({ surface, enabled })}
            />
          ) : (
            <Panel title={t('evolution.abTrialSettings')}>
              <EmptyState
                title={t('evolution.trialPickProject')}
                detail={t('evolution.trialPickProjectDetail')}
              />
            </Panel>
          )}
        </>
      )}

      {activeTab === 'kb' && (
        <EvolutionKbTab onOpenEvolutionCandidate={(id) => setSelectedId(id)} />
      )}

      {selected && (
        <CandidateDetailModal
          candidate={selected}
          onClose={() => setSelectedId(null)}
          onApprove={(confirmSourceReviewed) =>
            approveMut
              .mutateAsync({ id: selected.id, confirmSourceReviewed })
              .then(() => setSelectedId(null))
          }
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

function EvalSection({
  sets,
  runs,
  runnerImplemented,
  onQueue,
  busy,
}: {
  sets: EvalSetDescriptor[]
  runs: EvalRun[]
  runnerImplemented: boolean
  onQueue: (set: string, note?: string) => void
  busy: boolean
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string>('')
  const [note, setNote] = useState<string>('')

  if (!sets.length && !runs.length) return null

  const effectiveSet = selected || (sets[0]?.name ?? '')

  return (
    <Panel
      title={t('evolution.staticEvalSet')}
      actions={
        <span className="muted" style={{ fontSize: 11 }}>
          {runnerImplemented ? t('evolution.runnerEnabled') : t('evolution.runnerPlaceholder')}
        </span>
      }
    >
      <div className="evolution-eval-launcher">
        <label className="evolution-action-aux">
          <span className="muted">{t('evolution.evalSet')}</span>
          <select
            value={effectiveSet}
            onChange={(e) => setSelected(e.target.value)}
            disabled={!sets.length || busy}
          >
            {sets.map((s) => (
              <option key={s.name} value={s.name}>{s.name} · {t('evolution.caseCount', { count: s.case_count })}</option>
            ))}
          </select>
        </label>
        <label className="evolution-action-aux evolution-action-aux-grow">
          <span className="muted">{t('evolution.noteOptional')}</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('evolution.notePlaceholder')}
            disabled={busy}
          />
        </label>
        <Button
          className="primary"
          onClick={() => effectiveSet && onQueue(effectiveSet, note)}
          disabled={!effectiveSet || busy}
          title={
            runnerImplemented
              ? t('evolution.runTooltip')
              : t('evolution.queueTooltip')
          }
        >
          <Play size={14} /> {runnerImplemented ? t('evolution.run') : t('evolution.queuePlaceholder')}
        </Button>
      </div>

      {!sets.length && (
        <EmptyState
          title={t('evolution.noEvalSets')}
          detail={t('evolution.noEvalSetsDetail')}
        />
      )}

      {!!runs.length && (
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>{t('evolution.tableEvalRun')}</th>
              <th>{t('evolution.tableSet')}</th>
              <th>{t('evolution.tableState')}</th>
              <th>{t('evolution.tableCases')}</th>
              <th>{t('evolution.tableNote')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const note = (r.metadata as Record<string, unknown> | undefined)?.note as string | undefined
              return (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 11 }}>{r.id}</td>
                  <td>{r.eval_set}</td>
                  <td><StatusBadge status={r.state} /></td>
                  <td className="mono">{r.total_cases ?? '—'}</td>
                  <td className="muted">{note || ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

function TrialsSection({
  trials,
  loading,
  onDecide,
  onAbort,
  busy,
}: {
  trials: EvolutionTrial[]
  loading: boolean
  onDecide: (id: string, decision: 'variant_wins' | 'baseline_wins' | 'tie') => void
  onAbort: (id: string, reason?: string) => void
  busy: boolean
}) {
  const { t } = useTranslation()

  if (loading) {
    return (
      <Panel title={t('evolution.activeABTrials')}>
        <p className="muted">{t('evolution.loading')}</p>
      </Panel>
    )
  }

  if (!trials.length) {
    return (
      <Panel title={t('evolution.activeABTrials')}>
        <EmptyState
          title={t('evolution.noActiveTrials')}
          detail={t('evolution.noActiveTrialsDetail')}
        />
      </Panel>
    )
  }

  return (
    <Panel
      title={t('evolution.activeABTrials')}
      actions={
        <span className="muted" style={{ fontSize: 11 }}>{trials.length} {t('evolution.running')}</span>
      }
    >
      <ul className="evolution-trial-list">
        {trials.map((trial) => {
          const baselineMean = trial.metric_baseline?.mean ?? null
          const variantMean = trial.metric_variant?.mean ?? null
          const delta = baselineMean != null && variantMean != null ? variantMean - baselineMean : null
          return (
            <li key={trial.id} className="evolution-trial-card">
              <div className="evolution-trial-head">
                <span className={`evolution-surface tag-${trial.surface}`}>
                  {t(SURFACE_KEY_MAP[trial.surface]) || trial.surface}
                </span>
                <StatusBadge status={trial.state} />
                <span className="muted" style={{ fontSize: 11 }}>
                  {t('evolution.started')} {formatTime(trial.started_at)}
                </span>
              </div>
              <div className="evolution-trial-arms">
                <div className="evolution-trial-arm">
                  <span className="muted">{t('evolution.baseline')}</span>
                  <strong>{t('evolution.samples', { n: trial.n_baseline })}</strong>
                  <span className="mono">{baselineMean != null ? baselineMean.toFixed(3) : '—'}</span>
                </div>
                <div className="evolution-trial-arm">
                  <span className="muted">{t('evolution.variant')}</span>
                  <strong>{t('evolution.samples', { n: trial.n_variant })}</strong>
                  <span className="mono">{variantMean != null ? variantMean.toFixed(3) : '—'}</span>
                </div>
                <div className="evolution-trial-delta">
                  <span className="muted">{t('evolution.deltaScore')}</span>
                  <strong className={delta != null ? (delta > 0 ? 'positive' : delta < 0 ? 'negative' : '') : ''}>
                    {delta != null ? (delta >= 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3)) : '—'}
                  </strong>
                </div>
              </div>
              <div className="evolution-trial-actions">
                <Button
                  className="primary"
                  disabled={busy}
                  onClick={() => onDecide(trial.id, 'variant_wins')}
                  title={t('evolution.decideVariantWinsTooltip')}
                >
                  {t('evolution.decideVariantWins')}
                </Button>
                <Button
                  className="ghost"
                  disabled={busy}
                  onClick={() => onDecide(trial.id, 'baseline_wins')}
                  title={t('evolution.decideBaselineWinsTooltip')}
                >
                  {t('evolution.decideBaselineWins')}
                </Button>
                <Button
                  className="ghost"
                  disabled={busy}
                  onClick={() => onDecide(trial.id, 'tie')}
                  title={t('evolution.decideTieTooltip')}
                >
                  {t('evolution.decideTie')}
                </Button>
                <Button
                  className="danger"
                  disabled={busy}
                  onClick={() => onAbort(trial.id, 'manual_abort')}
                  title={t('evolution.abortTooltip')}
                >
                  {t('evolution.abort')}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

function TrialConfigPanel({
  config,
  busy,
  onToggle,
}: {
  config: {
    project_id: string | null
    trials: Record<EvolutionSurface, boolean>
    forbidden_surfaces: EvolutionSurface[]
    min_samples_per_arm: number
    decision_margin: number
  }
  busy: boolean
  onToggle: (surface: EvolutionSurface, enabled: boolean) => void
}) {
  const { t } = useTranslation()
  const forbidden = new Set(config.forbidden_surfaces)
  const order: EvolutionSurface[] = ['prompt', 'kb', 'flow_template', 'routing', 'tool']
  return (
    <Panel
      title={t('evolution.abTrialSettings')}
      actions={
        <span className="muted" style={{ fontSize: 11 }}>
          {t('evolution.trialConfig', { samples: config.min_samples_per_arm, margin: Math.round(config.decision_margin * 100) })}
        </span>
      }
    >
      <ul className="evolution-trial-config">
        {order.map((surface) => {
          const isForbidden = forbidden.has(surface)
          const enabled = !!config.trials?.[surface]
          return (
            <li key={surface} className={`evolution-trial-config-row${isForbidden ? ' forbidden' : ''}`}>
              <div className="evolution-trial-config-label">
                <span className={`evolution-surface tag-${surface}`}>
                  {t(SURFACE_KEY_MAP[surface]) || surface}
                </span>
                {isForbidden && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    {t('evolution.lockedLevel0')}
                  </span>
                )}
              </div>
              <label className="evolution-trial-toggle">
                <input
                  type="checkbox"
                  checked={enabled && !isForbidden}
                  disabled={isForbidden || busy}
                  onChange={(e) => onToggle(surface, e.target.checked)}
                />
                <span>{enabled && !isForbidden ? t('evolution.abEnabled') : t('evolution.directApply')}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </Panel>
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
  const { t } = useTranslation()
  const payload = overlay.payload || {}
  return (
    <li className="evolution-overlay-card">
      <div className="evolution-overlay-card-head">
        <span className={`evolution-surface tag-${overlay.surface}`}>
          {t(SURFACE_KEY_MAP[overlay.surface]) || overlay.surface}
        </span>
        <StatusBadge status={overlay.state} />
        <span className="muted" style={{ fontSize: 11 }}>{overlay.scope}</span>
      </div>
      <div className="evolution-overlay-card-name">{overlay.name || overlay.id}</div>
      <pre className="evolution-payload mono">{JSON.stringify(payload, null, 2)}</pre>
      <div className="evolution-overlay-card-foot">
        <span className="muted" style={{ fontSize: 11 }}>
          {t('evolution.applied')} {formatTime(overlay.created_at)}
          {overlay.parent_overlay_id && (
            <>
              {' · '}
              <span title={overlay.parent_overlay_id}>{t('evolution.hasParent')}</span>
            </>
          )}
        </span>
        <Button className="ghost" onClick={onRetire} disabled={retiring} title={t('evolution.retireTooltip')}>
          <X size={14} /> {t('evolution.retire')}
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
  onApprove: (confirmSourceReviewed?: boolean) => Promise<unknown>
  onReject: (suppressDays: number, reason: string) => Promise<unknown>
  onMerge: () => Promise<unknown>
  onRollback: (reason: string) => Promise<unknown>
  busy: boolean
}) {
  const { t } = useTranslation()
  const [suppressDays, setSuppressDays] = useState<number>(0)
  const [rejectReason, setRejectReason] = useState<string>('')
  const [rollbackReason, setRollbackReason] = useState<string>('')
  const [sourceReviewed, setSourceReviewed] = useState<boolean>(false)

  const canApprove = candidate.status === 'pending' || candidate.status === 'trialing'
  const canReject = canApprove
  const canMerge = (candidate.status === 'pending' || candidate.status === 'approved') && candidate.scope !== 'global'
  const canRollback = candidate.status === 'approved'

  const isToolSurface = candidate.surface === 'tool'
  const toolSources = isToolSurface
    ? extractToolSources(candidate)
    : []
  const approveDisabled = !canApprove || busy || (isToolSurface && !sourceReviewed)

  const suppressOptions = [
    { value: 0, label: t('evolution.suppressionOptions.none') },
    { value: 7, label: t('evolution.suppressionOptions.7days') },
    { value: 14, label: t('evolution.suppressionOptions.14days') },
    { value: 30, label: t('evolution.suppressionOptions.30days') },
    { value: 90, label: t('evolution.suppressionOptions.90days') },
  ]

  return (
    <Modal open title={candidate.title} onClose={onClose} className="evolution-modal">
      <div className="evolution-modal-meta">
        <span className={`evolution-surface tag-${candidate.surface}`}>
          {t(SURFACE_KEY_MAP[candidate.surface]) || candidate.surface}
        </span>
        <StatusBadge status={candidate.status} />
        <span className="muted" style={{ fontSize: 11 }}>
          {candidate.scope} · {candidate.created_by} · {formatTime(candidate.created_at)}
        </span>
        {candidate.applied_overlay_id && (
          <span className="muted mono" style={{ fontSize: 11 }} title={candidate.applied_overlay_id}>
            {t('evolution.overlayId', { id: candidate.applied_overlay_id.slice(0, 8) })}
          </span>
        )}
      </div>

      {candidate.rationale && (
        <section className="evolution-modal-section">
          <h3 className="evolution-modal-section-title">
            <Sparkles size={14} /> {t('evolution.whyFired')}
          </h3>
          <p className="evolution-rationale">{candidate.rationale}</p>
        </section>
      )}

      <ApplyPreviewSection candidate={candidate} />

      <section className="evolution-modal-section">
        <h3 className="evolution-modal-section-title">
          <Layers size={14} /> {t('evolution.signalPayload')}
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

      {isToolSurface && toolSources.length > 0 && (
        <section className="evolution-modal-section evolution-tool-sources">
          <h3 className="evolution-modal-section-title">
            <AlertTriangle size={14} /> {t('evolution.toolSourceReview')}
          </h3>
          {toolSources.map((entry, idx) => (
            <div key={`${entry.name}-${idx}`} className="evolution-tool-source-block">
              <div className="evolution-tool-source-header">
                <span className="mono"><strong>{entry.name}</strong></span>
                {entry.description && (
                  <span className="muted" style={{ fontSize: 11 }}>{entry.description}</span>
                )}
              </div>
              <pre className="evolution-payload mono">{entry.source}</pre>
            </div>
          ))}
          <label className="evolution-source-reviewed-toggle">
            <input
              type="checkbox"
              checked={sourceReviewed}
              onChange={(e) => setSourceReviewed(e.target.checked)}
              disabled={busy}
            />
            <span>{t('evolution.acceptRisk')}</span>
          </label>
        </section>
      )}

      <section className="evolution-modal-section evolution-actions-section">
        <div className="evolution-action-row">
          <Button
            className="primary"
            disabled={approveDisabled}
            onClick={() => onApprove(isToolSurface ? sourceReviewed : undefined)}
            title={
              !canApprove
                ? t('evolution.approveDisabledNotPending')
                : isToolSurface && !sourceReviewed
                  ? t('evolution.approveDisabledNoReview')
                  : t('evolution.approveEnabled')
            }
          >
            <Check size={14} /> {t('evolution.approveApply')}
          </Button>
          {canMerge && (
            <Button
              className="ghost"
              disabled={busy}
              onClick={() => onMerge()}
              title={t('evolution.mergeTooltip', {
                scope: candidate.scope,
                target: candidate.scope === 'session' ? 'project' : 'global',
              })}
            >
              <ArrowUpRight size={14} />{' '}
              {candidate.scope === 'session'
                ? t('evolution.mergeToProject')
                : t('evolution.mergeToGlobal')}
            </Button>
          )}
          {canRollback && (
            <Button
              className="ghost"
              disabled={busy}
              onClick={() => onRollback(rollbackReason)}
              title={t('evolution.rollbackTooltip')}
            >
              <RotateCcw size={14} /> {t('evolution.rollbackOverlay')}
            </Button>
          )}
        </div>

        {canRollback && (
          <label className="evolution-action-aux">
            <span className="muted">{t('evolution.rollbackReason')}</span>
            <input
              type="text"
              value={rollbackReason}
              onChange={(e) => setRollbackReason(e.target.value)}
              placeholder={t('evolution.rollbackReasonPlaceholder')}
            />
          </label>
        )}

        {canReject && (
          <div className="evolution-reject-block">
            <h4 className="evolution-modal-section-title evolution-reject-title">
              <AlertTriangle size={14} /> {t('evolution.rejectCandidate')}
            </h4>
            <div className="evolution-reject-row">
              <label className="evolution-action-aux">
                <span className="muted">{t('evolution.suppressionWindow')}</span>
                <select
                  value={suppressDays}
                  onChange={(e) => setSuppressDays(Number(e.target.value))}
                >
                  {suppressOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="evolution-action-aux evolution-action-aux-grow">
                <span className="muted">{t('evolution.rejectReason')}</span>
                <input
                  type="text"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder={t('evolution.rejectReasonPlaceholder')}
                />
              </label>
              <Button
                className="danger"
                disabled={busy}
                onClick={() => onReject(suppressDays, rejectReason)}
              >
                <X size={14} /> {t('evolution.reject')}
              </Button>
            </div>
            {suppressDays > 0 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                {t('evolution.suppressionDetail', { n: suppressDays })}
              </p>
            )}
          </div>
        )}

        {candidate.status === 'rejected' && (candidate.metadata as Record<string, unknown> | undefined)?.suppressed_until ? (
          <p className="muted" style={{ fontSize: 12 }}>
            <GitBranch size={12} /> {t('evolution.suppressedUntil')}{' '}
            {formatTime(Number((candidate.metadata as Record<string, unknown>).suppressed_until))}
          </p>
        ) : null}
      </section>
    </Modal>
  )
}
