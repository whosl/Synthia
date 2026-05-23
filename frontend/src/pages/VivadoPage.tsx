import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, Play, RefreshCw, Server } from 'lucide-react'
import { useState } from 'react'
import {
  formatVivadoTime,
  getVivadoHealth,
  listVivadoCommands,
  listVivadoTargets,
  runVivadoTcl,
} from '../api/vivado'
import { Button } from '../components/common/Button'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'

export default function VivadoPage() {
  const queryClient = useQueryClient()
  const { data, refetch, isFetching } = useQuery({ queryKey: ['vivado-health'], queryFn: getVivadoHealth })
  const targetsQ = useQuery({ queryKey: ['vivado-targets'], queryFn: listVivadoTargets })
  const commandsQ = useQuery({ queryKey: ['vivado-commands'], queryFn: () => listVivadoCommands() })
  const target = targetsQ.data?.targets?.[0]

  const [tclInput, setTclInput] = useState('')
  const [autoApprove, setAutoApprove] = useState(true)
  const [consoleLines, setConsoleLines] = useState<string[]>([
    'Vivado% version -short',
    data?.version || '2022.1',
    'Vivado% ready',
  ])

  const handleRun = async () => {
    const cmd = tclInput.trim()
    if (!cmd) return
    setConsoleLines(prev => [...prev, `Vivado% ${cmd}`])
    setTclInput('')
    try {
      const res = await runVivadoTcl(cmd, autoApprove)
      if (res.requires_approval) {
        setConsoleLines(prev => [...prev, 'Policy requires approval — disable dangerous Tcl or enable auto-approve in Settings'])
        return
      }
      if (res.stdout) setConsoleLines(prev => [...prev, ...(res.stdout || '').split('\n').filter(Boolean).slice(-30)])
      if (res.stderr) setConsoleLines(prev => [...prev, ...(res.stderr || '').split('\n').filter(Boolean).slice(-10)])
      setConsoleLines(prev => [...prev, res.ok ? `# completed (${res.elapsed_sec ?? 0}s)` : `# failed: ${res.error || res.exit_code}`])
      await queryClient.invalidateQueries({ queryKey: ['vivado-commands'] })
    } catch (e) {
      setConsoleLines(prev => [...prev, `# error: ${e instanceof Error ? e.message : String(e)}`])
    }
  }

  const handleSaveScript = () => {
    const content = consoleLines.join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'vivado_session.tcl'; a.click()
    URL.revokeObjectURL(url)
  }

  return <div className="page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Vivado Runtime</h1>
        <p className="page-subtitle">Remote target health, Tcl console, and command history (Phase 3A)</p>
      </div>
      <Button className="ghost" onClick={() => { refetch(); commandsQ.refetch() }}><RefreshCw size={14} /> Refresh</Button>
    </div>
    <div className="dashboard-grid">
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title="Target Health" actions={<StatusBadge status={data?.reachable ? 'connected' : 'error'} />}>
          <div className="health-row"><span>Host</span><span>{data?.host || String(target?.host || 'not configured')}</span><Server size={15} color="var(--muted)" /></div>
          <div className="health-row"><span>SSH</span><span>{data?.reachable ? 'Connected' : data?.error || 'Disconnected'}</span><StatusBadge status={data?.reachable ? 'connected' : 'error'} /></div>
          <div className="health-row"><span>Vivado Path</span><span className="mono" style={{ fontSize: 12 }}>{data?.vivado_path || 'vivado'}</span><CheckCircle2 size={15} color="var(--success)" /></div>
          <div className="health-row"><span>Version</span><span>{data?.version || 'Unknown'}</span><span className="muted">{isFetching ? 'checking...' : ''}</span></div>
        </Panel>
        <Panel title="Tcl Console">
          <div className="command-console">{consoleLines.join('\n')}</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12 }} className="muted">
            <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} />
            Auto-approve policy-checked Tcl (matches CLI --yes)
          </label>
          <textarea className="textarea" placeholder="Enter Tcl command..." style={{ marginTop: 8 }} value={tclInput} onChange={e => setTclInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRun() } }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button className="primary" onClick={handleRun} disabled={!tclInput.trim()}><Play size={14} /> Run</Button>
            <Button className="ghost" onClick={handleSaveScript}><Download size={14} /> Save Script</Button>
          </div>
        </Panel>
      </div>
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title="Command History" actions={<span className="muted" style={{ fontSize: 12 }}>{commandsQ.data?.commands?.length ?? 0} records</span>}>
          <table className="table">
            <thead><tr><th>Time</th><th>Type</th><th>Command</th><th>Status</th></tr></thead>
            <tbody>
              {(commandsQ.data?.commands?.length
                ? commandsQ.data.commands.slice(0, 12).map((c) => (
                  <tr key={c.id}>
                    <td className="mono muted" style={{ fontSize: 11 }}>{formatVivadoTime(c.started_at)}</td>
                    <td className="muted">{c.command_type || '—'}</td>
                    <td className="mono" style={{ fontSize: 11, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={String(c.command_text || c.command || '')}>
                      {String(c.command_text || c.command || c.id).slice(0, 80)}
                    </td>
                    <td><StatusBadge status={String(c.state || c.status || 'unknown')} /></td>
                  </tr>
                ))
                : <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>No command history yet — run Tcl or use Agent tools</td></tr>
              )}
            </tbody>
          </table>
        </Panel>
        <Panel title="Runtime">
          <div className="metric-grid">
            <div className="metric-card"><div className="metric-label">Target</div><div className="metric-value" style={{ fontSize: 18 }}>{data?.target || 'default-remote'}</div></div>
            <div className="metric-card"><div className="metric-label">Vivado</div><div className="metric-value" style={{ fontSize: 18 }}>{data?.version || '—'}</div></div>
            <div className="metric-card"><div className="metric-label">SSH</div><div className="metric-value" style={{ fontSize: 18 }}>{data?.reachable ? 'Up' : 'Down'}</div></div>
            <div className="metric-card"><div className="metric-label">CLI</div><div className="metric-value mono" style={{ fontSize: 12 }}>edagent vivado health</div></div>
          </div>
        </Panel>
      </div>
    </div>
  </div>
}
