import { Check, ChevronDown, ChevronRight, FileText, X } from 'lucide-react'
import { useState } from 'react'
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
  onApprove?: (id: string, approvedFiles: string[]) => void
  onReject?: (id: string) => void
}

export function ApprovalBlock({ id, title, message, files, status, onApprove, onReject }: ApprovalBlockProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(files.map(f => f.path)))
  const isPending = status === 'pending'

  const toggleExpand = (path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  const toggleSelect = (path: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  return <div className={`interaction-block approval-block status-${status}`}>
    <div className="interaction-header">
      <span className="interaction-title">{title}</span>
      {!isPending && <span className={`interaction-badge ${status}`}>{status === 'approved' ? '✓ 已批准' : '✗ 已拒绝'}</span>}
    </div>
    {message && <div className="interaction-message">{message}</div>}

    <div className="approval-files">
      {files.map(file => <div key={file.path} className="approval-file">
        <div className="approval-file-header">
          {isPending && <input type="checkbox" checked={selectedFiles.has(file.path)} onChange={() => toggleSelect(file.path)} />}
          <span className="file-action-badge">{file.action}</span>
          <code className="file-path">{file.path}</code>
          {file.description && <span className="file-desc">{file.description}</span>}
          <button className="btn-icon" onClick={() => toggleExpand(file.path)}>
            {expandedFiles.has(file.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>
        {expandedFiles.has(file.path) && <pre className="file-content-preview">{file.content}</pre>}
      </div>)}
    </div>

    {isPending && <div className="interaction-actions">
      <Button className="primary" onClick={() => onApprove?.(id, [...selectedFiles])}>
        <Check size={14} /> Approve {selectedFiles.size < files.length ? `(${selectedFiles.size}/${files.length})` : 'All'}
      </Button>
      <Button className="ghost" onClick={() => onReject?.(id)}>
        <X size={14} /> Reject
      </Button>
    </div>}

    {status === 'rejected' && <div className="interaction-rejected-hint">
      <span className="muted">告诉 EdAgent 该怎么做</span>
    </div>}
  </div>
}
