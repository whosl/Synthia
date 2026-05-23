import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  buildFailureCard,
  buildToolGroupSummary,
  formatToolGroupSummaryLine,
  pickPrimaryFailure,
} from '../../lib/toolPresentation'
import {
  isApprovalInteractionEntry,
  isToolEntry,
  memberToToolViewModel,
  partitionRunGroupMembers,
  toolsToViewModels,
} from '../../timeline/chatGrouping'
import { renderTimelineEntry } from '../../timeline/renderers/builtin'
import type { InteractionEntryPayload, TimelineEntry } from '../../timeline/types'
import { useTerminalStore } from '../../stores/terminalStore'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolFailureCard } from './ToolFailureCard'

interface ToolRunGroupProps {
  groupKey: string
  /** Timeline order: approvals and tools as they occurred */
  members: TimelineEntry[]
  taskActive?: boolean
  onInteractionRespond?: (interactionId: string, response: Record<string, unknown>) => void
}

function ApprovalInGroup({
  entry,
  onInteractionRespond,
}: {
  entry: TimelineEntry
  onInteractionRespond?: ToolRunGroupProps['onInteractionRespond']
}) {
  return (
    <div className="tool-run-approval">
      {renderTimelineEntry({ entry, onInteractionRespond })}
    </div>
  )
}

function isPendingApproval(entry: TimelineEntry): boolean {
  return (
    isApprovalInteractionEntry(entry)
    && (entry.payload as InteractionEntryPayload).status === 'pending'
  )
}

export function ToolRunGroup({
  groupKey,
  members,
  taskActive = false,
  onInteractionRespond,
}: ToolRunGroupProps) {
  const { tools: toolEntries } = useMemo(
    () => partitionRunGroupMembers(members),
    [members],
  )

  const tools = toolsToViewModels(toolEntries)
  const primaryFailure = pickPrimaryFailure(tools)
  const summaryLine = formatToolGroupSummaryLine(
    buildToolGroupSummary(tools, primaryFailure),
  )

  const hasRunning = tools.some((t) => t.state === 'running')
  const [latchedOpen, setLatchedOpen] = useState(false)

  useEffect(() => {
    if (hasRunning || taskActive) {
      setLatchedOpen(true)
      return
    }
    if (!hasRunning && !taskActive) {
      setLatchedOpen(false)
    }
  }, [hasRunning, taskActive])

  const forceExpanded = latchedOpen
  const userCollapsed = useTerminalStore((s) => s.collapsed[groupKey] ?? true)
  const expanded = forceExpanded ? true : !userCollapsed
  const toggle = useTerminalStore((s) => s.toggleCollapsed)

  const showSummary = tools.length > 0
  const showDetails = showSummary && (expanded || hasRunning)
  const stickyPending = members.some(isPendingApproval)

  const shouldShowMember = (entry: TimelineEntry): boolean => {
    if (isPendingApproval(entry)) return false
    if (isApprovalInteractionEntry(entry)) return expanded
    if (isToolEntry(entry)) {
      const tool = memberToToolViewModel(entry)
      if (!tool) return false
      if (primaryFailure?.toolId === tool.id) return false
      if (tool.state === 'running') return true
      return expanded
    }
    return false
  }

  const renderMember = (entry: TimelineEntry) => {
    if (isApprovalInteractionEntry(entry)) {
      return (
        <ApprovalInGroup
          key={entry.key}
          entry={entry}
          onInteractionRespond={onInteractionRespond}
        />
      )
    }
    if (isToolEntry(entry)) {
      const tool = memberToToolViewModel(entry)
      if (!tool) return null
      return (
        <ToolCallBlock
          key={tool.id}
          tool={tool}
          defaultCollapsed={tool.state !== 'running'}
        />
      )
    }
    return null
  }

  if (tools.length === 0) {
    return (
      <div
        className={`message-turn assistant timeline-entry kind-tool-group${stickyPending ? ' sticky-pending-approval' : ''}`}
      >
        {members.map((entry) =>
          isApprovalInteractionEntry(entry) ? (
            <ApprovalInGroup
              key={entry.key}
              entry={entry}
              onInteractionRespond={onInteractionRespond}
            />
          ) : null,
        )}
      </div>
    )
  }

  if (tools.length === 1 && primaryFailure && !members.some(isApprovalInteractionEntry)) {
    return (
      <div className="message-turn assistant timeline-entry kind-tool">
        <ToolFailureCard model={primaryFailure} />
      </div>
    )
  }

  return (
    <div
      className={`message-turn assistant timeline-entry kind-tool-group${stickyPending ? ' sticky-pending-approval' : ''}`}
    >
      {primaryFailure && <ToolFailureCard model={primaryFailure} />}
      {members.map((entry) =>
        isPendingApproval(entry) ? (
          <ApprovalInGroup
            key={entry.key}
            entry={entry}
            onInteractionRespond={onInteractionRespond}
          />
        ) : null,
      )}
      {showSummary && (
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
      )}
      {showDetails && (
        <div className="tool-run-details">
          {members.map((entry) =>
            shouldShowMember(entry) ? renderMember(entry) : null,
          )}
        </div>
      )}
    </div>
  )
}
