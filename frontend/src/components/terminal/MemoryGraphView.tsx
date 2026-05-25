import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getActiveCanvas, getCanvasHistory, getMemoryRef } from '../../api/memory'
import { formatRelative } from '../../lib/time'
import { useTerminalStore } from '../../stores/terminalStore'
import { CollapsibleSection } from '../common/CollapsibleSection'
import { MermaidGraph } from '../common/MermaidGraph'
import { PersonaSummary } from './PersonaSummary'

export function MemoryGraphView({
  sessionId,
  taskId,
  projectId,
  onOpenArtifacts,
}: {
  sessionId: string
  taskId?: string
  projectId?: string
  onOpenArtifacts?: () => void
}) {
  const { t } = useTranslation()
  const toggleCollapsed = useTerminalStore((s) => s.toggleCollapsed)
  const collapsed = useTerminalStore((s) => s.collapsed)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const activeQ = useQuery({
    queryKey: ['memory-canvas-active', taskId],
    queryFn: () => getActiveCanvas(taskId!),
    enabled: Boolean(taskId),
    refetchInterval: 3000,
  })

  const historyQ = useQuery({
    queryKey: ['memory-canvas-history', sessionId],
    queryFn: () => getCanvasHistory(sessionId, 3),
    enabled: Boolean(sessionId),
    refetchInterval: 10000,
  })

  const refQ = useQuery({
    queryKey: ['memory-ref', selectedNodeId],
    queryFn: () => getMemoryRef(selectedNodeId!),
    enabled: Boolean(selectedNodeId),
  })

  const handleNodeClick = (nodeId: string) => {
    setSelectedNodeId(nodeId)
    onOpenArtifacts?.()
  }

  const active = activeQ.data
  const history = historyQ.data?.canvases ?? []

  return (
    <div className="memory-graph-view">
      <section className="memory-canvas-active">
        <div className="memory-section-title">{t('terminal.memoryActiveCanvas')}</div>
        {!taskId ? (
          <p className="muted">{t('terminal.memoryNoTask')}</p>
        ) : activeQ.isLoading ? (
          <p className="muted">{t('terminal.memoryLoading')}</p>
        ) : active && active.node_count > 0 ? (
          <>
            <div className="memory-canvas-meta mono muted">
              v{active.version} · {active.node_count} {t('terminal.memoryNodes')}
            </div>
            <MermaidGraph source={active.mermaid} onNodeClick={handleNodeClick} />
          </>
        ) : (
          <p className="muted">{t('terminal.memoryNoCanvas')}</p>
        )}
      </section>

      {selectedNodeId && (
        <section className="memory-ref-panel">
          <div className="memory-section-title">{t('terminal.memoryNodeRef')}</div>
          {refQ.isLoading && <p className="muted">{t('terminal.memoryLoading')}</p>}
          {refQ.error && <p className="error-text">{String(refQ.error)}</p>}
          {refQ.data && (
            <>
              <div className="memory-ref-label mono">{refQ.data.label || selectedNodeId}</div>
              <pre className="memory-ref-content">{refQ.data.content}</pre>
            </>
          )}
        </section>
      )}

      <section className="memory-canvas-history">
        <div className="memory-section-title">{t('terminal.memoryHistory')}</div>
        {history.length === 0 ? (
          <p className="muted">{t('terminal.memoryNoHistory')}</p>
        ) : (
          history.map((canvas) => {
            const key = `memory-history-${canvas.id}`
            const isCollapsed = collapsed[key] ?? true
            return (
              <div key={canvas.id} className="memory-history-item">
                <button
                  type="button"
                  className="memory-history-header"
                  onClick={() => toggleCollapsed(key, true)}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className="mono">
                    task {canvas.task_id.slice(0, 8)} · v{canvas.version} · {canvas.node_count} nodes
                  </span>
                  <span className="muted">{formatRelative(canvas.updated_at)}</span>
                </button>
                <CollapsibleSection open={!isCollapsed}>
                  <MermaidGraph source={canvas.mermaid} />
                </CollapsibleSection>
              </div>
            )
          })
        )}
      </section>

      <aside className="memory-persona-card">
        <div className="memory-section-title">{t('terminal.memoryPersona')}</div>
        <PersonaSummary projectId={projectId} />
      </aside>
    </div>
  )
}
