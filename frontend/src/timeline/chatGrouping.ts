import type { ToolCallViewModel } from '../components/terminal/ToolCallBlock'
import { toolEntryToViewModel } from '../lib/toolPresentation'
import type { InteractionEntryPayload, TimelineEntry, ToolEntryPayload } from './types'

export type ChatDisplayItem =
  | { type: 'entry'; key: string; entry: TimelineEntry }
  | { type: 'tool_group'; key: string; members: TimelineEntry[] }
  | { type: 'work_group'; key: string; members: TimelineEntry[]; finalEntry: TimelineEntry | null }

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

function groupTurnAfterUser(slice: TimelineEntry[]): ChatDisplayItem[] {
  if (!slice.length) return []

  const assistants = slice.filter((e) => e.kind === 'assistant_text')
  const finalEntry = assistants.length ? assistants[assistants.length - 1]! : null
  const workEntries = finalEntry
    ? slice.filter((e) => e.key !== finalEntry.key)
    : [...slice]

  const out: ChatDisplayItem[] = []

  if (workEntries.length > 0) {
    out.push({
      type: 'work_group',
      key: `work:${workEntries[0]!.key}`,
      members: workEntries,
      finalEntry,
    })
  }

  if (finalEntry) {
    out.push({ type: 'entry', key: finalEntry.key, entry: finalEntry })
  }

  return out
}

/**
 * Chat layout: user → [work group: tools/reasoning/intermediate blocks] → final assistant text.
 * Within the work group, consecutive tool/approval rows still form tool_run groups.
 */
export function groupChatEntries(entries: TimelineEntry[]): ChatDisplayItem[] {
  const out: ChatDisplayItem[] = []
  let i = 0

  while (i < entries.length) {
    const entry = entries[i]!
    if (entry.kind !== 'user') {
      const { slice, next } = sliceUntilNextUser(entries, i)
      out.push(...groupToolBatchEntries(slice))
      i = next
      continue
    }

    out.push({ type: 'entry', key: entry.key, entry })
    i++
    const { slice, next } = sliceUntilNextUser(entries, i)
    out.push(...groupTurnAfterUser(slice))
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
