import { ChevronRight } from 'lucide-react'
import { useMemo } from 'react'
import {
  buildWorkGroupSummary,
  formatWorkGroupSummaryLine,
} from '../../lib/workGroupPresentation'
import { groupToolBatchEntries, type ChatDisplayItem } from '../../timeline/chatGrouping'
import type { TimelineEntry } from '../../timeline/types'
import { useTerminalStore } from '../../stores/terminalStore'
import { TimelineEntryView } from './TimelineEntryView'
import { ToolRunGroup } from './ToolRunGroup'

interface AgentWorkGroupProps {
  groupKey: string
  members: TimelineEntry[]
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

function renderInnerItem(
  item: ChatDisplayItem,
  onInteractionRespond?: AgentWorkGroupProps['onInteractionRespond'],
) {
  if (item.type === 'tool_group') {
    return (
      <ToolRunGroup
        key={item.key}
        groupKey={item.key}
        members={item.members}
        taskActive={false}
        onInteractionRespond={onInteractionRespond}
      />
    )
  }
  if (item.type !== 'entry') return null
  return (
    <TimelineEntryView
      key={item.key}
      entry={item.entry}
      onInteractionRespond={onInteractionRespond}
    />
  )
}

/** Rendered only after the turn completes — collapsed summary by default. */
export function AgentWorkGroup({
  groupKey,
  members,
  onInteractionRespond,
}: AgentWorkGroupProps) {
  const innerItems = useMemo(() => groupToolBatchEntries(members), [members])
  const summaryLine = formatWorkGroupSummaryLine(buildWorkGroupSummary(members, null))
  const userCollapsed = useTerminalStore((s) => s.collapsed[groupKey] ?? true)
  const expanded = !userCollapsed
  const toggle = useTerminalStore((s) => s.toggleCollapsed)

  return (
    <div className="message-turn assistant timeline-entry kind-tool-group kind-work-group">
      <button
        type="button"
        className={`tool-run-summary${expanded ? ' expanded' : ''}`}
        onClick={() => toggle(groupKey, true)}
        aria-expanded={expanded}
      >
        <ChevronRight size={14} className="tool-run-summary-chevron" />
        <span>{summaryLine}</span>
      </button>
      <div className={`tool-run-details agent-work-details collapsible-body${expanded ? ' expanded' : ''}`}>
        <div>
          {innerItems.map((item) => renderInnerItem(item, onInteractionRespond))}
        </div>
      </div>
    </div>
  )
}
