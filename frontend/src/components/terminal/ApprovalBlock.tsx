import { Check, ChevronDown, ChevronRight, Minus, ShieldCheck, X, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseApprovalPayload } from '../../lib/approvalPayload'
import { extractPatchDiffFromReason } from '../../lib/patchDiff'
import { DiffViewer } from '../patches/DiffViewer'
import { buildApprovalResponse } from '../../lib/approvalResponse'
import { useTerminalStore } from '../../stores/terminalStore'
import { Button } from '../common/Button'
import { CollapsibleSection } from '../common/CollapsibleSection'

export interface ApprovalFile {
  path: string
  content: string
  description?: string
  action: string
}

export interface ApprovalBlockProps {
  id: string
  title: string
  message: string
  reason?: string
  files: ApprovalFile[]
  status: 'pending' | 'approved' | 'rejected'
  response?: Record<string, unknown>
  onApprove?: (id: string, approvedIndices: number[]) => void
  onReject?: (id: string) => void
}

export function ApprovalBlock({
  id,
  title,
  message,
  reason,
  files,
  status,
  response,
  onApprove,
  onReject,
}: ApprovalBlockProps) {
  const { t } = useTranslation()
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(new Set())
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    () => new Set(files.map((_, index) => index)),
  )
  const collapsed = useTerminalStore((s) => s.collapsed[id] ?? true)
  const toggleCollapsed = useTerminalStore((s) => s.toggleCollapsed)

  const isPending = status === 'pending'
  const isApproved = status === 'approved'
  const allIndices = files.map((_, index) => index)

  const detailRows = useMemo(
    () => parseApprovalPayload(reason, message, files),
    [reason, message, files],
  )

  const patchDiff = useMemo(() => extractPatchDiffFromReason(reason), [reason])

  const approvedIndices = useMemo(() => {
    const raw = response?.approved_indices
    if (!Array.isArray(raw)) return null
    return new Set(raw.map((v) => Number(v)))
  }, [response])

  const approvedSet = useMemo(() => {
    const raw = response?.approved_files
    if (!Array.isArray(raw)) return null
    return new Set(raw.map(String))
  }, [response])

  const isPartialResult = isApproved && (
    approvedIndices !== null
      ? approvedIndices.size < files.length
      : approvedSet !== null && approvedSet.size < files.length
  )

  const toggleExpand = (index: number) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }

  const toggleSelect = (index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }

  const selectAll = () => setSelectedIndices(new Set(allIndices))
  const selectNone = () => setSelectedIndices(new Set())

  const approveLabel = selectedIndices.size === files.length
    ? t('approval.approve')
    : t('approval.approveCount', { selected: selectedIndices.size, total: files.length })

  const statusLabel = isApproved
    ? (isPartialResult ? t('approval.partialApproval') : t('approval.approved'))
    : isPending
      ? t('approval.pending')
      : t('approval.rejected')

  const statusBadge = isApproved
    ? (isPartialResult ? t('approval.partialCheck') : t('approval.approvedCheck'))
    : t('approval.rejectedCross')

  const headerIcon = isApproved
    ? <ShieldCheck size={14} className="approval-status-icon approved" />
    : isPending
      ? null
      : <XCircle size={14} className="approval-status-icon rejected" />

  const body = (
    <>
      {patchDiff && (patchDiff.diff || patchDiff.changes.length > 0) && (
        <div className="approval-patch-diff">
          {patchDiff.diff ? (
            <DiffViewer diffText={patchDiff.diff} filename={patchDiff.path} />
          ) : (
            patchDiff.changes.map((c, i) => (
              <DiffViewer key={`${c.path}-${i}`} diffText={c.diff_text || ''} filename={c.path} />
            ))
          )}
        </div>
      )}

      {detailRows.length > 0 && (
        <dl className="approval-detail-grid">
          {detailRows.map((row) => (
            <div key={row.key} className="approval-detail-row">
              <dt>{row.label}</dt>
              <dd className={row.mono ? 'mono' : undefined}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {files.length > 1 && isPending && (
        <div className="approval-select-bar">
          <button type="button" className="link-btn" onClick={selectAll}>{t('approval.selectAll')}</button>
          <span className="sep">·</span>
          <button type="button" className="link-btn" onClick={selectNone}>{t('approval.selectNone')}</button>
          <span className="approval-select-count">{t('approval.selected', { selected: selectedIndices.size, total: files.length })}</span>
        </div>
      )}

      {files.length > 0 && (
        <div className="approval-files">
          {files.map((file, index) => {
            const fileApproved = approvedIndices
              ? approvedIndices.has(index)
              : (approvedSet?.has(file.path) ?? false)
            const fileSkipped = isApproved && !fileApproved && (approvedIndices !== null || approvedSet !== null)
            return (
              <div
                key={`${file.path}:${index}`}
                className={`approval-file${isPending && selectedIndices.has(index) ? ' selected' : ''}${fileApproved ? ' file-approved' : ''}${fileSkipped ? ' file-skipped' : ''}`}
              >
                <div className="approval-file-header">
                  {isPending && (
                    <input
                      type="checkbox"
                      checked={selectedIndices.has(index)}
                      onChange={() => toggleSelect(index)}
                      aria-label={t('approval.selectFile', { path: file.path })}
                    />
                  )}
                  {!isPending && fileApproved && <Check size={14} className="file-status-icon approved" />}
                  {!isPending && fileSkipped && <Minus size={14} className="file-status-icon skipped" />}
                  <span className="file-action-badge">{file.action}</span>
                  <code className="file-path">{file.path}</code>
                  {file.description && <span className="file-desc">{file.description}</span>}
                  <button type="button" className="btn-icon" onClick={() => toggleExpand(index)}>
                    {expandedFiles.has(index) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                </div>
                {expandedFiles.has(index) && (
                  <pre className="file-content-preview">{file.content}</pre>
                )}
              </div>
            )
          })}
        </div>
      )}

      {isPending && (
        <div className="interaction-actions">
          <Button
            className="primary"
            disabled={files.length > 0 && selectedIndices.size === 0}
            onClick={() => {
              const indices = files.length > 0 ? [...selectedIndices].sort((a, b) => a - b) : allIndices
              onApprove?.(id, indices)
            }}
          >
            <Check size={14} /> {approveLabel}
          </Button>
          <Button className="ghost" onClick={() => onReject?.(id)}>
            <X size={14} /> {t('approval.rejectAll')}
          </Button>
        </div>
      )}

      {status === 'rejected' && !isPending && (
        <div className="interaction-rejected-hint">
          <span className="muted">{t('approval.rejectedHint')}</span>
        </div>
      )}
    </>
  )

  if (isPending) {
    return (
      <div className={`interaction-block approval-block status-${status}${isPartialResult ? ' status-partial' : ''}`}>
        <div className="interaction-header">
          <span className="interaction-title">{title}</span>
        </div>
        {body}
      </div>
    )
  }

  return (
    <div
      className={`trace-block approval-trace-block status-${status}${isApproved ? ' completed' : ' rejected'}${isPartialResult ? ' status-partial' : ''}${collapsed ? '' : ' is-expanded'}`}
    >
      <div
        className="trace-header"
        onClick={() => toggleCollapsed(id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleCollapsed(id)
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
      >
        <ChevronRight size={14} className="trace-chevron" />
        {headerIcon}
        <span>{title}</span>
        <span className="spacer" />
        <span className={`interaction-badge ${status}`}>{statusBadge}</span>
        <span className="tool-state">{statusLabel}</span>
      </div>
      <CollapsibleSection open={!collapsed} className="trace-body-wrap">
        <div className="trace-body approval-trace-body">{body}</div>
      </CollapsibleSection>
    </div>
  )
}
