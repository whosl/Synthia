import type { ToolCallViewModel } from '../components/terminal/ToolCallBlock'
import i18n from './i18n'
import { computeToolGroupElapsedSec } from './toolPresentation'
import { isToolEntry, memberToToolViewModel } from '../timeline/chatGrouping'
import type { AssistantTextPayload, TimelineEntry } from '../timeline/types'

export interface WorkGroupSummary {
  elapsedSec: number
  toolCount: number
}

export function collectWorkTools(members: TimelineEntry[]): ToolCallViewModel[] {
  return members
    .filter(isToolEntry)
    .map((e) => memberToToolViewModel(e))
    .filter((t): t is ToolCallViewModel => Boolean(t))
}

export function computeWorkGroupElapsedSec(
  members: TimelineEntry[],
  finalEntry?: TimelineEntry | null,
): number {
  const tools = collectWorkTools(members)
  const toolSec = computeToolGroupElapsedSec(tools)
  const stamps: number[] = []

  for (const e of members) {
    if (e.createdAt) stamps.push(e.createdAt * 1000)
    const t = memberToToolViewModel(e)
    if (t?.startedAtMs) stamps.push(t.startedAtMs)
    if (t?.completedAtMs) stamps.push(t.completedAtMs)
  }
  if (finalEntry?.createdAt) stamps.push(finalEntry.createdAt * 1000)

  if (stamps.length >= 2) {
    const spanMs = Math.max(...stamps) - Math.min(...stamps)
    if (spanMs > 0) return Math.max(Math.round(spanMs / 1000), toolSec)
  }
  return toolSec
}

export function buildWorkGroupSummary(
  members: TimelineEntry[],
  finalEntry?: TimelineEntry | null,
): WorkGroupSummary {
  return {
    elapsedSec: computeWorkGroupElapsedSec(members, finalEntry),
    toolCount: collectWorkTools(members).length,
  }
}

export function formatWorkedDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec))
  if (sec < 60) return `${sec} s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `${m} min ${s} s` : `${m} min`
}

export function formatWorkGroupSummaryLine(summary: WorkGroupSummary): string {
  const duration = formatWorkedDuration(summary.elapsedSec)
  if (summary.toolCount === 1) {
    return i18n.t('agentWork.workedForOne', { duration })
  }
  return i18n.t('agentWork.workedFor', { duration, count: summary.toolCount })
}

export function isAssistantFinalComplete(entry: TimelineEntry | null | undefined): boolean {
  if (!entry || entry.kind !== 'assistant_text') return false
  const p = entry.payload as AssistantTextPayload
  return !p.partial
}
