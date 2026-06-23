import type { ToolCallViewModel } from '../components/terminal/ToolCallBlock'
import { toolEntryToViewModel } from '../lib/toolPresentation'
import type {
  ErrorEntryPayload,
  InteractionEntryPayload,
  TimelineEntry,
  ToolEntryPayload,
  TranscriptOrphanGroup,
  TranscriptTurn,
  TranscriptTurnStatus,
} from './types'

export type ChatDisplayItem =
  | { type: 'entry'; key: string; entry: TimelineEntry }
  | { type: 'tool_group'; key: string; members: TimelineEntry[] }

export type TranscriptDisplayItem =
  | { type: 'turn'; key: string; turn: TranscriptTurn; items: ChatDisplayItem[] }
  | { type: 'orphan'; key: string; group: TranscriptOrphanGroup; items: ChatDisplayItem[] }

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

/** Pending approvals stay inline; the bottom dock is a shortcut mirror. */
export function filterInlineChatEntries(entries: TimelineEntry[]): TimelineEntry[] {
  return entries
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

export function filterRedundantErrorEntries(entries: TimelineEntry[]): TimelineEntry[] {
  const hasFailedTool = entries.some((entry) => {
    if (entry.kind !== 'tool') return false
    const state = (entry.payload as ToolEntryPayload).state
    return state === 'error' || state === 'rejected' || state === 'stopped'
  })
  if (!hasFailedTool) return entries
  return entries.filter((entry) => {
    if (entry.kind !== 'error') return true
    const source = (entry.payload as ErrorEntryPayload).source
    return source !== 'run.error'
  })
}

function sliceUntilNextUser(entries: TimelineEntry[], start: number) {
  let end = start
  while (end < entries.length && entries[end].kind !== 'user') end++
  return { slice: entries.slice(start, end), next: end }
}

function deriveTurnStatus(
  turn: Pick<TranscriptTurn, 'taskId' | 'items'>,
  activeTaskId?: string | null,
  activeTaskState?: string,
): TranscriptTurnStatus {
  if (turn.taskId && activeTaskId === turn.taskId) {
    if (activeTaskState === 'stopping' || activeTaskState === 'stopped') return 'stopped'
    if (activeTaskState === 'error') return 'error'
    return 'running'
  }
  if (turn.items.some((entry) => entry.kind === 'error')) return 'error'
  if (turn.items.some((entry) => {
    if (entry.kind === 'tool') {
      return (entry.payload as ToolEntryPayload).state === 'error'
    }
    return false
  })) return 'error'
  if (turn.items.some((entry) => {
    if (entry.kind === 'tool') {
      return (entry.payload as ToolEntryPayload).state === 'stopped'
    }
    if (entry.kind === 'assistant_text') {
      return Boolean((entry.payload as { stopped?: boolean }).stopped)
    }
    return false
  })) return 'stopped'
  if (turn.items.some((entry) => {
    if (entry.kind === 'tool') {
      return (entry.payload as ToolEntryPayload).state === 'running'
    }
    if (entry.kind === 'assistant_text') {
      return Boolean((entry.payload as { partial?: boolean }).partial)
    }
    if (entry.kind === 'reasoning') {
      return (entry.payload as { state?: string }).state === 'running'
    }
    if (isPendingApprovalEntry(entry)) return true
    return false
  })) return 'running'
  return 'done'
}

function isTranscriptTurn(group: TranscriptTurn | TranscriptOrphanGroup): group is TranscriptTurn {
  return (group as TranscriptTurn).user !== undefined
}

export function buildTranscriptTurns(
  entries: TimelineEntry[],
  activeTaskId?: string | null,
  activeTaskState?: string,
): Array<TranscriptTurn | TranscriptOrphanGroup> {
  const turns: TranscriptTurn[] = []
  const orphans: TranscriptOrphanGroup[] = []
  const userByTask = new Map<string, TimelineEntry>()
  const consumed = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'user' && entry.taskId) userByTask.set(entry.taskId, entry)
  }

  let i = 0
  while (i < entries.length) {
    const entry = entries[i]!
    if (consumed.has(entry.key)) {
      i++
      continue
    }

    if (entry.kind !== 'user') {
      const { slice, next } = sliceUntilNextUser(entries, i)
      const items = slice.filter((item) => {
        if (consumed.has(item.key)) return false
        return !(item.taskId && userByTask.has(item.taskId))
      })
      items.forEach((item) => consumed.add(item.key))
      if (items.length) {
        const first = items[0]!
        orphans.push({ key: `orphan:${first.key}`, items })
      }
      i = next
      continue
    }

    consumed.add(entry.key)
    i++
    let items: TimelineEntry[]
    let next = i
    if (entry.taskId) {
      items = entries.filter((item) => (
        item.key !== entry.key
        && !consumed.has(item.key)
        && item.taskId === entry.taskId
      ))
      items.forEach((item) => consumed.add(item.key))
    } else {
      const legacy = sliceUntilNextUser(entries, i)
      items = legacy.slice.filter((item) => !consumed.has(item.key))
      items.forEach((item) => consumed.add(item.key))
      next = legacy.next
    }
    const updatedAt = items.reduce((max, item) => Math.max(max, item.createdAt ?? 0), entry.createdAt ?? 0)
    const turn: TranscriptTurn = {
      key: `turn:${entry.taskId || entry.key}`,
      id: entry.taskId || entry.id,
      taskId: entry.taskId,
      user: entry,
      items,
      status: 'done',
      startedAt: entry.createdAt,
      updatedAt: updatedAt || entry.createdAt,
    }
    turn.status = deriveTurnStatus(turn, activeTaskId, activeTaskState)
    turns.push(turn)
    i = next
  }

  return [...turns, ...orphans].sort((a, b) => {
    const aSeq = isTranscriptTurn(a) ? a.user.seq : a.items[0]?.seq ?? 0
    const bSeq = isTranscriptTurn(b) ? b.user.seq : b.items[0]?.seq ?? 0
    if (aSeq !== bSeq) return aSeq - bSeq
    const aTime = isTranscriptTurn(a) ? a.startedAt ?? 0 : a.items[0]?.createdAt ?? 0
    const bTime = isTranscriptTurn(b) ? b.startedAt ?? 0 : b.items[0]?.createdAt ?? 0
    return aTime - bTime
  })
}

export function buildTranscriptDisplayItems(
  entries: TimelineEntry[],
  activeTaskId?: string | null,
  activeTaskState?: string,
): TranscriptDisplayItem[] {
  return buildTranscriptTurns(entries, activeTaskId, activeTaskState).map((group) => {
    if (isTranscriptTurn(group)) {
      return {
        type: 'turn',
        key: group.key,
        turn: group,
        items: groupToolBatchEntries(filterInlineChatEntries(filterRedundantErrorEntries(group.items))),
      }
    }
    return {
      type: 'orphan',
      key: group.key,
      group,
      items: groupToolBatchEntries(filterInlineChatEntries(filterRedundantErrorEntries(group.items))),
    }
  })
}

/**
 * Chat layout preserves backend event order (seq / createdAt).
 * Consecutive tool + completed approval rows may collapse into one tool_group.
 * Entries with a taskId are grouped under their user turn instead of inferred by adjacency.
 */
export function groupChatEntries(entries: TimelineEntry[]): ChatDisplayItem[] {
  const out: ChatDisplayItem[] = []
  const userByTask = new Map<string, TimelineEntry>()
  for (const entry of entries) {
    if (entry.kind === 'user' && entry.taskId) userByTask.set(entry.taskId, entry)
  }
  const consumed = new Set<string>()
  let i = 0

  while (i < entries.length) {
    const entry = entries[i]!
    if (consumed.has(entry.key)) {
      i++
      continue
    }
    if (entry.kind !== 'user') {
      if (entry.taskId && userByTask.has(entry.taskId)) {
        i++
        continue
      }
      const { slice, next } = sliceUntilNextUser(entries, i)
      const orphanSlice = slice.filter((item) => {
        if (consumed.has(item.key)) return false
        return !(item.taskId && userByTask.has(item.taskId))
      })
      orphanSlice.forEach((item) => consumed.add(item.key))
      out.push(...groupToolBatchEntries(filterInlineChatEntries(filterRedundantErrorEntries(orphanSlice))))
      i = next
      continue
    }

    out.push({ type: 'entry', key: entry.key, entry })
    consumed.add(entry.key)
    i++
    let slice: TimelineEntry[]
    let next = i
    if (entry.taskId) {
      slice = entries.filter((item) => (
        item.key !== entry.key
        && !consumed.has(item.key)
        && item.taskId === entry.taskId
      ))
      slice.forEach((item) => consumed.add(item.key))
    } else {
      const legacy = sliceUntilNextUser(entries, i)
      slice = legacy.slice.filter((item) => !consumed.has(item.key))
      slice.forEach((item) => consumed.add(item.key))
      next = legacy.next
    }
    out.push(...groupToolBatchEntries(filterInlineChatEntries(filterRedundantErrorEntries(slice))))
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
