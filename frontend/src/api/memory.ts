import { request } from './client'

export interface CanvasNodeRef {
  node_id: string
  label: string
  ref_type: string
  ref_id: string
}

export interface ActiveCanvasResponse {
  mermaid: string
  version: number
  node_count: number
  nodes: CanvasNodeRef[]
}

export interface CanvasHistoryItem {
  id: string
  task_id: string
  session_id: string
  version: number
  node_count: number
  state: string
  created_at?: number
  updated_at?: number
  mermaid: string
}

export interface MemoryRefResponse {
  content: string
  ref_type: string
  ref_id: string
  label: string
}

export function getActiveCanvas(taskId: string) {
  return request<ActiveCanvasResponse>(`/memory/canvas/active?task_id=${encodeURIComponent(taskId)}`)
}

export function getCanvasHistory(sessionId: string, limit = 3) {
  return request<{ canvases: CanvasHistoryItem[] }>(
    `/memory/canvas/history?session_id=${encodeURIComponent(sessionId)}&limit=${limit}`,
  )
}

export function getMemoryRef(nodeId: string) {
  return request<MemoryRefResponse>(`/memory/refs/${encodeURIComponent(nodeId)}`)
}

export interface ProjectPersonaResponse {
  project_id: string
  md: string
  version: number
  built_at?: number
  atom_count: number
  scenario_count: number
  persona_id?: string
}

export function getProjectPersona(projectId: string) {
  return request<ProjectPersonaResponse>(`/memory/persona?project_id=${encodeURIComponent(projectId)}`)
}
