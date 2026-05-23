import { request } from './client'
import type { ContextPackage, ContextPackageItem, RetrievalAudit, RetrievalAuditItem } from './types'

export function getSessionContext(sessionId: string, taskId?: string) {
  const qs = taskId ? `?task_id=${encodeURIComponent(taskId)}` : ''
  return request<{
    contexts: Array<{ package: ContextPackage; items: ContextPackageItem[] }>
    retrieval_audits: Array<{ audit: RetrievalAudit; items: RetrievalAuditItem[] }>
    task_id?: string | null
  }>(`/sessions/${sessionId}/context${qs}`)
}
