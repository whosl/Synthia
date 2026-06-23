import { Brain, ChevronRight, CircleDotDashed } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTerminalStore } from '../../stores/terminalStore'
import { CollapsibleSection } from '../common/CollapsibleSection'

export function ReasoningBlock({ id, text, state }: { id: string; text: string; state: string }) {
  const { t } = useTranslation()
  const collapsed = useTerminalStore((s) => s.collapsed[id] ?? true)
  const toggle = useTerminalStore((s) => s.toggleCollapsed)
  const running = state === 'running'
  const preview = text.trim().replace(/\s+/g, ' ').slice(0, 120)
  return (
    <div className={`trace-block reasoning-block${collapsed ? '' : ' is-expanded'}${running ? ' is-running' : ''}`}>
      <div
        className="trace-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => toggle(id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle(id)
          }
        }}
      >
        <ChevronRight size={14} className="trace-chevron" />
        {running ? <CircleDotDashed size={14} /> : <Brain size={14} />}
        <span>{running ? t('reasoning.working') : t('reasoning.title')}</span>
        {preview && <span className="reasoning-preview">{preview}</span>}
        <span className="spacer" />
        <span className="muted">{state}</span>
      </div>
      <CollapsibleSection open={!collapsed} className="trace-body-wrap">
        <div className="trace-body">{text || t('reasoning.empty')}</div>
      </CollapsibleSection>
    </div>
  )
}
