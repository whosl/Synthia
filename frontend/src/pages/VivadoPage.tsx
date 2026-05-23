import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Download, Play, RefreshCw, Server } from 'lucide-react'
import { useState } from 'react'
import { getVivadoHealth, listVivadoCommands, listVivadoTargets, runVivadoTcl } from '../api/vivado'
import { Button } from '../components/common/Button'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'

export default function VivadoPage() {
  const { data, refetch, isFetching } = useQuery({ queryKey: ['vivado-health'], queryFn: getVivadoHealth })
  const targetsQ = useQuery({ queryKey: ['vivado-targets'], queryFn: listVivadoTargets })
  const commandsQ = useQuery({ queryKey: ['vivado-commands'], queryFn: listVivadoCommands })
  const target = targetsQ.data?.targets?.[0]

  const [tclInput, setTclInput] = useState('')
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
      const res = await runVivadoTcl(cmd, true)
      if (res.requires_approval) {
        setConsoleLines(prev => [...prev, 'Approval required — enable auto-approve or use Terminal approval flow'])
        return
      }
      if (res.stdout) setConsoleLines(prev => [...prev, ...(res.stdout || '').split('\n').filter(Boolean).slice(-30)])
      if (res.stderr) setConsoleLines(prev => [...prev, ...(res.stderr || '').split('\n').filter(Boolean).slice(-10)])
      setConsoleLines(prev => [...prev, res.ok ? `# completed (${res.elapsed_sec ?? 0}s)` : `# failed: ${res.error || res.exit_code}`])
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
        <p className="page-subtitle">Remote target health, Tcl console, and command history</p>
      </div>
      <Button className="ghost" onClick={() => refetch()}><RefreshCw size={14} /> Refresh</Button>
    </div>
    <div className="dashboard-grid">
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title="Target Health" actions={<StatusBadge status={data?.reachable ? 'connected' : 'error'} />}>
          <div className="health-row"><span>Host</span><span>{data?.host || String(target?.host || 'not configured')}</span><Server size={15} color="var(--muted)" /></div>
          <div className="health-row"><span>SSH</span><span>{data?.reachable ? 'Connected' : data?.error || 'Disconnected'}</span><StatusBadge status={data?.reachable ? 'connected' : 'error'} /></div>
          <div className="health-row"><span>Vivado Path</span><span className="mono" style={{ fontSize: 12 }}>{data?.vivado_path || 'vivado'}</span><CheckCircle2 size={15} color="var(--success)" /></div>
          <div className="health-row"><span>Version</span><span>{data?.version || 'Unknown'}</span><span className="muted">{isFetching ? 'checking...' : ''}</span></div>
          <div className="health-row"><span>License</span><span>{data?.reachable ? 'Available' : 'Unknown'}</span><StatusBadge status={data?.reachable ? 'connected' : 'warning'} /></div>
        </Panel>
        <Panel title="Tcl Console">
          <div className="command-console">{consoleLines.join('\n')}</div>
          <textarea className="textarea" placeholder="Enter Tcl command..." style={{ marginTop: 12 }} value={tclInput} onChange={e => setTclInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRun() } }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button className="primary" onClick={handleRun} disabled={!tclInput.trim()}><Play size={14} /> Run</Button>
            <Button className="ghost" onClick={handleSaveScript}><Download size={14} /> Save Script</Button>
          </div>
        </Panel>
      </div>
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title="Command History">
          <table className="table">
            <thead><tr><th>Time</th><th>Command</th><th>Status</th></tr></thead>
            <tbody>
              {(commandsQ.data?.commands?.length
                ? commandsQ.data.commands.slice(0, 8).map((c: Record<string, unknown>, i: number) => (
                  <tr key={i}><td className="mono muted">—</td><td className="mono">{String(c.command_text || c.name || c.id)}</td><td><StatusBadge status={c.state as string || 'done'} /></td></tr>
                ))
                : <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 24 }}>No command history yet</td></tr>
              )}
            </tbody>
          </table>
        </Panel>
        <Panel title="Runtime">
          <div className="metric-grid">
            <div className="metric-card"><div className="metric-label">Target</div><div className="metric-value" style={{ fontSize: 18 }}>{data?.target || 'default-remote'}</div></div>
            <div className="metric-card"><div className="metric-label">Vivado</div><div className="metric-value" style={{ fontSize: 18 }}>{data?.version || '2022.1'}</div></div>
            <div className="metric-card"><div className="metric-label">SSH</div><div className="metric-value" style={{ fontSize: 18 }}>{data?.reachable ? 'Up' : 'Down'}</div></div>
            <div className="metric-card"><div className="metric-label">Work Dir</div><div className="metric-value mono" style={{ fontSize: 13 }}>{String(data?.work_dir || '/tmp/edagent_remote')}</div></div>
          </div>
        </Panel>
      </div>
    </div>
  </div>
}
