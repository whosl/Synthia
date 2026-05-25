import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Database,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  deleteProject,
  getProject,
  getProjectSummary,
  listProjectSessions,
  createProjectSession,
  reindexProject,
} from '../api/projects'
import { deleteSession, updateSession } from '../api/sessions'
import type { Session } from '../api/types'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { isProjectArchived } from '../lib/projectStatus'
import { parseProjectSnapshot } from '../lib/projectSnapshot'
import { formatNumber, formatRelative } from '../lib/time'

function SessionCard({
  session,
  onOpen,
}: {
  session: Session
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const tokens = (session.token_input || 0) + (session.token_output || 0)
  return (
    <article
      className={`session-card session-card-clickable${session.archived_at ? ' session-card-archived' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="session-card-head">
        <div className="session-card-title">
          <strong>{session.name || t('projectSessions.untitledSession')}</strong>
        </div>
        <StatusBadge status={session.status} />
      </div>
      <dl className="session-card-meta">
        <div><dt>{t('projectSessions.updated')}</dt><dd>{formatRelative(session.updated_at)}</dd></div>
        <div><dt>{t('projectSessions.messages')}</dt><dd>{formatNumber(session.message_count)}</dd></div>
        <div><dt>{t('projectSessions.toolsCalled')}</dt><dd>{formatNumber(session.tool_call_count)}</dd></div>
        {tokens > 0 && (
          <div><dt>{t('projectSessions.tokens')}</dt><dd>{formatNumber(tokens)}</dd></div>
        )}
      </dl>
    </article>
  )
}

export default function ProjectSessionsPage() {
  const { t } = useTranslation()
  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'name' | 'status' | 'created'>('updated')
  const [sessionName, setSessionName] = useState('')
  const [configOpen, setConfigOpen] = useState(true)
  const [showArchivedSessions, setShowArchivedSessions] = useState(false)

  const projectQ = useQuery({ queryKey: ['project', projectId], queryFn: () => getProject(projectId), enabled: Boolean(projectId) })
  const summaryQ = useQuery({
    queryKey: ['project-summary', projectId],
    queryFn: () => getProjectSummary(projectId),
    enabled: Boolean(projectId),
    refetchInterval: 120_000,
  })
  const sessionsQ = useQuery({
    queryKey: ['sessions', projectId, showArchivedSessions],
    queryFn: () =>
      listProjectSessions(projectId, { limit: 200, include_archived: showArchivedSessions }),
    enabled: Boolean(projectId),
  })

  const create = useMutation({
    mutationFn: (name: string) => createProjectSession(projectId, { name: name.trim() || undefined }),
    onSuccess: ({ session }) => navigate(`/term?project=${projectId}&session=${session.id}`),
    onError: (err: Error) => alert(err.message || t('projectSessions.createSessionFailed')),
  })
  const del = useMutation({
    mutationFn: (id: string) => deleteSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions', projectId] }),
  })
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => updateSession(id, { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions', projectId] }),
  })
  const reindex = useMutation({
    mutationFn: () => reindexProject(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] }),
    onError: (err: Error) => alert(err.message || t('projectSessions.reindexFailed')),
  })
  const hardDelete = useMutation({
    mutationFn: (name: string) => deleteProject(projectId, true, name),
    onSuccess: () => navigate('/'),
    onError: (err: Error) => alert(err.message || t('projectSessions.deleteFailed')),
  })

  const project = projectQ.data?.project
  const summary = summaryQ.data
  const isArchived = isProjectArchived(project)
  const isFetching = sessionsQ.isFetching

  const sessions = useMemo(() => {
    const rows = sessionsQ.data?.sessions ?? []
    const filtered = rows.filter((s) => `${s.name} ${s.id} ${s.status}`.toLowerCase().includes(query.toLowerCase()))
    return filtered.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'status') return String(a.status || '').localeCompare(String(b.status || ''))
      if (sort === 'created') return (b.created_at || 0) - (a.created_at || 0)
      return (b.updated_at || 0) - (a.updated_at || 0)
    })
  }, [sessionsQ.data, query, sort])

  const createNow = () => {
    if (isArchived) {
      alert(t('projectSessions.archivedNotice'))
      return
    }
    const name = sessionName.trim() || window.prompt(t('projectSessions.newSessionPlaceholder')) || ''
    create.mutate(name)
  }

  const promptRename = (s: Session) => {
    const next = window.prompt(t('projectSessions.sessionNamePrompt'), s.name)
    if (next && next.trim() && next.trim() !== s.name) {
      rename.mutate({ id: s.id, name: next.trim() })
    }
  }

  if (!projectId) return null

  return (
    <div className="page sessions-page">
      <PageStickyTop>
        <div className="page-header sessions-page-header">
          <div className="sessions-page-heading">
            <div className="sessions-title-row">
              <Link to="/" className="btn ghost icon-btn project-back-link" aria-label={t('projectSessions.backToProjects')} title={t('nav.projects')}>
                <ArrowLeft size={16} />
              </Link>
              <h1 className="page-title">{project?.name || 'Project'}</h1>
              {isArchived && <span className="project-archived-badge">{t('projectSessions.archived')}</span>}
              <Button
                className={`ghost icon-btn sessions-refresh${isFetching ? ' is-spinning' : ''}`}
                type="button"
                aria-label={t('projectSessions.refreshSessions')}
                title={t('projects.refresh')}
                onClick={() => sessionsQ.refetch()}
                disabled={isFetching}
              >
                <RefreshCw size={16} aria-hidden />
              </Button>
            </div>
            <p className="page-subtitle mono" style={{ fontSize: 12 }}>{project?.root_path}</p>
          </div>
        </div>

        <div className="toolbar sessions-toolbar">
          <input
            className="input"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            placeholder={t('projectSessions.newSessionPlaceholder')}
            style={{ flex: '1 1 160px', minWidth: 0, maxWidth: 220 }}
            disabled={isArchived}
          />
          <div className="sessions-search-wrap">
            <Search size={15} className="sessions-search-icon" />
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('projectSessions.searchSessionsPlaceholder')}
            />
          </div>
          <select className="select sessions-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="updated">{t('projectSessions.sortUpdatedDesc')}</option>
            <option value="created">{t('projectSessions.sortCreatedDesc')}</option>
            <option value="name">{t('projectSessions.sortName')}</option>
            <option value="status">{t('projectSessions.sortStatus')}</option>
          </select>
          <label className="projects-show-archived sessions-show-archived">
            <input
              type="checkbox"
              checked={showArchivedSessions}
              onChange={(e) => setShowArchivedSessions(e.target.checked)}
            />
            {t('projectSessions.showArchived')}
          </label>
          <Button
            className="primary sessions-create-btn"
            type="button"
            onClick={createNow}
            disabled={create.isPending || isArchived}
            aria-label={t('projectSessions.createSession')}
            title={isArchived ? t('projectSessions.projectArchived') : t('projectSessions.createSession')}
          >
            <Plus size={18} />
          </Button>
        </div>
      </PageStickyTop>

      {isArchived && (
        <p className="project-archived-notice">
          {t('projectSessions.archivedNotice')}
        </p>
      )}

      {summary && (
        <div className="project-summary-row">
          <Panel title={t('projectSessions.vivadoTarget')} className="project-summary-card">
            <div className="project-health-line">
              <Server size={16} />
              <span className={`health-dot ${summary.vivado_health?.reachable ? 'ok' : 'bad'}`} />
              <span>{summary.vivado_health?.reachable ? t('projectSessions.reachable') : t('projectSessions.unreachable')}</span>
              {summary.vivado_health?.host && (
                <span className="mono muted" style={{ fontSize: 11 }}>{summary.vivado_health.host}</span>
              )}
            </div>
            {summary.vivado_health?.version && (
              <p className="muted" style={{ fontSize: 11, margin: '6px 0 0' }}>Vivado {summary.vivado_health.version}</p>
            )}
            {summary.vivado_health?.error && (
              <p className="muted" style={{ fontSize: 11, margin: '4px 0 0', color: 'var(--error)' }}>{summary.vivado_health.error}</p>
            )}
          </Panel>
          <Panel
            title={t('projectSessions.projectKB')}
            className="project-summary-card"
            actions={
              <Button className="ghost icon-btn" type="button" title={t('projectSessions.reindexKB')} disabled={reindex.isPending} onClick={() => reindex.mutate()}>
                <RefreshCw size={14} className={reindex.isPending ? 'is-spinning' : ''} />
              </Button>
            }
          >
            <div className="project-health-line">
              <Database size={16} />
              <span>{formatNumber(summary.kb?.sources)} sources · {formatNumber(summary.kb?.chunks)} chunks</span>
            </div>
            {(summary.kb_recent_sources ?? []).length > 0 && (
              <ul className="project-kb-sources">
                {summary.kb_recent_sources.slice(0, 4).map((s) => (
                  <li key={s.id} className="mono muted">{s.title || s.path}</li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {project && (
        <Panel
          title={t('projectSessions.projectConfig')}
          className="project-config-panel"
          actions={
            <Button className="ghost icon-btn" type="button" onClick={() => setConfigOpen((v) => !v)} aria-expanded={configOpen}>
              {configOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </Button>
          }
        >
          {configOpen && (
            <>
            <dl className="project-config-grid">
              <div><dt>{t('projectSessions.manifest')}</dt><dd className="mono">{project.manifest_path}</dd></div>
              <div><dt>{t('projectSessions.vivadoXpr')}</dt><dd className="mono">{project.xpr_path || '—'}</dd></div>
              <div><dt>{t('projectSessions.part')}</dt><dd className="mono">{project.part || '—'}</dd></div>
              <div><dt>{t('projectSessions.top')}</dt><dd className="mono">{project.top_module || '—'}</dd></div>
              <div><dt>{t('projectSessions.sessions')}</dt><dd>{formatNumber(summary?.sessions?.active ?? project.session_count)}</dd></div>
              <div><dt>{t('projectSessions.problems')}</dt><dd>{formatNumber(project.problem_count)}</dd></div>
            </dl>
            <div className="project-danger-zone">
              <Button
                className="ghost danger-ghost"
                type="button"
                onClick={() => {
                  const name = window.prompt(t('projects.deleteConfirm', { name: project.name }))
                  if (name === project.name && confirm(t('projects.deleteWarning'))) {
                    hardDelete.mutate(name)
                  }
                }}
              >
                <Trash2 size={14} /> {t('projectSessions.deleteProject')}
              </Button>
            </div>
            </>
          )}
        </Panel>
      )}

      <section className="panel sessions-panel">
        <div className="sessions-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('projectSessions.tableSession')}</th>
                <th>{t('projectSessions.tableStatus')}</th>
                <th>{t('projectSessions.tableUpdated')}</th>
                <th>{t('projectSessions.tableMessages')}</th>
                <th>{t('projectSessions.tableTools')}</th>
                <th>{t('projectSessions.tableProblems')}</th>
                <th>{t('projectSessions.tableTokens')}</th>
                <th aria-label={t('projectSessions.tableActions')} />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => navigate(`/term?project=${projectId}&session=${s.id}`)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <div style={{ color: 'var(--text)', fontWeight: 600 }}>{s.name}</div>
                    {parseProjectSnapshot(s).legacy_migration && (
                      <span className="muted" style={{ fontSize: 10 }}>{t('projectSessions.legacySnapshot')}</span>
                    )}
                  </td>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="muted">{formatRelative(s.updated_at)}</td>
                  <td>{formatNumber(s.message_count)}</td>
                  <td>{formatNumber(s.tool_call_count)}</td>
                  <td style={{ color: (s.problem_count || 0) > 0 ? 'var(--error)' : undefined }}>{formatNumber(s.problem_count)}</td>
                  <td>{formatNumber((s.token_input || 0) + (s.token_output || 0))}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Button
                      className="ghost icon-btn"
                      title={t('projectSessions.renameSession')}
                      onClick={(e) => {
                        e.stopPropagation()
                        promptRename(s)
                      }}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      className="ghost icon-btn"
                      title={t('projectSessions.archiveSession')}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(t('projectSessions.archiveSessionConfirm'))) del.mutate(s.id)
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                    <ChevronRight size={16} color="var(--muted)" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="sessions-mobile-list">
          {sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onOpen={() => navigate(`/term?project=${projectId}&session=${s.id}`)}
            />
          ))}
        </div>

        {!sessionsQ.isLoading && sessions.length === 0 && (
          <EmptyState title={t('projectSessions.noSessions')} detail={t('projectSessions.noSessionsDetail')} />
        )}
      </section>
    </div>
  )
}