import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getPatchApproval, setPatchApproval } from '../api/settings'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'

export default function SettingsPage() {
  const qc = useQueryClient()
  const approval = useQuery({ queryKey: ['patch-approval'], queryFn: getPatchApproval })
  const update = useMutation({ mutationFn: setPatchApproval, onSuccess: () => qc.invalidateQueries({ queryKey: ['patch-approval'] }) })
  const approved = Boolean(approval.data?.approved)
  return <div className="page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Runtime and approval controls</p>
      </div>
    </div>
    <div style={{ display: 'grid', gap: 16, maxWidth: 600 }}>
      <Panel title="Patch Approval" actions={<StatusBadge status={approved ? 'done' : 'warning'} />}>
        <div style={{ marginBottom: 12, color: approved ? 'var(--success)' : 'var(--warning)', fontSize: 13 }}>
          {approved ? 'Auto-approved — agent can apply patches without confirmation' : 'Manual approval — each patch requires user confirmation'}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={approved} onChange={(e) => update.mutate(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
          <span>Approve patches by default</span>
        </label>
      </Panel>
      <Panel title="Runtime Configuration">
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
          Model, Vivado target, and runtime paths are configured via <code className="mono" style={{ background: 'var(--bg-subtle)', padding: '2px 6px', borderRadius: 4 }}>.env</code> and loaded at server startup.
          See <code className="mono" style={{ background: 'var(--bg-subtle)', padding: '2px 6px', borderRadius: 4 }}>SPEC.md §18</code> for the full configuration schema.
        </div>
      </Panel>
    </div>
  </div>
}
