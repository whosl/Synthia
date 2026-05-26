import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  createProjectFromWizard,
  importXpr,
  scanProject,
  type ScanProjectResult,
} from '../api/projects'
import { Button } from '../components/common/Button'
import { PageStickyTop } from '../components/layout/PageStickyTop'

type Mode = 'xpr' | 'scan' | 'wizard'

export default function ProjectImportPage() {
  const [mode, setMode] = useState<Mode>('xpr')

  return (
    <div className="page projects-page">
      <PageStickyTop>
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Import / Create Project</h1>
            <p className="muted page-subtitle">
              Import Vivado .xpr, scan a directory, or create a new project with the wizard.
            </p>
          </div>
          <Link to="/" className="syn-link">
            Back to projects
          </Link>
        </div>
        <div className="syn-tabs" role="tablist">
          {(['xpr', 'scan', 'wizard'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? 'active' : ''}
              onClick={() => setMode(m)}
            >
              {m === 'xpr' ? 'Import .xpr' : m === 'scan' ? 'Scan directory' : 'New wizard'}
            </button>
          ))}
        </div>
      </PageStickyTop>

      {mode === 'xpr' && <ImportXprForm />}
      {mode === 'scan' && <ScanForm />}
      {mode === 'wizard' && <WizardForm />}
    </div>
  )
}

function ImportXprForm() {
  const navigate = useNavigate()
  const [path, setPath] = useState('')
  const mutation = useMutation({
    mutationFn: () => importXpr(path.trim()),
    onSuccess: (data) => {
      if (data.project_id) navigate(`/projects/${data.project_id}`)
    },
  })

  return (
    <section className="card syn-form">
      <label className="field-label" htmlFor="xpr-path">
        .xpr path
      </label>
      <input
        id="xpr-path"
        className="input"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="E:/projects/uart/uart.xpr"
      />
      <div className="form-actions">
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !path.trim()}>
          {mutation.isPending ? 'Importing…' : 'Import'}
        </Button>
      </div>
      {mutation.error && <p className="error-text">{(mutation.error as Error).message}</p>}
      {mutation.data && (
        <pre className="mono syn-result">{JSON.stringify(mutation.data, null, 2)}</pre>
      )}
    </section>
  )
}

function ScanForm() {
  const [root, setRoot] = useState('')
  const [result, setResult] = useState<ScanProjectResult | null>(null)
  const mutation = useMutation({
    mutationFn: () => scanProject(root.trim()),
    onSuccess: setResult,
  })

  return (
    <section className="card syn-form">
      <label className="field-label" htmlFor="scan-root">
        Directory to scan
      </label>
      <input
        id="scan-root"
        className="input"
        value={root}
        onChange={(e) => setRoot(e.target.value)}
        placeholder="examples/uart_demo"
      />
      <div className="form-actions">
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !root.trim()}>
          Scan
        </Button>
      </div>
      {mutation.error && <p className="error-text">{(mutation.error as Error).message}</p>}
      {result && (
        <div className="syn-scan-result">
          <h3>Detected</h3>
          <ul>
            <li>{result.xpr_files?.length ?? 0} .xpr files</li>
            <li>{(result.rtl_files?.length ?? 0) + (result.sv_files?.length ?? 0)} RTL files</li>
            <li>{result.xdc_files?.length ?? 0} constraint files</li>
            <li>Top candidates: {result.candidate_top_modules?.join(', ') || '—'}</li>
            <li>Detected part: {result.detected_part || '—'}</li>
          </ul>
        </div>
      )}
    </section>
  )
}

function WizardForm() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [part, setPart] = useState('')
  const [top, setTop] = useState('')
  const [rtl, setRtl] = useState('')
  const mutation = useMutation({
    mutationFn: () =>
      createProjectFromWizard({
        name: name.trim(),
        location: location.trim(),
        part: part.trim() || undefined,
        top_module: top.trim() || undefined,
        rtl_sources: rtl
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
        copy_sources: true,
      }),
    onSuccess: (data) => navigate(`/projects/${data.project_id}`),
  })

  return (
    <section className="card syn-form">
      <label className="field-label">Project name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="field-label">Parent directory</label>
      <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
      <label className="field-label">Part (optional)</label>
      <input className="input" value={part} onChange={(e) => setPart(e.target.value)} />
      <label className="field-label">Top module (optional)</label>
      <input className="input" value={top} onChange={(e) => setTop(e.target.value)} />
      <label className="field-label">RTL sources (comma or newline separated)</label>
      <textarea className="input" rows={4} value={rtl} onChange={(e) => setRtl(e.target.value)} />
      <div className="form-actions">
        <Button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !name.trim() || !location.trim()}
        >
          Create project
        </Button>
      </div>
      {mutation.error && <p className="error-text">{(mutation.error as Error).message}</p>}
    </section>
  )
}
