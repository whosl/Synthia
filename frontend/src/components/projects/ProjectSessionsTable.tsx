import { useTranslation } from 'react-i18next'
import { Archive, Pencil } from 'lucide-react'
import type { Session } from '../../api/types'
import { formatNumber, formatRelative } from '../../lib/time'
import { isSessionRunning } from '../../lib/sessionVisual'
import { Button } from '../common/Button'
import { StatusBadge } from '../common/StatusBadge'

export function ProjectSessionsTable({
  sessions,
  onOpen,
  onRename,
  onArchive,
}: {
  sessions: Session[]
  onOpen: (sessionId: string) => void
  onRename: (session: Session) => void
  onArchive: (session: Session) => void
}) {
  const { t } = useTranslation()

  if (!sessions.length) return null

  return (
    <div className="project-sessions-table-wrap">
      <table className="table project-sessions-table">
        <thead>
          <tr>
            <th>{t('projectSessions.tableSession')}</th>
            <th>{t('projectSessions.tableStatus')}</th>
            <th>{t('projectSessions.tableUpdated')}</th>
            <th>{t('projectSessions.tableMessages')}</th>
            <th>{t('projectSessions.tableTools')}</th>
            <th aria-label={t('projectSessions.tableActions')} />
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} onClick={() => onOpen(s.id)} className="project-sessions-row">
              <td>
                <div className="project-sessions-name">{s.name || t('projectSessions.untitledSession')}</div>
              </td>
              <td>
                {isSessionRunning(s.status) ? (
                  <span className="session-meta-running">
                    <span className="session-running-dot" aria-hidden />
                    {t('status.running')}
                  </span>
                ) : (
                  <StatusBadge status={s.status} />
                )}
              </td>
              <td className="muted">
                {isSessionRunning(s.status) ? t('status.running') : formatRelative(s.updated_at)}
              </td>
              <td>{formatNumber(s.message_count)}</td>
              <td>{formatNumber(s.tool_call_count)}</td>
              <td className="project-row-actions" onClick={(e) => e.stopPropagation()}>
                <Button className="ghost icon-btn" type="button" title={t('projectSessions.renameSession')} onClick={() => onRename(s)}>
                  <Pencil size={14} />
                </Button>
                <Button className="ghost icon-btn" type="button" title={t('projectSessions.archiveSession')} onClick={() => onArchive(s)}>
                  <Archive size={14} />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
