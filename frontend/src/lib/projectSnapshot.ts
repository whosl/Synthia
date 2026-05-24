import type { Session } from '../api/types'

export type ProjectSnapshot = {
  project_id?: string
  name?: string
  root_path?: string
  manifest_path?: string
  xpr_path?: string
  part?: string
  board_part?: string
  top_module?: string
  default_vivado_target_id?: string
  legacy_migration?: boolean
  migration_resolved_at?: number
}

export function parseProjectSnapshot(session?: Session | null): ProjectSnapshot {
  if (!session?.project_snapshot_json) return {}
  try {
    const data = JSON.parse(session.project_snapshot_json)
    return typeof data === 'object' && data ? data : {}
  } catch {
    return {}
  }
}
