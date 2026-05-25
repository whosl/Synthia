import mermaid from 'mermaid'
import { useEffect, useId, useRef } from 'react'

let mermaidInitialized = false

function ensureMermaid() {
  if (mermaidInitialized) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    flowchart: { htmlLabels: true, curve: 'basis' },
  })
  mermaidInitialized = true
}

export function MermaidGraph({
  source,
  onNodeClick,
  className = '',
}: {
  source: string
  onNodeClick?: (nodeId: string) => void
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderId = useId().replace(/:/g, '')

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const text = (source || 'graph TD\n').trim()
    if (!text) {
      el.innerHTML = ''
      return
    }

    let cancelled = false
    ensureMermaid()

    mermaid
      .render(`mmd-${renderId}-${Date.now()}`, text)
      .then(({ svg, bindFunctions }) => {
        if (cancelled || !containerRef.current) return
        containerRef.current.innerHTML = svg
        bindFunctions?.(containerRef.current)

        if (!onNodeClick) return
        const nodes = containerRef.current.querySelectorAll('[id^="flowchart-"], [id*="n_"]')
        nodes.forEach((node) => {
          const id = node.getAttribute('id') || ''
          const match = id.match(/n_([a-z0-9]{4,12})/i)
          if (!match) return
          const nodeId = match[1]
          node.classList.add('mermaid-node-clickable')
          node.addEventListener('click', (ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            onNodeClick(nodeId)
          })
        })
      })
      .catch(() => {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = `<pre class="mermaid-fallback">${text.replace(/</g, '&lt;')}</pre>`
        }
      })

    return () => {
      cancelled = true
    }
  }, [source, onNodeClick, renderId])

  return <div ref={containerRef} className={`mermaid-graph ${className}`.trim()} role="img" aria-label="Task memory graph" />
}
