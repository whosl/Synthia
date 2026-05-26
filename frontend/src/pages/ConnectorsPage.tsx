import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Plug, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { connectorHealthCheck, getConnector, listConnectors, listConnectorCapabilities } from '../api/connectors'
import { Button } from '../components/common/Button'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { Panel } from '../components/common/Panel'
import { StatusBadge } from '../components/common/StatusBadge'

export default function ConnectorsPage() {
  const { t } = useTranslation()
  const listQ = useQuery({ queryKey: ['connectors'], queryFn: listConnectors })
  const connectors = listQ.data?.connectors ?? []
  const primary = connectors[0]
  const detailQ = useQuery({
    queryKey: ['connector', primary?.connector_id],
    queryFn: () => getConnector(primary!.connector_id),
    enabled: Boolean(primary?.connector_id),
  })
  const healthM = useMutation({
    mutationFn: () => connectorHealthCheck(primary!.connector_id),
    onSuccess: () => {
      detailQ.refetch()
      listQ.refetch()
    },
  })
  const capsQ = useQuery({
    queryKey: ['connector-caps', primary?.connector_id],
    queryFn: () => listConnectorCapabilities(primary!.connector_id),
    enabled: Boolean(primary?.connector_id),
  })

  return (
    <div className="page">
      <PageStickyTop>
        <div className="page-header">
          <div>
            <h1 className="page-title">{t('connectors.title')}</h1>
            <p className="page-subtitle">{t('connectors.subtitle')}</p>
          </div>
          <Button className="ghost" onClick={() => listQ.refetch()}>
            <RefreshCw size={14} /> {t('connectors.refresh')}
          </Button>
        </div>
      </PageStickyTop>

      <div className="dashboard-grid">
        <Panel title={t('connectors.registry')}>
          {connectors.length === 0 ? (
            <p className="muted">{t('connectors.empty')}</p>
          ) : (
            connectors.map((c) => (
              <div className="event-row" key={c.connector_id}>
                <Plug size={14} />
                <span style={{ fontWeight: 600 }}>{c.tool_name}</span>
                <span className="mono muted">{c.connector_id}</span>
                <StatusBadge status={c.status === 'ready' ? 'completed' : 'idle'} />
                <span className="muted">{c.capabilities_count} caps</span>
              </div>
            ))
          )}
        </Panel>

        {primary && (
          <Panel title={t('connectors.environment')}>
            <div className="kv">
              <span>{t('connectors.version')}</span>
              <span className="mono">{detailQ.data?.environment?.version || primary.version || '—'}</span>
            </div>
            <div className="kv">
              <span>{t('connectors.target')}</span>
              <span className="mono">{detailQ.data?.environment?.target_type || '—'}</span>
            </div>
            <div className="kv">
              <span>{t('connectors.reachable')}</span>
              <span>
                <StatusBadge status={detailQ.data?.environment?.reachable ? 'connected' : 'idle'} />
              </span>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button className="ghost" disabled={!primary || healthM.isPending} onClick={() => healthM.mutate()}>
                {t('connectors.healthCheck')}
              </Button>
              <Link to="/connectors/vivado" style={{ color: 'var(--accent)', fontSize: 13 }}>{t('nav.vivado')}</Link>
            </div>
          </Panel>
        )}
      </div>

      {primary && (
        <Panel title={t('connectors.capabilities')}>
          <div className="connectors-cap-table">
            <div className="connectors-cap-row head">
              <span>{t('connectors.capId')}</span>
              <span>{t('connectors.capStage')}</span>
              <span>{t('connectors.capRisk')}</span>
              <span>{t('connectors.capApproval')}</span>
            </div>
            {(capsQ.data?.capabilities ?? []).map((cap) => (
              <div className="connectors-cap-row" key={cap.capability_id}>
                <span>
                  <strong>{cap.display_name}</strong>
                  <div className="mono muted" style={{ fontSize: 11 }}>{cap.capability_id}</div>
                </span>
                <span className="mono">{cap.stage}</span>
                <span><StatusBadge status={cap.risk_level === 'high' ? 'error' : cap.risk_level === 'medium' ? 'warning' : 'idle'} /></span>
                <span>{cap.requires_approval ? t('connectors.yes') : t('connectors.no')}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}
