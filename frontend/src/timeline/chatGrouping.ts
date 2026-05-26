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

export function isPendingApprovalEntry(entry: TimelineEntry): boolean {
  return (
    isApprovalInteractionEntry(entry)
    && (entry.payload as InteractionEntryPayload).status === 'pending'
  )
}

/** Pending approvals render in the bottom dock, not inline in the chat list. */
export function filterInlineChatEntries(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.filter((entry) => !isPendingApprovalEntry(entry))
}

/** Pending approvals sorted by event order (seq, then createdAt). */
export function collectPendingApprovalEntries(entries: TimelineEntry[]): TimelineEntry[] {
  return entries
    .filter(isPendingApprovalEntry)
    .sort((a, b) => {
      const seqA = a.seq ?? 0
      const seqB = b.seq ?? 0
      if (seqA !== seqB) return seqA - seqB
      return (a.createdAt ?? 0) - (b.createdAt ?? 0)
    })
}

/** Pending approvals start a new run batch so later cards are not merged above completed tools. */
function canJoinRunBatch(entry: TimelineEntry): boolean {
  if (isPendingApprovalEntry(entry)) return false
  return isToolEntry(entry) || isApprovalInteractionEntry(entry)
}

export type ToolRunSegment =
  | { type: 'pending'; entry: TimelineEntry }
  | { type: 'batch'; members: TimelineEntry[] }

/** Split a tool run group at pending approvals so UI can follow timeline order. */
export function splitToolRunSegments(members: TimelineEntry[]): ToolRunSegment[] {
  const segments: ToolRunSegment[] = []
  let batch: TimelineEntry[] = []

  const flushBatch = () => {
    if (!batch.length) return
    segments.push({ type: 'batch', members: batch })
    batch = []
  }

  for (const entry of members) {
    if (isPendingApprovalEntry(entry)) {
      flushBatch()
      segments.push({ type: 'pending', entry })
      continue
    }
    if (isToolEntry(entry) || isApprovalInteractionEntry(entry)) {
      batch.push(entry)
      continue
    }
    flushBatch()
  }
  flushBatch()
  return segments
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
export function groupToolBatchEntries(entries: TimelineEntry[]): ChatDisplayItem[] {
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

function sliceUntilNextUser(entries: TimelineEntry[], start: number) {
  let end = start
  while (end < entries.length && entries[end].kind !== 'user') end++
  return { slice: entries.slice(start, end), next: end }
}

/**
 * Chat layout preserves backend event order (seq / createdAt).
 * Consecutive tool + completed approval rows may collapse into one tool_group.
 * Pending approvals are excluded here and shown in PendingApprovalDock.
 */
export function groupChatEntries(entries: TimelineEntry[]): ChatDisplayItem[] {
  const out: ChatDisplayItem[] = []
  let i = 0

  while (i < entries.length) {
    const entry = entries[i]!
    if (entry.kind !== 'user') {
      const { slice, next } = sliceUntilNextUser(entries, i)
      out.push(...groupToolBatchEntries(filterInlineChatEntries(slice)))
      i = next
      continue
    }

    out.push({ type: 'entry', key: entry.key, entry })
    i++
    const { slice, next } = sliceUntilNextUser(entries, i)
    out.push(...groupToolBatchEntries(filterInlineChatEntries(slice)))
    i = next
  }

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
