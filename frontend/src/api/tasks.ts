import { jsonBody, request } from './client'
import type { Task } from './types'

export function startTask(sessionId: string, payload: { question: string; manifest_path?: string; agent_mode?: string; metadata?: Record<string, unknown> }) {
  return request<{ task_id: string; session_id: string; state: string; stream_url: string }>(`/sessions/${sessionId}/tasks`, {
    method: 'POST',
    ...jsonBody(payload),
  })
}

export function getTask(taskId: string) {
  return request<{ task: Task }>(`/tasks/${taskId}`)
}

export function getActiveTask(sessionId: string) {
  return request<{ task: Task | null }>(`/sessions/${sessionId}/active-task`)
}

export function stopSessionTask(sessionId: string) {
  return request<{ ok: boolean; task_id: string; state: string }>(`/sessions/${sessionId}/stop`, { method: 'POST' })
}

export function stopTask(taskId: string) {
  return request<{ ok: boolean; task_id: string; state: string }>(`/tasks/${taskId}/stop`, { method: 'POST' })
}
