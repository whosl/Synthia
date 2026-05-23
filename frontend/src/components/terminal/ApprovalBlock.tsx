import { Check, ChevronDown, ChevronRight, Minus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '../common/Button'

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
  files: ApprovalFile[]
  status: 'pending' | 'approved' | 'rejected'
  response?: Record<string, unknown>
  onApprove?: (id: string, approvedFiles: string[]) => void
  onReject?: (id: string) => void
}

export function ApprovalBlock({
  id,
  title,
  message,
  files,
  status,
  response,
  onApprove,
  onReject,
}: ApprovalBlockProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set(files.map((f) => f.path)))
  const isPending = status === 'pending'
  const allPaths = files.map((f) => f.path)

  const approvedSet = useMemo(() => {
    const raw = response?.approved_files
    if (!Array.isArray(raw)) return null
    return new Set(raw.map(String))
  }, [response])

  const isPartialResult = status === 'approved' && approvedSet !== null && approvedSet.size < files.length

  const toggleExpand = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  const toggleSelect = (path: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  const selectAll = () => setSelectedFiles(new Set(allPaths))
  const selectNone = () => setSelectedFiles(new Set())

  const approveLabel = selectedFiles.size === files.length
    ? 'Approve'
    : `Approve (${selectedFiles.size}/${files.length})`

  const statusBadge = status === 'approved'
    ? (isPartialResult ? '✓ 部分批准' : '✓ 已批准')
    : '✗ 已拒绝'

  return (
    <div className={`interaction-block approval-block status-${status}${isPartialResult ? ' status-partial' : ''}`}>
      <div className="interaction-header">
        <span className="interaction-title">{title}</span>
        {!isPending && <span className={`interaction-badge ${status}`}>{statusBadge}</span>}
      </div>
      {message && <div className="interaction-message">{message}</div>}

      {files.length > 1 && isPending && (
        <div className="approval-select-bar">
          <button type="button" className="link-btn" onClick={selectAll}>全选</button>
          <span className="sep">·</span>
          <button type="button" className="link-btn" onClick={selectNone}>全不选</button>
          <span className="approval-select-count">{selectedFiles.size} / {files.length} 已选</span>
        </div>
      )}

      {files.length > 0 && (
        <div className="approval-files">
          {files.map((file) => {
            const fileApproved = approvedSet?.has(file.path)
            const fileSkipped = approvedSet !== null && !fileApproved
            return (
              <div
                key={file.path}
                className={`approval-file${isPending && selectedFiles.has(file.path) ? ' selected' : ''}${fileApproved ? ' file-approved' : ''}${fileSkipped ? ' file-skipped' : ''}`}
              >
                <div className="approval-file-header">
                  {isPending && (
                    <input
                      type="checkbox"
                      checked={selectedFiles.has(file.path)}
                      onChange={() => toggleSelect(file.path)}
                      aria-label={`Select ${file.path}`}
                    />
                  )}
                  {!isPending && fileApproved && <Check size={14} className="file-status-icon approved" />}
                  {!isPending && fileSkipped && <Minus size={14} className="file-status-icon skipped" />}
                  <span className="file-action-badge">{file.action}</span>
                  <code className="file-path">{file.path}</code>
                  {file.description && <span className="file-desc">{file.description}</span>}
                  <button type="button" className="btn-icon" onClick={() => toggleExpand(file.path)}>
                    {expandedFiles.has(file.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                </div>
                {expandedFiles.has(file.path) && (
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
            disabled={files.length > 0 && selectedFiles.size === 0}
            onClick={() => onApprove?.(id, files.length > 0 ? [...selectedFiles] : allPaths)}
          >
            <Check size={14} /> {approveLabel}
          </Button>
          <Button className="ghost" onClick={() => onReject?.(id)}>
            <X size={14} /> Reject all
          </Button>
        </div>
      )}

      {status === 'rejected' && (
        <div className="interaction-rejected-hint">
          <span className="muted">告诉 EdAgent 该怎么做</span>
        </div>
      )}
    </div>
  )
}
