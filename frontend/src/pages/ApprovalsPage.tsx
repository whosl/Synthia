import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { approveApproval, getApproval, listApprovals, rejectApproval, applyPatch } from '../api/approvals'
import { Button } from '../components/common/Button'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'

export default function ApprovalsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [selected, setSelected] = useState('')
  const listQ = useQuery({ queryKey: ['approvals-pending'], queryFn: () => listApprovals({ status: 'pending' }) })
  const detailQ = useQuery({
    queryKey: ['approval', selected],
    queryFn: () => getApproval(selected),
    enabled: Boolean(selected),
  })

  const approveM = useMutation({
    mutationFn: () => approveApproval(selected),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals-pending'] })
      setSelected('')
    },
  })
  const rejectM = useMutation({
    mutationFn: () => rejectApproval(selected),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals-pending'] }),
  })
  const applyM = useMutation({
    mutationFn: (patchId: string) => applyPatch(patchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals-pending'] }),
  })

  const approval = detailQ.data?.approval
  const patches = detailQ.data?.patches ?? []

  return (
    <div className="page">
      <PageStickyTop>
        <div className="page-header">
          <h1 className="page-title">{t('nav.approvals')}</h1>
          <p className="page-subtitle">{t('approvals.subtitle')}</p>
        </div>
      </PageStickyTop>
      <div className="dashboard-grid">
        <Panel title={t('approvals.queue')}>
          {(listQ.data?.approvals ?? []).map((a) => (
            <button
              key={a.id}
              type="button"
              className="event-row"
              style={{ width: '100%', textAlign: 'left', background: selected === a.id ? 'var(--surface-elevated)' : 'transparent', border: 'none', cursor: 'pointer' }}
              onClick={() => setSelected(a.id)}
            >
              <span>{a.approval_type}</span>
              <StatusBadge status={a.risk_level === 'high' ? 'error' : 'warning'} />
              <span className="mono muted">{a.id.slice(0, 8)}</span>
            </button>
          ))}
          {!listQ.data?.approvals?.length && <p className="muted">{t('approvals.empty')}</p>}
        </Panel>
        <Panel title={t('approvals.detail')}>
          {approval ? (
            <>
              <div className="kv"><span>{t('approvals.type')}</span><span>{approval.approval_type}</span></div>
              <div className="kv"><span>{t('approvals.risk')}</span><StatusBadge status={approval.risk_level} /></div>
              {Array.isArray((approval.payload as { files?: unknown[] })?.files) &&
              (approval.payload as { files: Array<{ path?: string; action?: string }> }).files.length > 0 ? (
                <ul className="report-list">
                  {(approval.payload as { files: Array<{ path?: string; action?: string }> }).files.map((f, i) => (
                    <li key={i}>
                      <span className="mono">{f.path}</span>
                      <span className="muted">{f.action}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <pre className="mono" style={{ fontSize: 11, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(approval.payload, null, 2)}
                </pre>
              )}
              {approval.interaction_id && (
                <p className="muted mono" style={{ fontSize: 11, marginTop: 8 }}>
                  interaction: {approval.interaction_id}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button onClick={() => approveM.mutate()}>{t('approvals.approve')}</Button>
                <Button className="ghost" onClick={() => rejectM.mutate()}>{t('approvals.reject')}</Button>
                {patches.length > 0 && patches[0].id != null && (
                  <Button className="ghost" onClick={() => applyM.mutate(String(patches[0].id))}>{t('approvals.applyPatch')}</Button>
                )}
              </div>
            </>
          ) : (
            <p className="muted">{t('approvals.selectOne')}</p>
          )}
        </Panel>
      </div>
    </div>
  )
}
