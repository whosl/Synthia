import { ChevronRight } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
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
  splitToolRunSegments,
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
  sticky,
  onInteractionRespond,
}: {
  entry: TimelineEntry
  sticky?: boolean
  onInteractionRespond?: ToolRunGroupProps['onInteractionRespond']
}) {
  return (
    <div className={`tool-run-approval${sticky ? ' sticky-pending-approval' : ''}`}>
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

interface ToolRunBatchSegmentProps {
  segmentKey: string
  members: TimelineEntry[]
  taskActive: boolean
  onInteractionRespond?: ToolRunGroupProps['onInteractionRespond']
}

/** Collapsible summary for one contiguous approval+tool stretch (no pending rows). */
function ToolRunBatchSegment({
  segmentKey,
  members,
  taskActive,
  onInteractionRespond,
}: ToolRunBatchSegmentProps) {
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
  const userCollapsed = useTerminalStore((s) => s.collapsed[segmentKey] ?? true)
  const expanded = forceExpanded ? true : !userCollapsed
  const toggle = useTerminalStore((s) => s.toggleCollapsed)

  const showSummary = tools.length > 0
  const showDetails = showSummary && (expanded || hasRunning)

  const shouldShowMember = (entry: TimelineEntry): boolean => {
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
      <>
        {members.map((entry) =>
          isApprovalInteractionEntry(entry) ? (
            <ApprovalInGroup
              key={entry.key}
              entry={entry}
              onInteractionRespond={onInteractionRespond}
            />
          ) : null,
        )}
      </>
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
    <>
      {primaryFailure && <ToolFailureCard model={primaryFailure} />}
      {showSummary && (
        <button
          type="button"
          className={`tool-run-summary${expanded ? ' expanded' : ''}`}
          onClick={() => {
            if (!forceExpanded) toggle(segmentKey, true)
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
    </>
  )
}

export function ToolRunGroup({
  groupKey,
  members,
  taskActive = false,
  onInteractionRespond,
}: ToolRunGroupProps) {
  const segments = useMemo(() => splitToolRunSegments(members), [members])
  const lastPendingKey = useMemo(() => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]
      if (seg?.type === 'pending') return seg.entry.key
    }
    return null
  }, [segments])

  if (segments.length === 1 && segments[0]?.type === 'pending') {
    const entry = segments[0].entry
    return (
      <div className="message-turn assistant timeline-entry kind-tool-group">
        <ApprovalInGroup
          entry={entry}
          sticky
          onInteractionRespond={onInteractionRespond}
        />
      </div>
    )
  }

  return (
    <div className="message-turn assistant timeline-entry kind-tool-group">
      {segments.map((segment, index) => {
        if (segment.type === 'pending') {
          return (
            <ApprovalInGroup
              key={segment.entry.key}
              entry={segment.entry}
              sticky={segment.entry.key === lastPendingKey}
              onInteractionRespond={onInteractionRespond}
            />
          )
        }
        const segmentKey = `${groupKey}:seg:${segment.members[0]?.key ?? index}`
        return (
          <Fragment key={segmentKey}>
            <ToolRunBatchSegment
              segmentKey={segmentKey}
              members={segment.members}
              taskActive={taskActive}
              onInteractionRespond={onInteractionRespond}
            />
          </Fragment>
        )
      })}
    </div>
  )
}
