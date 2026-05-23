import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getApprovals, setPatchApproval, setVivadoApproval } from '../api/settings'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'

export default function SettingsPage() {
  const qc = useQueryClient()
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: getApprovals })
  const patchMut = useMutation({
    mutationFn: setPatchApproval,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  })
  const vivadoMut = useMutation({
    mutationFn: setVivadoApproval,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  })

  const patchOn = Boolean(approvals.data?.patch_approved)
  const vivadoOn = Boolean(approvals.data?.vivado_execution_approved)

  return <div className="page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Runtime and approval controls</p>
      </div>
    </div>
    <div style={{ display: 'grid', gap: 16, maxWidth: 600 }}>
      <Panel title="File patch approval" actions={<StatusBadge status={patchOn ? 'done' : 'warning'} />}>
        <div style={{ marginBottom: 12, color: patchOn ? 'var(--success)' : 'var(--warning)', fontSize: 13 }}>
          {patchOn
            ? 'Auto-approved — agent can create/modify files without confirmation'
            : 'Manual — each file create/patch requires confirmation'}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={patchOn}
            onChange={(e) => patchMut.mutate(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          <span>Auto-approve file patches</span>
        </label>
      </Panel>
      <Panel title="Vivado execution approval" actions={<StatusBadge status={vivadoOn ? 'done' : 'warning'} />}>
        <div style={{ marginBottom: 12, color: vivadoOn ? 'var(--success)' : 'var(--warning)', fontSize: 13 }}>
          {vivadoOn
            ? 'Auto-approved — synthesis/implementation/Tcl runs without confirmation'
            : 'Manual — each Vivado tool run requires confirmation'}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={vivadoOn}
            onChange={(e) => vivadoMut.mutate(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          <span>Auto-approve Vivado execution</span>
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
