import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { listMigrationConflicts, resolveMigration } from '../../api/projects'
import { Button } from '../common/Button'
import { Panel } from '../common/Panel'

export function MigrationConflictsBanner() {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ['migration-conflicts'],
    queryFn: () => listMigrationConflicts(50),
    refetchInterval: 60_000,
  })

  const resolve = useMutation({
    mutationFn: ({ sessionId, projectId }: { sessionId: string; projectId: string }) =>
      resolveMigration(sessionId, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-conflicts'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (err: Error) => alert(err.message || 'Failed to resolve migration'),
  })

  const sessions = data?.sessions ?? []
  if (!sessions.length) return null

  return (
    <Panel title="Migration conflicts" className="migration-conflicts-panel">
      <p className="muted migration-conflicts-intro">
        <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
        These sessions match multiple projects. Pick the correct project for each.
      </p>
      <ul className="migration-conflicts-list">
        {sessions.map((s) => (
          <li key={s.id} className="migration-conflict-item">
            <div>
              <strong>{s.name || s.id}</strong>
              <span className="mono muted" style={{ fontSize: 11, display: 'block' }}>
                {s.migration_hint?.manifest_path || s.id}
              </span>
            </div>
            <div className="migration-conflict-actions">
              {(s.migration_candidates ?? []).map((p) => (
                <Button
                  key={p.id}
                  className="ghost"
                  type="button"
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate({ sessionId: s.id, projectId: p.id })}
                  title={p.root_path}
                >
                  {p.name}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
