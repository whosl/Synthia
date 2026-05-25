import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getProjectPersona } from '../../api/memory'
import { formatRelative } from '../../lib/time'

export function PersonaSummary({ projectId }: { projectId?: string }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['memory-persona', projectId],
    queryFn: () => getProjectPersona(projectId!),
    enabled: Boolean(projectId),
    refetchInterval: 15000,
  })

  if (!projectId) {
    return <p className="muted">{t('terminal.memoryPersonaNoProject')}</p>
  }
  if (q.isLoading) {
    return <p className="muted">{t('terminal.memoryLoading')}</p>
  }
  if (q.error) {
    return <p className="error-text">{String(q.error)}</p>
  }

  const data = q.data
  if (!data?.md?.trim()) {
    return <p className="muted">{t('terminal.memoryPersonaEmpty')}</p>
  }

  return (
    <div className="memory-persona-summary">
      <div className="memory-persona-meta mono muted">
        v{data.version} · {data.atom_count} atoms · {data.scenario_count} scenarios
        {data.built_at ? ` · ${formatRelative(data.built_at)}` : ''}
      </div>
      <div className="memory-persona-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.md}</ReactMarkdown>
      </div>
    </div>
  )
}
