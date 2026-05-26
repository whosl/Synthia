import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { listConnectors } from '../../api/connectors'
import { Panel } from '../common/Panel'
import { StatusBadge } from '../common/StatusBadge'

export function ConnectorHealthPanel() {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['connectors-health'], queryFn: listConnectors })
  const items = q.data?.connectors ?? []

  return (
    <Panel title={t('monitor.connectors')}>
      {items.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>{t('connectors.empty')}</p>
      ) : (
        items.map((c) => (
          <div className="event-row" key={c.connector_id}>
            <span style={{ fontWeight: 600 }}>{c.tool_name}</span>
            <span className="mono muted">{c.connector_id}</span>
            <StatusBadge status={c.status === 'ready' ? 'connected' : 'idle'} />
            <span className="muted">{c.capabilities_count} caps</span>
          </div>
        ))
      )}
    </Panel>
  )
}
