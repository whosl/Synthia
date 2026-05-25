import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTerminalStore } from '../../stores/terminalStore'

export function ReasoningBlock({ id, text, state }: { id: string; text: string; state: string }) {
  const { t } = useTranslation()
  const collapsed = useTerminalStore((s) => s.collapsed[id] ?? true)
  const toggle = useTerminalStore((s) => s.toggleCollapsed)
  return <div className="trace-block reasoning-block">
    <div className="trace-header" onClick={() => toggle(id)}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />} {t('reasoning.title')} <span className="spacer" /><span className="muted">{state}</span></div>
    <div className={`trace-body collapsible-body${!collapsed ? ' expanded' : ''}`}><div>{text || t('reasoning.empty')}</div></div>
  </div>
}
