import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTerminalStore } from '../../stores/terminalStore'

export function ReasoningBlock({ id, text, state }: { id: string; text: string; state: string }) {
  const collapsed = useTerminalStore((s) => s.collapsed[id] ?? true)
  const toggle = useTerminalStore((s) => s.toggleCollapsed)
  return <div className="trace-block reasoning-block">
    <div className="trace-header" onClick={() => toggle(id)}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />} Reasoning <span className="spacer" /><span className="muted">{state}</span></div>
    {!collapsed && <div className="trace-body">{text || 'Reasoning captured as event stream.'}</div>}
  </div>
}
