import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveToolElapsedMs } from '../../lib/toolElapsed'
import { StatusPill, type StatusKind } from '../common/StatusPill'

export interface ToolCallViewModel {
  id: string
  name: string
  state: 'running' | 'completed' | 'error' | 'rejected' | 'stopped'
  args?: string
  result?: string
  error?: string
  startedAt?: number
  startedAtMs?: number
  elapsedMs?: number
  completedAtMs?: number
}

function formatElapsed(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const sec = Math.floor(ms / 1000) % 60
  const min = Math.floor(ms / 60_000)
  return `${min}m ${sec}s`
}

function toolStateToStatus(state: ToolCallViewModel['state']): StatusKind {
  switch (state) {
    case 'running':
      return 'running'
    case 'completed':
      return 'succeeded'
    case 'error':
      return 'failed'
    case 'rejected':
      return 'needs_approval'
    case 'stopped':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

function useToolElapsed(tool: ToolCallViewModel) {
  const [tick, setTick] = useState(() => Date.now())
  const running = tool.state === 'running'

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setTick(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [running])

  return useMemo(() => {
    const completedAtMs = running ? tick : tool.completedAtMs
    return resolveToolElapsedMs(tool, { completedAtMs })
  }, [tool, running, tick])
}

function parseArgPreview(args?: string): Array<[string, string]> {
  if (!args?.trim()) return []
  try {
    const obj = JSON.parse(args) as Record<string, unknown>
    return Object.entries(obj)
      .slice(0, 3)
      .map(([k, v]) => [k, String(v)])
  } catch {
    return []
  }
}

export function ToolCallBlock({
  tool,
  defaultCollapsed = true,
}: {
  tool: ToolCallViewModel
  defaultCollapsed?: boolean
}) {
  const { t } = useTranslation()
  const status = toolStateToStatus(tool.state)
  const elapsedMs = useToolElapsed(tool)
  const autoExpand = tool.state === 'error' || tool.state === 'rejected'
  const [expanded, setExpanded] = useState(() => autoExpand || !defaultCollapsed)
  const argPairs = parseArgPreview(tool.args)

  const outputText = tool.result || (tool.state === 'error' || tool.state === 'rejected' || tool.state === 'stopped'
    ? ''
    : t('toolBlock.noResult'))

  return (
    <div
      className={`tool-call-block trace-block tool-block status-${status} ${tool.state}${expanded ? ' is-expanded' : ''}`}
    >
      <header
        className="tcb-head trace-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded((v) => !v)
          }
        }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="tcb-tool">tool · {tool.name}</span>
        {argPairs.map(([k, v]) => (
          <span key={k} className="tcb-arg" title={v}>
            {k}={v.slice(0, 40)}
          </span>
        ))}
        <span className="tcb-spacer spacer" />
        {elapsedMs != null && (
          <span className={`tcb-elapsed tool-elapsed${tool.state === 'running' ? ' tool-elapsed-live' : ''}`}>
            {formatElapsed(elapsedMs)}
          </span>
        )}
        <StatusPill status={status} label={tool.state} />
      </header>
      {expanded && (
        <div className="tcb-body trace-body">
          {tool.args && (
            <>
              <b>{t('toolBlock.input')}</b>
              {'\n'}
              {tool.args}
              {'\n\n'}
            </>
          )}
          {tool.state === 'error' && tool.error && (
            <div className="tcb-error">
              <b>{t('toolBlock.error')}</b>
              {'\n'}
              {tool.error}
            </div>
          )}
          {(outputText || tool.state === 'completed') && (
            <>
              <b>{t('toolBlock.output')}</b>
              {'\n'}
              <pre className="tcb-output">{outputText}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
