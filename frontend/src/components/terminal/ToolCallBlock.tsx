import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, CircleDotDashed, XCircle } from 'lucide-react'
import { useTerminalStore } from '../../stores/terminalStore'

export interface ToolCallViewModel {
  id: string
  name: string
  state: 'running' | 'completed' | 'error' | 'rejected'
  args?: string
  result?: string
  error?: string
  startedAt?: number
  elapsedMs?: number
}

export function ToolCallBlock({ tool }: { tool: ToolCallViewModel }) {
  const collapsed = useTerminalStore((s) => s.collapsed[tool.id] ?? true)
  const toggle = useTerminalStore((s) => s.toggleCollapsed)
  const done = tool.state === 'completed'
  const rejected = tool.state === 'rejected'
  const errored = tool.state === 'error'
  const icon = done ? <CheckCircle2 size={14} color="var(--success)" />
    : rejected ? <XCircle size={14} color="var(--error)" />
    : errored ? <AlertCircle size={14} color="var(--error)" />
    : <CircleDotDashed size={14} color="var(--warning)" />
  return <div className={`trace-block tool-block ${done ? 'completed' : ''} ${rejected ? 'rejected' : ''} ${errored ? 'errored' : ''}`}>
    <div className="trace-header" onClick={() => toggle(tool.id)}>
      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      {icon}
      <span>{tool.name}</span>
      {tool.elapsedMs != null && <span className="tool-elapsed">{(tool.elapsedMs / 1000).toFixed(1)}s</span>}
      <span className="spacer" /><span className="tool-state">{tool.state}</span>
    </div>
    {!collapsed && <div className="trace-body">
      {tool.args && <><b>Input</b>{'\n'}{tool.args}{'\n\n'}</>}
      {errored && tool.error && <><b style={{ color: 'var(--error)' }}>Error</b>{'\n'}{tool.error}{'\n\n'}</>}
      <><b>Output</b>{'\n'}{tool.result || (errored || rejected ? '' : 'No result summary yet.')}</>
    </div>}
  </div>
}
