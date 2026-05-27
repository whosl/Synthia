import { useMemo } from 'react'

export interface DiffViewerProps {
  diffText: string
  filename?: string
  maxLines?: number
}

type DiffLine = { kind: 'add' | 'del' | 'ctx' | 'hdr'; text: string }

function parseDiffLines(diffText: string): DiffLine[] {
  return diffText.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      return { kind: 'hdr', text: line }
    }
    if (line.startsWith('+')) return { kind: 'add', text: line }
    if (line.startsWith('-')) return { kind: 'del', text: line }
    return { kind: 'ctx', text: line }
  })
}

export function DiffViewer({ diffText, filename, maxLines = 400 }: DiffViewerProps) {
  const lines = useMemo(() => parseDiffLines(diffText || ''), [diffText])
  const trimmed = lines.length > maxLines ? lines.slice(0, maxLines) : lines

  if (!diffText?.trim()) {
    return <div className="patch-diff patch-diff--empty">(no diff)</div>
  }

  return (
    <div className="patch-diff">
      {filename && <div className="patch-diff__file">{filename}</div>}
      <pre className="patch-diff__pre" aria-label={filename ? `diff ${filename}` : 'diff'}>
        {trimmed.map((line, i) => (
          <div key={i} className={`patch-diff__line patch-diff__line--${line.kind}`}>
            {line.text}
          </div>
        ))}
        {lines.length > maxLines && (
          <div className="patch-diff__truncated">… {lines.length - maxLines} more lines</div>
        )}
      </pre>
    </div>
  )
}
