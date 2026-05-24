import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpDown, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  createProject,
  listProjects,
  updateProject,
  type CreateProjectPayload,
} from '../api/projects'
import { listVivadoTargets } from '../api/vivado'
import type { Project } from '../api/types'
import { MigrationConflictsBanner } from '../components/projects/MigrationConflictsBanner'
import { ProjectTreeList } from '../components/projects/ProjectTreeList'
import { Button } from '../components/common/Button'
import { Modal } from '../components/common/Modal'
import { globsToText, parseProjectGlobs, textToGlobs } from '../lib/projectStatus'

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
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const expandProjectId = searchParams.get('expand')

  const [form, setForm] = useState<ProjectFormState>(DEFAULT_FORM)
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'name' | 'sessions'>('updated')
  const [showArchived, setShowArchived] = useState(false)
  const [showArchivedSessions, setShowArchivedSessions] = useState(false)

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setForm(DEFAULT_FORM)
      setShowCreate(false)
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
      closeForm()
    },
    onError: (err: Error) => alert(err.message || 'Failed to update project'),
  })

  const projects = useMemo(() => {
    const rows = data?.projects ?? []
    return [...rows].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'sessions') return (b.session_count || 0) - (a.session_count || 0)
      return (b.last_active_at || b.updated_at || 0) - (a.last_active_at || a.updated_at || 0)
    })
  }, [data, sort])

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

  const closeForm = () => {
    setShowCreate(false)
    setEditing(null)
    setForm(DEFAULT_FORM)
  }

  const formOpen = showCreate || Boolean(editing)

  const openEdit = (p: Project) => {
    setEditing(p)
    setForm(projectFormFrom(p))
    setShowCreate(false)
  }

  const projectForm = (
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
        <Button className="ghost" type="button" onClick={closeForm}>
          Cancel
        </Button>
        <Button className="primary" type="button" onClick={submitProject} disabled={create.isPending || saveEdit.isPending}>
          {editing ? (saveEdit.isPending ? 'Saving…' : 'Save changes') : create.isPending ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="page projects-page projects-tree-page">
      <MigrationConflictsBanner />

      <div className="toolbar sessions-toolbar project-tree-toolbar">
        <div className="sessions-search-wrap" style={{ flex: 1 }}>
          <Search size={15} className="sessions-search-icon" />
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects and sessions…"
          />
        </div>
        <div className="sort-compact-wrap" title="Sort projects">
          <ArrowUpDown size={16} className="sort-compact-icon" aria-hidden />
          <select
            className="select sort-compact"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            aria-label="Sort projects"
          >
            <option value="updated">Last active</option>
            <option value="name">Name</option>
            <option value="sessions">Session count</option>
          </select>
        </div>
        <Button
          className={`ghost icon-btn sessions-refresh${isFetching ? ' is-spinning' : ''}`}
          type="button"
          aria-label="Refresh"
          title="Refresh"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw size={16} aria-hidden />
        </Button>
        <label className="projects-show-archived">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Archived projects
        </label>
        <label className="projects-show-archived">
          <input
            type="checkbox"
            checked={showArchivedSessions}
            onChange={(e) => setShowArchivedSessions(e.target.checked)}
          />
          Archived sessions
        </label>
      </div>

      <Modal
        open={formOpen}
        title={editing ? `Edit project — ${editing.name}` : 'New project'}
        onClose={closeForm}
        className="modal-card-wide"
      >
        {projectForm}
      </Modal>

      <ProjectTreeList
        projects={projects}
        searchQuery={query}
        expandProjectId={expandProjectId}
        showArchivedSessions={showArchivedSessions}
        onEditProject={openEdit}
        onNewProject={() => {
          setEditing(null)
          setForm(DEFAULT_FORM)
          setShowCreate(true)
        }}
      />
    </div>
  )
}
