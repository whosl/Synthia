import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, FolderKanban, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createProject, listProjects } from '../api/projects'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { Panel } from '../components/common/Panel'
import { formatNumber, formatRelative } from '../lib/time'

const DEFAULT_FORM = {
  name: '',
  root_path: '',
  manifest_path: '',
  xpr_path: '',
  part: '',
}

export default function ProjectsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [showCreate, setShowCreate] = useState(false)

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: () => listProjects({ limit: 200 }),
  })

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

  const projects = data?.projects ?? []

  const submitProject = () => {
    if (!form.root_path.trim() || !form.manifest_path.trim()) {
      alert('root_path and manifest_path are required')
      return
    }
    create.mutate({
      name: form.name.trim() || form.root_path.split('/').filter(Boolean).pop() || 'Project',
      root_path: form.root_path.trim(),
      manifest_path: form.manifest_path.trim(),
      xpr_path: form.xpr_path.trim(),
      part: form.part.trim() || undefined,
    })
  }

  return (
    <div className="page projects-page">
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
        <Button className="primary" type="button" onClick={() => setShowCreate((v) => !v)}>
          <Plus size={16} /> New project
        </Button>
      </div>

      {showCreate && (
        <Panel title="Create project">
          <div className="project-create-form">
            <label>
              <span>Name</span>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="uart_full" />
            </label>
            <label>
              <span>Root path *</span>
              <input className="input mono" value={form.root_path} onChange={(e) => setForm({ ...form, root_path: e.target.value })} placeholder="examples/uart_full" />
            </label>
            <label>
              <span>Manifest (Synthia YAML) *</span>
              <input className="input mono" value={form.manifest_path} onChange={(e) => setForm({ ...form, manifest_path: e.target.value })} placeholder="examples/uart_full/eda.yaml" />
            </label>
            <label>
              <span>Vivado .xpr</span>
              <input className="input mono" value={form.xpr_path} onChange={(e) => setForm({ ...form, xpr_path: e.target.value })} placeholder="Optional for non_project flow" />
            </label>
            <label>
              <span>Part</span>
              <input className="input mono" value={form.part} onChange={(e) => setForm({ ...form, part: e.target.value })} placeholder="xc7a35t… or from manifest" />
            </label>
            <div className="project-create-actions">
              <Button className="ghost" type="button" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button className="primary" type="button" onClick={submitProject} disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      <section className="projects-grid">
        {projects.map((p) => (
          <article
            key={p.id}
            className="project-card"
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/projects/${p.id}`)}
            onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/projects/${p.id}`) }}
          >
            <div className="project-card-head">
              <FolderKanban size={18} className="project-card-icon" />
              <strong>{p.name}</strong>
            </div>
            <p className="project-card-path mono">{p.root_path}</p>
            <dl className="project-card-meta">
              <div><dt>Sessions</dt><dd>{formatNumber(p.session_count)}</dd></div>
              <div><dt>Updated</dt><dd>{formatRelative(p.last_active_at || p.updated_at)}</dd></div>
            </dl>
            <div className="project-card-open muted">
              Open sessions <ChevronRight size={14} />
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
