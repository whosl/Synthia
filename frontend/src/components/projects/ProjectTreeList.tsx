import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ChevronRight,
  Folder,
  Pencil,
  Plus,
  Settings,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import {
  createProjectSession,
  deleteProject,
  listProjectSessions,
  updateProject,
} from '../../api/projects'
import { deleteSession, updateSession } from '../../api/sessions'
import type { Project, Session } from '../../api/types'
import { useIsDesktop } from '../../hooks/useIsDesktop'
import { useLongPress } from '../../hooks/useLongPress'
import { isProjectArchived } from '../../lib/projectStatus'
import { isSessionRunning, sessionInitials } from '../../lib/sessionVisual'
import { formatNumber, formatRelative } from '../../lib/time'
import { Button } from '../common/Button'
import { EmptyState } from '../common/EmptyState'
import { MobileActionsMenu, type MobileAction } from './MobileActionsMenu'
import { ProjectSessionsTable } from './ProjectSessionsTable'

const EXPAND_STORAGE_KEY = 'edagent:projects:expanded'

function loadExpandedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPAND_STORAGE_KEY)
    if (!raw) return new Set()
    const ids = JSON.parse(raw) as string[]
    return new Set(Array.isArray(ids) ? ids : [])
  } catch {
    return new Set()
  }
}

function saveExpandedIds(ids: Set<string>) {
  try {
    localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    /* ignore */
  }
}

function filterSessions(sessions: Session[], query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return sessions
  return sessions.filter((s) => `${s.name} ${s.id} ${s.status}`.toLowerCase().includes(q))
}

function projectMatchesQuery(p: Project, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${p.name} ${p.root_path} ${p.manifest_path} ${p.id}`.toLowerCase().includes(q)
}

function SessionTreeRow({
  session,
  onOpen,
  onRename,
  onArchive,
}: {
  session: Session
  onOpen: () => void
  onRename: () => void
  onArchive: () => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const isDesktop = useIsDesktop()
  const longPress = useLongPress(() => setMenuOpen(true))
  const pressHandlers = isDesktop ? {} : longPress
  const running = isSessionRunning(session.status)
  const archived = Boolean(session.archived_at)
  const initials = sessionInitials(session.name || t('projectSessions.untitledSession'))

  const actions: MobileAction[] = [
    { id: 'rename', label: t('projectSessions.renameSession'), onSelect: onRename },
    {
      id: 'archive',
      label: t('projectSessions.archiveSession'),
      destructive: true,
      onSelect: onArchive,
    },
  ]

  return (
    <>
      <div
        className={`project-tree-session${archived ? ' is-archived' : ''}${running ? ' is-running' : ''}`}
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          }
        }}
        {...pressHandlers}
      >
        <span className="project-tree-session-avatar" aria-hidden>
          {initials}
        </span>
        <span className={`project-tree-session-title${archived ? ' muted' : ''}`}>
          {session.name || t('projectSessions.untitledSession')}
        </span>
        <span className="project-tree-session-meta">
          {running ? (
            <span className="session-meta-running">
              <span className="session-running-dot" aria-hidden />
              {t('status.running')}
            </span>
          ) : (
            <span className="muted">{formatRelative(session.updated_at)}</span>
          )}
        </span>
      </div>
      {menuOpen && (
        <MobileActionsMenu
          title={session.name || t('projectSessions.sessionNamePrompt')}
          actions={actions}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  )
}

function ProjectTreeSection({
  project,
  expanded,
  searchQuery,
  loadSessions,
  onToggle,
  onEdit,
  onArchiveProject,
  onRestoreProject,
  onCreateSession,
  showArchivedSessions,
}: {
  project: Project
  expanded: boolean
  searchQuery: string
  showArchivedSessions: boolean
  loadSessions: boolean
  onToggle: () => void
  onEdit: () => void
  onArchiveProject: () => void
  onRestoreProject: () => void
  onCreateSession: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isDesktop = useIsDesktop()
  const [menuOpen, setMenuOpen] = useState(false)
  const longPress = useLongPress(() => setMenuOpen(true))
  const pressHandlers = isDesktop ? {} : longPress
  const archived = isProjectArchived(project)

  const sessionsQ = useQuery({
    queryKey: ['sessions', project.id, showArchivedSessions],
    queryFn: () =>
      listProjectSessions(project.id, { limit: 200, include_archived: showArchivedSessions }),
    enabled: loadSessions,
  })

  const sessions = useMemo(() => {
    const rows = sessionsQ.data?.sessions ?? []
    return filterSessions(rows, searchQuery).sort(
      (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    )
  }, [sessionsQ.data, searchQuery])

  const sessionCount = loadSessions ? sessions.length : (project.session_count ?? 0)
  const q = searchQuery.trim()
  const projectVisible =
    !q
    || projectMatchesQuery(project, searchQuery)
    || (loadSessions && !sessionsQ.isLoading && sessions.length > 0)

  const renameSession = useCallback((s: Session) => {
    const next = window.prompt(t('projectSessions.sessionNamePrompt'), s.name)
    if (next && next.trim() && next.trim() !== s.name) {
      updateSession(s.id, { name: next.trim() }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['sessions', project.id] })
        queryClient.invalidateQueries({ queryKey: ['projects'] })
      })
    }
  }, [project.id, queryClient, t])

  const archiveSession = useCallback((s: Session) => {
    if (!confirm(t('projectSessions.archiveSessionConfirm'))) return
    deleteSession(s.id).then(() => {
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    })
  }, [project.id, queryClient, t])

  const openSession = useCallback(
    (sessionId: string) => navigate(`/term?project=${project.id}&session=${sessionId}`),
    [navigate, project.id],
  )

  if (!projectVisible && searchQuery.trim()) return null

  const projectActions: MobileAction[] = archived
    ? [{ id: 'restore', label: t('projects.restoreProject'), onSelect: onRestoreProject }]
    : [
        { id: 'edit', label: t('projects.editProjectAction'), onSelect: onEdit },
        { id: 'archive', label: t('projects.archiveProjectAction'), destructive: true, onSelect: onArchiveProject },
      ]

  return (
    <section className="project-tree-section">
      <div
        className={`project-tree-project${expanded ? ' expanded' : ''}${archived ? ' is-archived' : ''}`}
        {...pressHandlers}
      >
        <button
          type="button"
          className="project-tree-chevron"
          aria-expanded={expanded}
          aria-label={expanded ? t('projects.collapse') : t('projects.expand')}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
        >
          <ChevronRight size={16} />
        </button>
        <button type="button" className="project-tree-project-main" onClick={onToggle}>
          <span className="project-tree-project-name">{project.name}</span>
          {archived && <span className="project-archived-badge">{t('status.archived')}</span>}
        </button>
        <div className="project-tree-project-actions" onClick={(e) => e.stopPropagation()}>
          <span className="project-tree-count muted">({formatNumber(sessionCount)})</span>
          {!archived && (
            <Button
              className="ghost icon-btn project-tree-add"
              type="button"
              aria-label={t('projectSessions.createSession')}
              title={t('projectSessions.createSession')}
              onClick={onCreateSession}
            >
              <Plus size={16} />
            </Button>
          )}
          {isDesktop && (
            <>
              <Button className="ghost icon-btn" type="button" title={t('projects.editProjectAction')} onClick={onEdit}>
                <Pencil size={14} />
              </Button>
              {!archived ? (
                <Button
                  className="ghost icon-btn"
                  type="button"
                  title={t('projects.archiveProjectAction')}
                  onClick={onArchiveProject}
                >
                  <Archive size={14} />
                </Button>
              ) : (
                <Button className="ghost icon-btn" type="button" title={t('projects.restoreProject')} onClick={onRestoreProject}>
                  {t('projects.restoreProject')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className="project-tree-children">
          {sessionsQ.isLoading && (
            <div className="project-tree-loading muted">{t('projects.loadingSessions')}</div>
          )}
          {!sessionsQ.isLoading && sessions.length === 0 && (
            <div className="project-tree-empty muted">{t('projects.noSessions')}</div>
          )}
          {isDesktop ? (
            <ProjectSessionsTable
              sessions={sessions}
              onOpen={openSession}
              onRename={renameSession}
              onArchive={archiveSession}
            />
          ) : (
            sessions.map((s) => (
              <SessionTreeRow
                key={s.id}
                session={s}
                onOpen={() => openSession(s.id)}
                onRename={() => renameSession(s)}
                onArchive={() => archiveSession(s)}
              />
            ))
          )}
        </div>
      )}

      {menuOpen && (
        <MobileActionsMenu
          title={project.name}
          actions={projectActions}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </section>
  )
}

export function ProjectTreeList({
  projects,
  searchQuery,
  expandProjectId,
  showArchivedSessions,
  onEditProject,
  onNewProject,
}: {
  projects: Project[]
  searchQuery: string
  showArchivedSessions: boolean
  expandProjectId?: string | null
  onEditProject: (p: Project) => void
  onNewProject: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpandedIds())

  const totalSessions = useMemo(
    () => projects.reduce((sum, p) => sum + (p.session_count ?? 0), 0),
    [projects],
  )

  useEffect(() => {
    if (expandProjectId) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.add(expandProjectId)
        saveExpandedIds(next)
        return next
      })
    }
  }, [expandProjectId])

  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const p of projects) next.add(p.id)
      saveExpandedIds(next)
      return next
    })
  }, [searchQuery, projects])

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveExpandedIds(next)
      return next
    })
  }, [])

  const createSession = useMutation({
    mutationFn: (projectId: string) => createProjectSession(projectId, {}),
    onSuccess: ({ session }, projectId) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', projectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate(`/term?project=${projectId}&session=${session.id}`)
    },
    onError: (err: Error) => alert(err.message || t('projectSessions.createSessionFailed')),
  })

  const archiveProject = useMutation({
    mutationFn: (id: string) => deleteProject(id, false),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const restoreProject = useMutation({
    mutationFn: (id: string) => updateProject(id, { status: 'active' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  return (
    <div className="project-tree">
      <header className="project-tree-topbar">
        <p className="project-tree-stats muted">
          {t('projects.statsTemplate', { sessions: formatNumber(totalSessions), projects: formatNumber(projects.length) })}
        </p>
        <div className="project-tree-topbar-actions">
          <Button
            className="ghost icon-btn"
            type="button"
            aria-label={t('projects.folders')}
            title={t('projects.folders')}
            disabled
          >
            <Folder size={18} />
          </Button>
          <Link to="/settings" className="btn ghost icon-btn" aria-label={t('projects.settings')} title={t('projects.settings')}>
            <Settings size={18} />
          </Link>
          <Button className="ghost icon-btn" type="button" aria-label={t('projects.newProject')} title={t('projects.newProject')} onClick={onNewProject}>
            <Plus size={18} />
          </Button>
        </div>
      </header>

      <div className="project-tree-list">
        {projects.map((p) => {
          const isExpanded = expanded.has(p.id)
          const loadSessions = isExpanded || Boolean(searchQuery.trim())
          return (
            <ProjectTreeSection
              key={p.id}
              project={p}
              expanded={isExpanded}
              searchQuery={searchQuery}
              loadSessions={loadSessions}
              showArchivedSessions={showArchivedSessions}
              onToggle={() => toggle(p.id)}
              onEdit={() => onEditProject(p)}
              onArchiveProject={() => {
                if (confirm(t('projects.archiveProject', { name: p.name }))) {
                  archiveProject.mutate(p.id)
                }
              }}
              onRestoreProject={() => restoreProject.mutate(p.id)}
              onCreateSession={() => {
                if (isProjectArchived(p)) {
                  alert(t('projects.archivedNotice'))
                  return
                }
                createSession.mutate(p.id)
              }}
            />
          )
        })}
      </div>

      {projects.length === 0 && (
        <EmptyState title={t('projects.noProjects')} detail={t('projects.noProjectsDetail')} />
      )}
    </div>
  )
}
