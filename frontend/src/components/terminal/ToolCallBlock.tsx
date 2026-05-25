import { AlertCircle, CheckCircle2, ChevronRight, CircleDotDashed, Octagon, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveToolElapsedMs } from '../../lib/toolElapsed'
import { useTerminalStore } from '../../stores/terminalStore'
import { CollapsibleSection } from '../common/CollapsibleSection'

export interface ToolCallViewModel {
  id: string
  name: string
  state: 'running' | 'completed' | 'error' | 'rejected' | 'stopped'
  args?: string
  result?: string
  error?: string
  startedAt?: number
  startedAtMs?: number
  elapsedMs?: number
  completedAtMs?: number
}

function formatElapsed(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const sec = Math.floor(ms / 1000) % 60
  const min = Math.floor(ms / 60_000)
  return `${min}m ${sec}s`
}

function useToolElapsed(tool: ToolCallViewModel) {
  const [tick, setTick] = useState(() => Date.now())
  const running = tool.state === 'running'

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setTick(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [running])

  return useMemo(() => {
    const completedAtMs = running ? tick : tool.completedAtMs
    return resolveToolElapsedMs(tool, { completedAtMs })
  }, [tool, running, tick])
}

export function ToolCallBlock({
  tool,
  defaultCollapsed = true,
}: {
  tool: ToolCallViewModel
  /** Default fold state when user has not toggled this tool yet */
  defaultCollapsed?: boolean
}) {
  const { t } = useTranslation()
  const collapsed = useTerminalStore((s) => s.collapsed[tool.id] ?? defaultCollapsed)
  const toggle = useTerminalStore((s) => s.toggleCollapsed)
  const elapsedMs = useToolElapsed(tool)
  const done = tool.state === 'completed'
  const rejected = tool.state === 'rejected'
  const errored = tool.state === 'error'
  const stopped = tool.state === 'stopped'
  const icon = done ? <CheckCircle2 size={14} className="tool-status-icon is-done" />
    : rejected ? <XCircle size={14} className="tool-status-icon is-rejected" />
    : stopped ? <Octagon size={14} className="tool-status-icon is-stopped" />
    : errored ? <AlertCircle size={14} className="tool-status-icon is-errored" />
    : <CircleDotDashed size={14} className="tool-status-icon is-running" />
  return (
    <div
      className={`trace-block tool-block ${done ? 'completed' : ''} ${rejected ? 'rejected' : ''} ${errored ? 'errored' : ''} ${stopped ? 'stopped' : ''}${collapsed ? '' : ' is-expanded'}`}
    >
      <div
        className="trace-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => toggle(tool.id, defaultCollapsed)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle(tool.id, defaultCollapsed)
          }
        }}
      >
        <ChevronRight size={14} className="trace-chevron" />
        {icon}
        <span>{tool.name}</span>
        {elapsedMs != null && (
          <span className={`tool-elapsed${tool.state === 'running' ? ' tool-elapsed-live' : ''}`}>
            {formatElapsed(elapsedMs)}
          </span>
        )}
        <span className="spacer" /><span className="tool-state">{tool.state}</span>
      </div>
      <CollapsibleSection open={!collapsed} className="trace-body-wrap">
        <div className="trace-body">
          {tool.args && <><b>{t('toolBlock.input')}</b>{'\n'}{tool.args}{'\n\n'}</>}
          {errored && tool.error && <><b style={{ color: 'var(--error)' }}>{t('toolBlock.error')}</b>{'\n'}{tool.error}{'\n\n'}</>}
          <><b>{t('toolBlock.output')}</b>{'\n'}{tool.result || (errored || rejected || stopped ? '' : t('toolBlock.noResult'))}</>
        </div>
      </CollapsibleSection>
    </div>
  )
}
