import { request } from './client'

export interface HardwareTarget {
  id: string
  name: string
  part: string
  state: string
  host: string
  serial: string
  last_seen_at?: number
}

export interface BitstreamArtifact {
  id: string
  path?: string
  sha256?: string
  size_bytes?: number
}

export interface ProgramJob {
  id: string
  target_id: string
  bitstream_sha256: string
  bitstream_path?: string
  state: string
  error_message?: string
  log_artifact_id?: string
}

export function listHardwareTargets(state = '') {
  const q = state ? `?state=${encodeURIComponent(state)}` : ''
  return request<{ targets: HardwareTarget[] }>(`/hardware/targets${q}`)
}

export function detectHardwareTargets(host = '') {
  return request<{ detected_count: number; stats: Record<string, number> }>(
    '/hardware/targets/detect',
    { method: 'POST', body: JSON.stringify({ host }) },
  )
}

export function listBitstreamArtifacts() {
  return request<{ artifacts: BitstreamArtifact[] }>('/hardware/bitstreams')
}

export function openHardwareSession(targetId: string, projectId = '') {
  return request<{ id: string }>('/hardware/sessions', {
    method: 'POST',
    body: JSON.stringify({ target_id: targetId, project_id: projectId }),
  })
}

export function closeHardwareSession(sessionId: string) {
  return request<{ ok: boolean }>(`/hardware/sessions/${sessionId}/close`, { method: 'POST' })
}

export function requestProgram(hardwareSessionId: string, bitstreamArtifactId: string) {
  return request<{ job: ProgramJob; approval: Record<string, unknown> }>('/hardware/program/request', {
    method: 'POST',
    body: JSON.stringify({
      hardware_session_id: hardwareSessionId,
      bitstream_artifact_id: bitstreamArtifactId,
    }),
  })
}

export function approveProgram(jobId: string, reason: string) {
  return request<ProgramJob>(`/hardware/program/${jobId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export function rejectProgram(jobId: string, reason: string) {
  return request<ProgramJob>(`/hardware/program/${jobId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export function getProgramJob(jobId: string) {
  return request<ProgramJob>(`/hardware/program/${jobId}`)
}
