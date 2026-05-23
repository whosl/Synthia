import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, CircleDotDashed } from 'lucide-react'
import type { ToolBlockState } from '../../lib/eventReducer'
import { useTerminalStore } from '../../stores/terminalStore'

export function ToolCallBlock({ tool }: { tool: ToolBlockState }) {
  const collapsed = useTerminalStore((s) => s.collapsed[tool.id] ?? true)
  const toggle = useTerminalStore((s) => s.toggleCollapsed)
  const done = tool.state === 'completed'
  const errored = tool.state === 'error'
  const icon = done ? <CheckCircle2 size={14} color="var(--success)" />
    : errored ? <AlertCircle size={14} color="var(--error)" />
    : <CircleDotDashed size={14} color="var(--warning)" />
  return <div className={`trace-block tool-block ${done ? 'completed' : ''} ${errored ? 'errored' : ''}`}>
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
      {tool.result || (errored ? '' : 'No result summary yet.')}
    </div>}
  </div>
}
