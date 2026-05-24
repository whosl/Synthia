import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ChevronRight, FolderKanban, Pencil, Plus, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createProject,
  deleteProject,
  listProjects,
  updateProject,
  type CreateProjectPayload,
} from '../api/projects'
import { listVivadoTargets } from '../api/vivado'
import type { Project } from '../api/types'
import { MigrationConflictsBanner } from '../components/projects/MigrationConflictsBanner'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { Panel } from '../components/common/Panel'
import { globsToText, parseProjectGlobs, textToGlobs } from '../lib/projectStatus'
import { formatNumber, formatRelative } from '../lib/time'

type ProjectFormState = {
  name: string
  root_path: string
  manifest_path: string
  xpr_path: string
  part: string
  board_part: string
  top_module: string
  target_language: string
  simulator: string
  source_globs_text: string
  constraint_globs_text: string
  tcl_globs_text: string
  default_vivado_target_id: string
}

const DEFAULT_FORM: ProjectFormState = {
  name: '',
  root_path: '',
  manifest_path: '',
  xpr_path: '',
  part: '',
  board_part: '',
  top_module: '',
  target_language: 'Verilog',
  simulator: 'xsim',
  source_globs_text: 'rtl/**/*.v, rtl/**/*.sv',
  constraint_globs_text: 'constraints/**/*.xdc',
  tcl_globs_text: 'scripts/**/*.tcl',
  default_vivado_target_id: '',
}

function projectFormFrom(p: Project): ProjectFormState {
  return {
    name: p.name,
    root_path: p.root_path,
    manifest_path: p.manifest_path,
    xpr_path: p.xpr_path || '',
    part: p.part || '',
    board_part: p.board_part || '',
    top_module: p.top_module || '',
    target_language: p.target_language || 'Verilog',
    simulator: p.simulator || 'xsim',
    source_globs_text: globsToText(parseProjectGlobs(p.source_globs_json)),
    constraint_globs_text: globsToText(parseProjectGlobs(p.constraint_globs_json)),
    tcl_globs_text: globsToText(parseProjectGlobs(p.tcl_globs_json)),
    default_vivado_target_id: p.default_vivado_target_id || '',
  }
}

function formToPayload(form: ProjectFormState): CreateProjectPayload {
  return {
    name: form.name.trim() || form.root_path.split('/').filter(Boolean).pop() || 'Project',
    root_path: form.root_path.trim(),
    manifest_path: form.manifest_path.trim(),
    xpr_path: form.xpr_path.trim(),
    part: form.part.trim() || undefined,
    board_part: form.board_part.trim() || undefined,
    top_module: form.top_module.trim() || undefined,
    target_language: form.target_language.trim() || undefined,
    simulator: form.simulator.trim() || undefined,
    source_globs: textToGlobs(form.source_globs_text),
    constraint_globs: textToGlobs(form.constraint_globs_text),
    tcl_globs: textToGlobs(form.tcl_globs_text),
    default_vivado_target_id: form.default_vivado_target_id.trim() || undefined,
  }
}

export default function ProjectsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ProjectFormState>(DEFAULT_FORM)
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'name' | 'sessions'>('updated')
  const [showArchived, setShowArchived] = useState(false)

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['projects', showArchived],
    queryFn: () => listProjects({ limit: 200, include_archived: showArchived }),
  })
  const targetsQ = useQuery({
    queryKey: ['vivado-targets'],
    queryFn: listVivadoTargets,
    enabled: showCreate || Boolean(editing),
  })
  const vivadoTargets = targetsQ.data?.targets ?? []

  const create = useMutation({
    mutationFn: createProject,
    onSuccess: ({ project }) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setForm(DEFAULT_FORM)
      setShowCreate(false)
      navigate(`/projects/${project.id}`)
    },
    onError: (err: Error) => alert(err.message || 'Failed to create project'),
  })

  const saveEdit = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: Partial<CreateProjectPayload> & { status?: string }
    }) => updateProject(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setEditing(null)
      setForm(DEFAULT_FORM)
    },
    onError: (err: Error) => alert(err.message || 'Failed to update project'),
  })

  const archive = useMutation({
    mutationFn: (id: string) => deleteProject(id, false),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const projects = useMemo(() => {
    const rows = data?.projects ?? []
    const filtered = rows.filter((p) =>
      `${p.name} ${p.root_path} ${p.manifest_path} ${p.id}`.toLowerCase().includes(query.toLowerCase()),
    )
    return filtered.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'sessions') return (b.session_count || 0) - (a.session_count || 0)
      return (b.last_active_at || b.updated_at || 0) - (a.last_active_at || a.updated_at || 0)
    })
  }, [data, query, sort])

  const submitProject = () => {
    if (!form.root_path.trim() || !form.manifest_path.trim()) {
      alert('root_path and manifest_path are required')
      return
    }
    const payload = formToPayload(form)
    if (editing) {
      saveEdit.mutate({ id: editing.id, payload })
    } else {
      create.mutate(payload)
    }
  }

  const openEdit = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditing(p)
    setForm(projectFormFrom(p))
    setShowCreate(false)
  }

  const formPanel = (showCreate || editing) && (
    <Panel title={editing ? `Edit project — ${editing.name}` : 'Create project'}>
      <div className="project-create-form">
        <label>
          <span>Name</span>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="uart_full" />
        </label>
        <label>
          <span>Root path *</span>
          <input className="input mono" value={form.root_path} onChange={(e) => setForm({ ...form, root_path: e.target.value })} />
        </label>
        <label>
          <span>Manifest (Synthia YAML) *</span>
          <input className="input mono" value={form.manifest_path} onChange={(e) => setForm({ ...form, manifest_path: e.target.value })} />
        </label>
        <label>
          <span>Vivado .xpr</span>
          <input className="input mono" value={form.xpr_path} onChange={(e) => setForm({ ...form, xpr_path: e.target.value })} />
        </label>
        <div className="project-form-row-2">
          <label>
            <span>Part</span>
            <input className="input mono" value={form.part} onChange={(e) => setForm({ ...form, part: e.target.value })} placeholder="xc7a35tcpg236-1" />
          </label>
          <label>
            <span>Board part</span>
            <input className="input mono" value={form.board_part} onChange={(e) => setForm({ ...form, board_part: e.target.value })} />
          </label>
        </div>
        <label>
          <span>Top module</span>
          <input className="input mono" value={form.top_module} onChange={(e) => setForm({ ...form, top_module: e.target.value })} placeholder="uart_top" />
        </label>
        <div className="project-form-row-2">
          <label>
            <span>Target language</span>
            <input className="input" value={form.target_language} onChange={(e) => setForm({ ...form, target_language: e.target.value })} placeholder="Verilog" />
          </label>
          <label>
            <span>Simulator</span>
            <input className="input" value={form.simulator} onChange={(e) => setForm({ ...form, simulator: e.target.value })} placeholder="xsim" />
          </label>
        </div>
        <label>
          <span>Source globs (comma-separated)</span>
          <input className="input mono" value={form.source_globs_text} onChange={(e) => setForm({ ...form, source_globs_text: e.target.value })} />
        </label>
        <label>
          <span>Constraint globs</span>
          <input className="input mono" value={form.constraint_globs_text} onChange={(e) => setForm({ ...form, constraint_globs_text: e.target.value })} />
        </label>
        <label>
          <span>Tcl globs</span>
          <input className="input mono" value={form.tcl_globs_text} onChange={(e) => setForm({ ...form, tcl_globs_text: e.target.value })} />
        </label>
        <label>
          <span>Default Vivado target</span>
          <select
            className="select"
            value={form.default_vivado_target_id}
            onChange={(e) => setForm({ ...form, default_vivado_target_id: e.target.value })}
          >
            <option value="">(default from config)</option>
            {vivadoTargets.map((t) => {
              const id = String(t.id ?? '')
              const name = String(t.name ?? id)
              return (
                <option key={id} value={id}>
                  {name}
                </option>
              )
            })}
          </select>
        </label>
        <div className="project-create-actions">
          <Button
            className="ghost"
            type="button"
            onClick={() => {
              setShowCreate(false)
              setEditing(null)
              setForm(DEFAULT_FORM)
            }}
          >
            Cancel
          </Button>
          <Button className="primary" type="button" onClick={submitProject} disabled={create.isPending || saveEdit.isPending}>
            {editing ? (saveEdit.isPending ? 'Saving…' : 'Save changes') : create.isPending ? 'Creating…' : 'Create project'}
          </Button>
        </div>
      </div>
    </Panel>
  )

  return (
    <div className="page projects-page">
      <MigrationConflictsBanner />

      <div className="page-header">
        <div className="sessions-page-heading">
          <div className="sessions-title-row">
            <h1 className="page-title">Projects</h1>
            <Button
              className={`ghost icon-btn sessions-refresh${isFetching ? ' is-spinning' : ''}`}
              type="button"
              aria-label="Refresh projects"
              title="Refresh"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw size={16} aria-hidden />
            </Button>
          </div>
          <p className="page-subtitle">Engineering workspaces — open a project to manage sessions</p>
        </div>
        <Button
          className="primary"
          type="button"
          onClick={() => {
            setEditing(null)
            setForm(DEFAULT_FORM)
            setShowCreate((v) => !v)
          }}
        >
          <Plus size={16} /> New project
        </Button>
      </div>

      <div className="toolbar sessions-toolbar">
        <div className="sessions-search-wrap" style={{ flex: 1 }}>
          <Search size={15} className="sessions-search-icon" />
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
          />
        </div>
        <select className="select sessions-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="updated">Sort: Last active</option>
          <option value="name">Sort: Name</option>
          <option value="sessions">Sort: Session count</option>
        </select>
        <label className="projects-show-archived">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {formPanel}

      <section className="projects-grid">
        {projects.map((p) => (
          <article
            key={p.id}
            className="project-card"
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/projects/${p.id}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate(`/projects/${p.id}`)
            }}
          >
            <div className="project-card-head">
              <FolderKanban size={18} className="project-card-icon" />
              <strong>{p.name}</strong>
              {p.status === 'archived' && <span className="project-archived-badge">Archived</span>}
            </div>
            <p className="project-card-path mono">{p.root_path}</p>
            <dl className="project-card-meta">
              <div>
                <dt>Sessions</dt>
                <dd>{formatNumber(p.session_count)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatRelative(p.last_active_at || p.updated_at)}</dd>
              </div>
            </dl>
            <div className="project-card-footer">
              <div className="project-card-actions" onClick={(e) => e.stopPropagation()}>
                <Button className="ghost icon-btn" type="button" title="Edit" onClick={(e) => openEdit(p, e)}>
                  <Pencil size={14} />
                </Button>
                {p.status !== 'archived' ? (
                  <Button
                    className="ghost icon-btn"
                    type="button"
                    title="Archive project"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm(`Archive project "${p.name}"? Sessions become read-only.`)) archive.mutate(p.id)
                    }}
                  >
                    <Archive size={14} />
                  </Button>
                ) : (
                  <Button
                    className="ghost icon-btn"
                    type="button"
                    title="Restore project"
                    onClick={(e) => {
                      e.stopPropagation()
                      saveEdit.mutate({ id: p.id, payload: { status: 'active' } })
                    }}
                  >
                    Restore
                  </Button>
                )}
              </div>
              <span className="project-card-open muted">
                Open sessions <ChevronRight size={14} />
              </span>
            </div>
          </article>
        ))}
      </section>

      {!isFetching && projects.length === 0 && (
        <EmptyState title="No projects yet" detail="Create a project with root path and manifest before starting sessions." />
      )}
    </div>
  )
}
