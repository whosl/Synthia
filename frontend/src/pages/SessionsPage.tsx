import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createSession, deleteSession, listSessions } from '../api/sessions'
import type { Session } from '../api/types'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { StatusBadge } from '../components/common/StatusBadge'
import { formatNumber, formatRelative } from '../lib/time'

function SessionCard({
  session,
  onOpen,
  onDelete,
}: {
  session: Session
  onOpen: () => void
  onDelete: () => void
}) {
  const tokens = (session.token_input || 0) + (session.token_output || 0)
  return (
    <article className="session-card">
      <div className="session-card-head">
        <div className="session-card-title">
          <strong>{session.name || 'Untitled session'}</strong>
        </div>
        <StatusBadge status={session.status} />
      </div>
      <dl className="session-card-meta">
        <div><dt>Updated</dt><dd>{formatRelative(session.updated_at)}</dd></div>
        <div><dt>Messages</dt><dd>{formatNumber(session.message_count)}</dd></div>
        <div><dt>tools called</dt><dd>{formatNumber(session.tool_call_count)}</dd></div>
        {tokens > 0 && (
          <div><dt>Tokens</dt><dd>{formatNumber(tokens)}</dd></div>
        )}
      </dl>
      <div className="session-card-actions">
        <Button className="primary" onClick={onOpen}>
          Open <ChevronRight size={14} />
        </Button>
        <Button
          className="ghost danger-ghost"
          onClick={(e) => {
            e.stopPropagation()
            if (confirm('Archive this session?')) onDelete()
          }}
        >
          <Trash2 size={14} /> Delete
        </Button>
      </div>
    </article>
  )
}

export default function SessionsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'name' | 'status'>('updated')
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => listSessions({ limit: 200 }),
  })
  const create = useMutation({ mutationFn: createSession, onSuccess: ({ session }) => navigate(`/term?session=${session.id}`) })
  const del = useMutation({ mutationFn: (id: string) => deleteSession(id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }) })

  const sessions = useMemo(() => {
    const rows = data?.sessions ?? []
    const filtered = rows.filter((s) => `${s.name} ${s.id} ${s.status}`.toLowerCase().includes(query.toLowerCase()))
    return filtered.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'status') return String(a.status || '').localeCompare(String(b.status || ''))
      return (b.updated_at || 0) - (a.updated_at || 0)
    })
  }, [data, query, sort])

  const createNow = () => create.mutate({ name: '' })

  return (
    <div className="page sessions-page">
      <div className="page-header sessions-page-header">
        <div className="sessions-page-heading">
          <div className="sessions-title-row">
            <h1 className="page-title">Sessions</h1>
            <Button
              className={`ghost icon-btn sessions-refresh${isFetching ? ' is-spinning' : ''}`}
              type="button"
              aria-label="Refresh sessions"
              title="Refresh"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw size={16} aria-hidden />
            </Button>
          </div>
          <p className="page-subtitle">Manage and resume engineering sessions</p>
        </div>
      </div>

      <div className="toolbar sessions-toolbar">
        <div className="sessions-search-wrap">
          <Search size={15} className="sessions-search-icon" />
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions..."
          />
        </div>
        <select className="select sessions-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="updated">Sort: Updated desc</option>
          <option value="name">Sort: Name</option>
          <option value="status">Sort: Status</option>
        </select>
        <Button
          className="primary sessions-create-btn"
          type="button"
          onClick={createNow}
          disabled={create.isPending}
          aria-label="Create session"
          title="Create session"
        >
          <Plus size={18} />
        </Button>
      </div>

      <section className="panel sessions-panel">
        <div className="sessions-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Messages</th>
                <th>tools called</th>
                <th>Problems</th>
                <th>Tokens</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} onClick={() => navigate(`/term?session=${s.id}`)} style={{ cursor: 'pointer' }}>
                  <td>
                    <div style={{ color: 'var(--text)', fontWeight: 600 }}>{s.name}</div>
                  </td>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="muted">{formatRelative(s.updated_at)}</td>
                  <td>{formatNumber(s.message_count)}</td>
                  <td>{formatNumber(s.tool_call_count)}</td>
                  <td style={{ color: (s.problem_count || 0) > 0 ? 'var(--error)' : undefined }}>{formatNumber(s.problem_count)}</td>
                  <td>{formatNumber((s.token_input || 0) + (s.token_output || 0))}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Button
                      className="ghost icon-btn"
                      title="Archive session"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm('Archive this session?')) del.mutate(s.id)
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                    <ChevronRight size={16} color="var(--muted)" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="sessions-mobile-list">
          {sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onOpen={() => navigate(`/term?session=${s.id}`)}
              onDelete={() => del.mutate(s.id)}
            />
          ))}
        </div>

        {!isLoading && sessions.length === 0 && (
          <EmptyState title="No sessions found" detail="Tap + to start a new Vivado debug session." />
        )}
      </section>
    </div>
  )
}
