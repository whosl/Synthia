import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, CircleDotDashed, Octagon, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { resolveToolElapsedMs } from '../../lib/toolElapsed'
import { useTerminalStore } from '../../stores/terminalStore'

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

export function ToolCallBlock({ tool }: { tool: ToolCallViewModel }) {
  const collapsed = useTerminalStore((s) => s.collapsed[tool.id] ?? true)
  const toggle = useTerminalStore((s) => s.toggleCollapsed)
  const elapsedMs = useToolElapsed(tool)
  const done = tool.state === 'completed'
  const rejected = tool.state === 'rejected'
  const errored = tool.state === 'error'
  const stopped = tool.state === 'stopped'
  const icon = done ? <CheckCircle2 size={14} color="var(--success)" />
    : rejected ? <XCircle size={14} color="var(--error)" />
    : stopped ? <Octagon size={14} color="var(--warning)" />
    : errored ? <AlertCircle size={14} color="var(--error)" />
    : <CircleDotDashed size={14} color="var(--warning)" />
  return (
    <div
      className={`trace-block tool-block ${done ? 'completed' : ''} ${rejected ? 'rejected' : ''} ${errored ? 'errored' : ''} ${stopped ? 'stopped' : ''}`}
    >
      <div className="trace-header" onClick={() => toggle(tool.id)}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        {icon}
        <span>{tool.name}</span>
        {elapsedMs != null && (
          <span className={`tool-elapsed${tool.state === 'running' ? ' tool-elapsed-live' : ''}`}>
            {formatElapsed(elapsedMs)}
          </span>
        )}
        <span className="spacer" /><span className="tool-state">{tool.state}</span>
      </div>
      {!collapsed && (
        <div className="trace-body">
          {tool.args && <><b>Input</b>{'\n'}{tool.args}{'\n\n'}</>}
          {errored && tool.error && <><b style={{ color: 'var(--error)' }}>Error</b>{'\n'}{tool.error}{'\n\n'}</>}
          <><b>Output</b>{'\n'}{tool.result || (errored || rejected || stopped ? '' : 'No result summary yet.')}</>
        </div>
      )}
    </div>
  )
}
