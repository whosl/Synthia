import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, Play, RefreshCw, Server } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  formatVivadoTime,
  getVivadoHealth,
  listVivadoCommands,
  listVivadoTargets,
  runVivadoTcl,
} from '../api/vivado'
import { Button } from '../components/common/Button'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'

export default function VivadoPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, refetch, isFetching } = useQuery({ queryKey: ['vivado-health'], queryFn: getVivadoHealth })
  const targetsQ = useQuery({ queryKey: ['vivado-targets'], queryFn: listVivadoTargets })
  const commandsQ = useQuery({ queryKey: ['vivado-commands'], queryFn: () => listVivadoCommands() })
  const target = targetsQ.data?.targets?.[0]

  const [tclInput, setTclInput] = useState('')
  const [autoApprove, setAutoApprove] = useState(true)
  const [consoleLines, setConsoleLines] = useState<string[]>([
    t('vivado.consoleInit1'),
    data?.version || '2022.1',
    t('vivado.consoleInit3'),
  ])

  const handleRun = async () => {
    const cmd = tclInput.trim()
    if (!cmd) return
    setConsoleLines(prev => [...prev, `Vivado% ${cmd}`])
    setTclInput('')
    try {
      const res = await runVivadoTcl(cmd, autoApprove)
      if (res.requires_approval) {
        setConsoleLines(prev => [...prev, t('vivado.approvalRequired')])
        return
      }
      if (res.stdout) setConsoleLines(prev => [...prev, ...(res.stdout || '').split('\n').filter(Boolean).slice(-30)])
      if (res.stderr) setConsoleLines(prev => [...prev, ...(res.stderr || '').split('\n').filter(Boolean).slice(-10)])
      setConsoleLines(prev => [...prev, res.ok ? t('vivado.completed', { n: res.elapsed_sec ?? 0 }) : t('vivado.failed', { error: res.error || res.exit_code })])
      await queryClient.invalidateQueries({ queryKey: ['vivado-commands'] })
    } catch (e) {
      setConsoleLines(prev => [...prev, `# error: ${e instanceof Error ? e.message : String(e)}`])
    }
  }

  const refreshing = isFetching || commandsQ.isFetching

  const handleSaveScript = () => {
    const content = consoleLines.join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'vivado_session.tcl'; a.click()
    URL.revokeObjectURL(url)
  }

  return <div className="page">
    <PageStickyTop>
      <div className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <h1 className="page-title">{t('vivado.title')}</h1>
            <Button
              className={`ghost page-header-action${refreshing ? ' is-spinning' : ''}`}
              onClick={() => { refetch(); commandsQ.refetch() }}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshCw size={14} aria-hidden /> {t('vivado.refresh')}
            </Button>
          </div>
          <p className="page-subtitle">{t('vivado.subtitle')}</p>
        </div>
      </div>
    </PageStickyTop>
    <div className="dashboard-grid">
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title={t('vivado.targetHealth')} actions={<StatusBadge status={data?.reachable ? 'connected' : 'error'} />}>
          <div className="health-row"><span>{t('vivado.host')}</span><span>{data?.host || String(target?.host || t('vivado.notConfigured'))}</span><Server size={15} color="var(--muted)" /></div>
          <div className="health-row"><span>{t('vivado.ssh')}</span><span>{data?.reachable ? t('vivado.connected') : data?.error || t('vivado.disconnected')}</span><StatusBadge status={data?.reachable ? 'connected' : 'error'} /></div>
          <div className="health-row"><span>{t('vivado.vivadoPath')}</span><span className="mono" style={{ fontSize: 12 }}>{data?.vivado_path || 'vivado'}</span><CheckCircle2 size={15} color="var(--success)" /></div>
          <div className="health-row"><span>{t('vivado.version')}</span><span>{data?.version || t('vivado.unknown')}</span><span className="muted">{isFetching ? t('vivado.checking') : ''}</span></div>
        </Panel>
        <Panel title={t('vivado.tclConsole')}>
          <div className="command-console">{consoleLines.join('\n')}</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12 }} className="muted">
            <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} />
            {t('vivado.autoApproveTcl')}
          </label>
          <textarea className="textarea" placeholder={t('vivado.tclPlaceholder')} style={{ marginTop: 8 }} value={tclInput} onChange={e => setTclInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRun() } }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button className="primary" onClick={handleRun} disabled={!tclInput.trim()}><Play size={14} /> {t('vivado.run')}</Button>
            <Button className="ghost" onClick={handleSaveScript}><Download size={14} /> {t('vivado.saveScript')}</Button>
          </div>
        </Panel>
      </div>
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title={t('vivado.commandHistory')} actions={<span className="muted" style={{ fontSize: 12 }}>{t('vivado.records', { n: commandsQ.data?.commands?.length ?? 0 })}</span>}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th className="table-col-time">{t('vivado.tableTime')}</th><th>{t('vivado.tableType')}</th><th className="table-col-command">{t('vivado.tableCommand')}</th><th>{t('vivado.tableStatus')}</th></tr></thead>
              <tbody>
                {(commandsQ.data?.commands?.length
                  ? commandsQ.data.commands.slice(0, 12).map((c) => {
                    const commandText = String(c.command_text || c.command || c.id)
                    return (
                      <tr key={c.id}>
                        <td className="mono muted table-col-time" style={{ fontSize: 11 }}>{formatVivadoTime(c.started_at)}</td>
                        <td className="muted">{c.command_type || '—'}</td>
                        <td className="mono table-col-command" style={{ fontSize: 11 }} title={commandText}>
                          {commandText}
                        </td>
                        <td><StatusBadge status={String(c.state || c.status || 'unknown')} /></td>
                      </tr>
                    )
                  })
                  : <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>{t('vivado.noHistory')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title={t('vivado.runtime')}>
          <div className="metric-grid">
            <div className="metric-card"><div className="metric-label">{t('vivado.target')}</div><div className="metric-value" style={{ fontSize: 18 }}>{data?.target || t('vivado.targetDefault')}</div></div>
            <div className="metric-card"><div className="metric-label">{t('nav.vivado')}</div><div className="metric-value" style={{ fontSize: 18 }}>{data?.version || '—'}</div></div>
            <div className="metric-card"><div className="metric-label">{t('vivado.ssh')}</div><div className="metric-value" style={{ fontSize: 18 }}>{data?.reachable ? t('vivado.up') : t('vivado.down')}</div></div>
            <div className="metric-card"><div className="metric-label">{t('vivado.cli')}</div><div className="metric-value mono" style={{ fontSize: 12 }}>{t('vivado.cliValue')}</div></div>
          </div>
        </Panel>
      </div>
    </div>
  </div>
}