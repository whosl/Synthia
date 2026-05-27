import { useEffect, useState } from 'react'
import { getApiToken, request } from '../api/client'

export interface MeUser {
  id: string
  username: string
  display_name?: string
  global_role: string
  is_admin: boolean
}

export interface Me {
  user: MeUser
  project_roles: Record<string, string>
}

const ROLE_PERMS: Record<string, string[]> = {
  admin: ['*'],
  project_owner: [
    'project.create',
    'project.read',
    'project.update',
    'project.delete',
    'run.create',
    'run.cancel',
    'patch.propose',
    'patch.approve',
    'patch.approve.low',
    'patch.reject',
    'artifact.download.bitstream',
    'audit.read',
    'benchmark.create',
    'benchmark.read',
    'benchmark.run',
    'hardware.read',
    'hardware.session.open',
    'hardware.program.request',
    'hardware.program.approve',
  ],
  fpga_engineer: [
    'project.read',
    'run.create',
    'run.cancel',
    'patch.propose',
    'patch.approve.low',
    'patch.reject',
    'artifact.download.bitstream',
    'benchmark.create',
    'benchmark.read',
    'benchmark.run',
    'hardware.read',
    'hardware.session.open',
    'hardware.program.request',
  ],
  reviewer: [
    'project.read',
    'run.read',
    'patch.approve',
    'patch.reject',
    'audit.read',
    'benchmark.read',
    'hardware.read',
    'hardware.program.approve',
  ],
  viewer: ['project.read', 'run.read', 'benchmark.read', 'hardware.read'],
  tool_admin: [
    'connector.write',
    'tool_target.write',
    'hardware.read',
    'hardware.detect',
    'hardware.admin',
  ],
}

let _cached: Me | null = null

export function invalidateMeCache(): void {
  _cached = null
}

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(_cached)

  useEffect(() => {
    if (_cached) return
    const tok = getApiToken()
    if (!tok) return
    request<Me>('/me')
      .then((d) => {
        _cached = d
        setMe(d)
      })
      .catch(() => setMe(null))
  }, [])

  return me
}

export function canUserDo(me: Me | null, permission: string, projectId?: string): boolean {
  if (!me) return true
  if (me.user.is_admin) return true
  const role = (projectId && me.project_roles[projectId]) || me.user.global_role
  const perms = ROLE_PERMS[role] || []
  if (perms.includes('*')) return true
  return perms.some(
    (p) => p === permission || (p.endsWith('.*') && permission.startsWith(p.slice(0, -1))),
  )
}
