import { User } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../../components/common/Markdown'
import { ApprovalBlock } from '../../components/terminal/ApprovalBlock'
import { CustomEntryBlock } from '../../components/terminal/CustomEntryBlock'
import { InputRequestBlock } from '../../components/terminal/InputRequestBlock'
import { ReasoningBlock } from '../../components/terminal/ReasoningBlock'
import { ToolCallBlock } from '../../components/terminal/ToolCallBlock'
import { formatTime } from '../../lib/time'
import type {
  AssistantTextPayload,
  CustomEntryPayload,
  InteractionEntryPayload,
  ReasoningEntryPayload,
  TimelineEntryKind,
  ToolEntryPayload,
  UserEntryPayload,
} from '../types'
import type { TimelineEntryRenderer, TimelineRenderContext } from './types'

function UserEntryRenderer({ entry }: TimelineRenderContext) {
  const { t } = useTranslation()
  const p = entry.payload as UserEntryPayload
  return (
    <div className="message-turn user">
      <div className="message-bubble">
        <div className="message-meta">
          <User size={14} /> {t('terminal.you')} {entry.createdAt && <span>{formatTime(entry.createdAt)}</span>}
        </div>
        {p.text}
      </div>
    </div>
  )
}

function AssistantTextRenderer({ entry }: TimelineRenderContext) {
  const { t } = useTranslation()
  const p = entry.payload as AssistantTextPayload
  return (
    <div className="assistant-stack">
      <div className="message-meta assistant-meta">
        {t('terminal.synthia')}
        {p.stopped && <span className="status stopped">{t('status.stopped')}</span>}
        {p.partial && !p.stopped && <span className="status stopped">{t('terminal.partial')}</span>}
      </div>
      {p.text.trim() ? (
        <div className="message-bubble assistant-text-bubble">
          <Markdown text={p.text} />
        </div>
      ) : null}
    </div>
  )
}

function ReasoningRenderer({ entry }: TimelineRenderContext) {
  const p = entry.payload as ReasoningEntryPayload
  return <ReasoningBlock id={entry.id} {...p} />
}

function ToolRenderer({ entry }: TimelineRenderContext) {
  const p = entry.payload as ToolEntryPayload
  const at = entry.createdAt ?? 0
  const createdMs = at > 1e12 ? at : at * 1000
  return (
    <ToolCallBlock
      tool={{
        id: p.toolcallId,
        name: p.name,
        state: p.state,
        args: p.args,
        result: p.result,
        startedAt: p.startedAt ?? entry.createdAt,
        startedAtMs: p.startedAtMs ?? createdMs,
        elapsedMs: p.elapsedMs,
        completedAtMs: p.state !== 'running' ? createdMs : undefined,
      }}
    />
  )
}

function InteractionRenderer({ entry, onInteractionRespond }: TimelineRenderContext) {
  const p = entry.payload as InteractionEntryPayload
  if (p.interaction_type === 'approval') {
    return (
      <ApprovalBlock
        id={entry.id}
        title={p.title}
        message={p.message}
        reason={p.reason}
        files={p.files || []}
        status={p.status as 'pending' | 'approved' | 'rejected'}
        response={p.response}
        onApprove={(iid, files) => onInteractionRespond?.(iid, { approved: true, approved_files: files })}
        onReject={(iid) => onInteractionRespond?.(iid, { approved: false })}
      />
    )
  }
  return (
    <InputRequestBlock
      id={entry.id}
      title={p.title}
      message={p.message}
      fields={(p.fields || []) as any}
      status={p.status === 'responded' ? 'responded' : 'pending'}
      response={p.response as unknown as Record<string, string> | undefined}
      onSubmit={(iid, values) => onInteractionRespond?.(iid, values)}
    />
  )
}

function CustomRenderer({ entry }: TimelineRenderContext) {
  return <CustomEntryBlock payload={entry.payload as CustomEntryPayload} />
}

const builtinRenderers: Record<TimelineEntryKind, TimelineEntryRenderer> = {
  user: UserEntryRenderer,
  assistant_text: AssistantTextRenderer,
  reasoning: ReasoningRenderer,
  tool: ToolRenderer,
  interaction: InteractionRenderer,
  custom: CustomRenderer,
}

const extensionRenderers = new Map<string, TimelineEntryRenderer>()

export function registerTimelineEntryRenderer(
  kind: string,
  renderer: TimelineEntryRenderer,
): void {
  extensionRenderers.set(kind, renderer)
}

export function resolveTimelineEntryRenderer(kind: string): TimelineEntryRenderer | null {
  if (extensionRenderers.has(kind)) return extensionRenderers.get(kind)!
  return builtinRenderers[kind as TimelineEntryKind] ?? null
}

function UnknownEntryRenderer({ entry }: TimelineRenderContext) {
  const { t } = useTranslation()
  return (
    <div className="trace-block">
      <div className="trace-body muted">{t('terminal.unknownEntry', { kind: entry.kind })}</div>
    </div>
  )
}

export function renderTimelineEntry(ctx: TimelineRenderContext) {
  const renderer = resolveTimelineEntryRenderer(ctx.entry.kind)
  if (!renderer) {
    return <UnknownEntryRenderer {...ctx} />
  }
  return renderer(ctx)
}

/** Wrap assistant-thread entries (non-user) in shared layout shell. */
export function renderTimelineEntryShell(ctx: TimelineRenderContext) {
  const { entry } = ctx
  if (entry.kind === 'user') {
    return renderTimelineEntry(ctx)
  }

  const p = entry.payload as InteractionEntryPayload
  const isApprovalInteraction = entry.kind === 'interaction' && p.interaction_type === 'approval'
  const stickyPending = isApprovalInteraction && p.status === 'pending'

  return (
    <div
      className={`message-turn assistant timeline-entry kind-${entry.kind}${isApprovalInteraction ? ' kind-approval' : ''}${stickyPending ? ' sticky-pending-approval' : ''}`}
    >
      {renderTimelineEntry(ctx)}
    </div>
  )
}
