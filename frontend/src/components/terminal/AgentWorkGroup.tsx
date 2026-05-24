import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  buildWorkGroupSummary,
  collectWorkTools,
  formatWorkGroupSummaryLine,
  isAssistantFinalComplete,
} from '../../lib/workGroupPresentation'
import { groupToolBatchEntries, type ChatDisplayItem } from '../../timeline/chatGrouping'
import type { TimelineEntry } from '../../timeline/types'
import { useTerminalStore } from '../../stores/terminalStore'
import { TimelineEntryView } from './TimelineEntryView'
import { ToolRunGroup } from './ToolRunGroup'

interface AgentWorkGroupProps {
  groupKey: string
  members: TimelineEntry[]
  finalEntry: TimelineEntry | null
  taskActive?: boolean
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

function renderInnerItem(
  item: ChatDisplayItem,
  taskActive: boolean,
  onInteractionRespond?: AgentWorkGroupProps['onInteractionRespond'],
) {
  if (item.type === 'tool_group') {
    return (
      <ToolRunGroup
        key={item.key}
        groupKey={item.key}
        members={item.members}
        taskActive={taskActive}
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

export function AgentWorkGroup({
  groupKey,
  members,
  finalEntry,
  taskActive = false,
  onInteractionRespond,
}: AgentWorkGroupProps) {
  const innerItems = useMemo(() => groupToolBatchEntries(members), [members])
  const tools = useMemo(() => collectWorkTools(members), [members])
  const hasRunning = tools.some((t) => t.state === 'running')
  const finalComplete = isAssistantFinalComplete(finalEntry)

  const summaryLine = formatWorkGroupSummaryLine(
    buildWorkGroupSummary(members, finalEntry),
  )

  const [latchedOpen, setLatchedOpen] = useState(false)

  useEffect(() => {
    if (!finalComplete || taskActive || hasRunning) {
      setLatchedOpen(true)
      return
    }
    setLatchedOpen(false)
  }, [finalComplete, taskActive, hasRunning])

  const forceExpanded = latchedOpen || !finalEntry
  const userCollapsed = useTerminalStore((s) => s.collapsed[groupKey] ?? true)
  const expanded = forceExpanded ? true : !userCollapsed
  const toggle = useTerminalStore((s) => s.toggleCollapsed)

  return (
    <div className="message-turn assistant timeline-entry kind-tool-group kind-work-group">
      <button
        type="button"
        className={`tool-run-summary${expanded ? ' expanded' : ''}`}
        onClick={() => {
          if (!forceExpanded) toggle(groupKey, true)
        }}
        aria-expanded={expanded}
      >
        <ChevronRight size={14} className="tool-run-summary-chevron" />
        <span>{summaryLine}</span>
      </button>
      {expanded && (
        <div className="tool-run-details agent-work-details">
          {innerItems.map((item) => renderInnerItem(item, taskActive, onInteractionRespond))}
        </div>
      )}
    </div>
  )
}
