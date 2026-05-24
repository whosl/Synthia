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
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'
import { parseProjectSnapshot } from '../lib/projectSnapshot'
import { formatNumber, formatRelative } from '../lib/time'

function SessionCard({
  session,
  onOpen,
}: {
  session: Session
  onOpen: () => void
}) {
  const tokens = (session.token_input || 0) + (session.token_output || 0)
  return (
    <article
      className="session-card session-card-clickable"
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
          <strong>{session.name || 'Untitled session'}</strong>
        </div>
        <StatusBadge status={session.status} />
      </div>
      <dl className="session-card-meta">
        <div><dt>Updated</dt><dd>{formatRelative(session.updated_at)}</dd></div>
        <div><dt>Messages</dt><dd>{formatNumber(session.message_count)}</dd></div>
        <div><dt>tools called</dt><dd>{formatNumber(session.tool_call_count)}</dd></div>
        {tokens > 0 && (
          <div><dt>Tokens</dt><dd>{formatNumber(tokens)}</dd></div>
        )}
      </dl>
    </article>
  )
}

export default function ProjectSessionsPage() {
  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'name' | 'status' | 'created'>('updated')
  const [sessionName, setSessionName] = useState('')
  const [configOpen, setConfigOpen] = useState(true)

  const projectQ = useQuery({ queryKey: ['project', projectId], queryFn: () => getProject(projectId), enabled: Boolean(projectId) })
  const summaryQ = useQuery({
    queryKey: ['project-summary', projectId],
    queryFn: () => getProjectSummary(projectId),
    enabled: Boolean(projectId),
    refetchInterval: 120_000,
  })
  const sessionsQ = useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => listProjectSessions(projectId, { limit: 200 }),
    enabled: Boolean(projectId),
  })

  const create = useMutation({
    mutationFn: (name: string) => createProjectSession(projectId, { name: name.trim() || undefined }),
    onSuccess: ({ session }) => navigate(`/term?project=${projectId}&session=${session.id}`),
    onError: (err: Error) => alert(err.message || 'Failed to create session'),
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
    onError: (err: Error) => alert(err.message || 'Reindex failed'),
  })
  const hardDelete = useMutation({
    mutationFn: (name: string) => deleteProject(projectId, true, name),
    onSuccess: () => navigate('/'),
    onError: (err: Error) => alert(err.message || 'Delete failed'),
  })

  const project = projectQ.data?.project
  const summary = summaryQ.data
  const isArchived = project?.status === 'archived'
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
      alert('This project is archived. Edit the project on the Projects page to restore it before creating sessions.')
      return
    }
    const name = sessionName.trim() || window.prompt('Session name (optional)') || ''
    create.mutate(name)
  }

  const promptRename = (s: Session) => {
    const next = window.prompt('Session name', s.name)
    if (next && next.trim() && next.trim() !== s.name) {
      rename.mutate({ id: s.id, name: next.trim() })
    }
  }

  if (!projectId) return null

  return (
    <div className="page sessions-page">
      <div className="page-header sessions-page-header">
        <div className="sessions-page-heading">
          <div className="sessions-title-row">
            <Link to="/" className="btn ghost icon-btn project-back-link" aria-label="Back to projects" title="Projects">
              <ArrowLeft size={16} />
            </Link>
            <h1 className="page-title">{project?.name || 'Project'}</h1>
            {isArchived && <span className="project-archived-badge">Archived</span>}
            <Button
              className={`ghost icon-btn sessions-refresh${isFetching ? ' is-spinning' : ''}`}
              type="button"
              aria-label="Refresh sessions"
              title="Refresh"
              onClick={() => sessionsQ.refetch()}
              disabled={isFetching}
            >
              <RefreshCw size={16} aria-hidden />
            </Button>
          </div>
          <p className="page-subtitle mono" style={{ fontSize: 12 }}>{project?.root_path}</p>
        </div>
      </div>

      {isArchived && (
        <p className="project-archived-notice">
          Project is archived — existing sessions are view-only; new tasks and sessions are disabled.
        </p>
      )}

      {summary && (
        <div className="project-summary-row">
          <Panel title="Vivado target" className="project-summary-card">
            <div className="project-health-line">
              <Server size={16} />
              <span className={`health-dot ${summary.vivado_health?.reachable ? 'ok' : 'bad'}`} />
              <span>{summary.vivado_health?.reachable ? 'Reachable' : 'Unreachable'}</span>
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
            title="Project KB"
            className="project-summary-card"
            actions={
              <Button className="ghost icon-btn" type="button" title="Reindex project KB" disabled={reindex.isPending} onClick={() => reindex.mutate()}>
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
          title="Project configuration"
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
              <div><dt>Manifest</dt><dd className="mono">{project.manifest_path}</dd></div>
              <div><dt>Vivado .xpr</dt><dd className="mono">{project.xpr_path || '—'}</dd></div>
              <div><dt>Part</dt><dd className="mono">{project.part || '—'}</dd></div>
              <div><dt>Top</dt><dd className="mono">{project.top_module || '—'}</dd></div>
              <div><dt>Sessions</dt><dd>{formatNumber(summary?.sessions?.active ?? project.session_count)} active</dd></div>
              <div><dt>Problems</dt><dd>{formatNumber(project.problem_count)}</dd></div>
            </dl>
            <div className="project-danger-zone">
              <Button
                className="ghost danger-ghost"
                type="button"
                onClick={() => {
                  const name = window.prompt(`Type project name "${project.name}" to permanently delete:`)
                  if (name === project.name && confirm('This cannot be undone. Delete project and all sessions?')) {
                    hardDelete.mutate(name)
                  }
                }}
              >
                <Trash2 size={14} /> Permanently delete project
              </Button>
            </div>
            </>
          )}
        </Panel>
      )}

      <div className="toolbar sessions-toolbar">
        <input
          className="input"
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
          placeholder="New session name (optional)"
          style={{ flex: '1 1 160px', minWidth: 0, maxWidth: 220 }}
          disabled={isArchived}
        />
        <div className="sessions-search-wrap">
          <Search size={15} className="sessions-search-icon" />
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions..."
          />
        </div>
        <select className="select sessions-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="updated">Sort: Updated desc</option>
          <option value="created">Sort: Created desc</option>
          <option value="name">Sort: Name</option>
          <option value="status">Sort: Status</option>
        </select>
        <Button
          className="primary sessions-create-btn"
          type="button"
          onClick={createNow}
          disabled={create.isPending || isArchived}
          aria-label="Create session"
          title={isArchived ? 'Project archived' : 'Create session'}
        >
          <Plus size={18} />
        </Button>
      </div>

      <section className="panel sessions-panel">
        <div className="sessions-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Messages</th>
                <th>tools called</th>
                <th>Problems</th>
                <th>Tokens</th>
                <th aria-label="Actions" />
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
                      <span className="muted" style={{ fontSize: 10 }}>legacy snapshot</span>
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
                      title="Rename session"
                      onClick={(e) => {
                        e.stopPropagation()
                        promptRename(s)
                      }}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      className="ghost icon-btn"
                      title="Archive session"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm('Archive this session?')) del.mutate(s.id)
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
          <EmptyState title="No sessions in this project" detail="Tap + to start a new debug session." />
        )}
      </section>
    </div>
  )
}
