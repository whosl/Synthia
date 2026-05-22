import { CheckCircle2, ChevronDown, ChevronRight, CircleDotDashed } from 'lucide-react'
import type { ToolBlockState } from '../../lib/eventReducer'
import { useTerminalStore } from '../../stores/terminalStore'

export function ToolCallBlock({ tool }: { tool: ToolBlockState }) {
  const collapsed = useTerminalStore((s) => s.collapsed[tool.id] ?? true)
  const toggle = useTerminalStore((s) => s.toggleCollapsed)
  const done = tool.state === 'completed'
  return <div className={`trace-block tool-block ${done ? 'completed' : ''}`}>
    <div className="trace-header" onClick={() => toggle(tool.id)}>
      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      {done ? <CheckCircle2 size={14} color="var(--success)" /> : <CircleDotDashed size={14} color="var(--warning)" />}
      <span>{tool.name}</span><span className="spacer" /><span className="tool-state">{tool.state}</span>
    </div>
    {!collapsed && <div className="trace-body">
      {tool.args && <><b>Input</b>{'\n'}{tool.args}{'\n\n'}</>}
      {tool.result || 'No result summary yet.'}
    </div>}
  </div>
}
