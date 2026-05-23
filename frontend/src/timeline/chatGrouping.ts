import type { ToolCallViewModel } from '../components/terminal/ToolCallBlock'
import { toolEntryToViewModel } from '../lib/toolPresentation'
import type { InteractionEntryPayload, TimelineEntry, ToolEntryPayload } from './types'

export type ChatDisplayItem =
  | { type: 'entry'; key: string; entry: TimelineEntry }
  | { type: 'tool_group'; key: string; members: TimelineEntry[] }

export function isApprovalInteractionEntry(entry: TimelineEntry): boolean {
  return (
    entry.kind === 'interaction'
    && (entry.payload as InteractionEntryPayload).interaction_type === 'approval'
  )
}

export function isToolEntry(entry: TimelineEntry): boolean {
  return entry.kind === 'tool'
}

function canJoinRunBatch(entry: TimelineEntry): boolean {
  return isToolEntry(entry) || isApprovalInteractionEntry(entry)
}

export function partitionRunGroupMembers(members: TimelineEntry[]) {
  const approvals: TimelineEntry[] = []
  const tools: TimelineEntry[] = []
  for (const entry of members) {
    if (isApprovalInteractionEntry(entry)) approvals.push(entry)
    else if (isToolEntry(entry)) tools.push(entry)
  }
  return { approvals, tools }
}

/** Consecutive Vivado approvals + tool calls → one collapsible run group. */
export function groupChatEntries(entries: TimelineEntry[]): ChatDisplayItem[] {
  const out: ChatDisplayItem[] = []
  let batch: TimelineEntry[] = []

  const flushBatch = () => {
    if (!batch.length) return
    const key = `tool-group:${batch[0]!.key}`
    out.push({ type: 'tool_group', key, members: batch })
    batch = []
  }

  for (const entry of entries) {
    if (canJoinRunBatch(entry)) {
      batch.push(entry)
      continue
    }
    flushBatch()
    out.push({ type: 'entry', key: entry.key, entry })
  }
  flushBatch()
  return out
}

export function toolsToViewModels(toolEntries: TimelineEntry[]) {
  return toolEntries.map((entry) => memberToToolViewModel(entry)!)
}

export function memberToToolViewModel(entry: TimelineEntry): ToolCallViewModel | null {
  if (!isToolEntry(entry)) return null
  const p = entry.payload as ToolEntryPayload
  return toolEntryToViewModel(p, entry.createdAt)
}
