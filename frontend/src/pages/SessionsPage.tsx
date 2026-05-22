import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Plus, RefreshCw, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createSession, deleteSession, listSessions } from '../api/sessions'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { StatusBadge } from '../components/common/StatusBadge'
import { formatNumber, formatRelative } from '../lib/time'

export default function SessionsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'name' | 'status'>('updated')
  const [name, setName] = useState('')
  const { data, isLoading, refetch } = useQuery({ queryKey: ['sessions'], queryFn: () => listSessions({ limit: 200 }) })
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

  const createNow = () => create.mutate({ name: name.trim() });

  return <div className="page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Sessions</h1>
        <p className="page-subtitle">Manage and resume engineering sessions</p>
      </div>
      <Button className="ghost" onClick={() => refetch()}><RefreshCw size={15} /> Refresh</Button>
    </div>

    <div className="toolbar">
      <div style={{ position: 'relative', flex: 1, maxWidth: 420 }}>
        <Search size={15} style={{ position: 'absolute', left: 11, top: 10, color: 'var(--muted)' }} />
        <input className="input" style={{ paddingLeft: 34 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sessions..." />
      </div>
      <Button className="ghost"><SlidersHorizontal size={15} /></Button>
      <select className="select" style={{ width: 190 }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
        <option value="updated">Sort: Updated desc</option>
        <option value="name">Sort: Name</option>
        <option value="status">Sort: Status</option>
      </select>
    </div>

    <section className="panel">
      <table className="table">
        <thead><tr><th>Session</th><th>Status</th><th>Updated</th><th>Messages</th><th>Tools</th><th>Problems</th><th>Tokens</th><th /></tr></thead>
        <tbody>
          {sessions.map((s) => <tr key={s.id} onClick={() => navigate(`/term?session=${s.id}`)} style={{ cursor: 'pointer' }}>
            <td><div style={{ color: 'var(--text)', fontWeight: 600 }}>{s.name}</div><div className="muted mono" style={{ fontSize: 11 }}>{s.id}</div></td>
            <td><StatusBadge status={s.status} /></td>
            <td className="muted">{formatRelative(s.updated_at)}</td>
            <td>{formatNumber(s.message_count)}</td>
            <td>{formatNumber(s.tool_call_count)}</td>
            <td style={{ color: (s.problem_count || 0) > 0 ? 'var(--error)' : undefined }}>{formatNumber(s.problem_count)}</td>
            <td>{formatNumber((s.token_input || 0) + (s.token_output || 0))}</td>
            <td style={{ textAlign: 'right' }}>
              <Button className="ghost icon-btn" onClick={(e) => { e.stopPropagation(); if (confirm('Archive this session?')) del.mutate(s.id) }}><Trash2 size={14} /></Button>
              <ChevronRight size={16} color="var(--muted)" />
            </td>
          </tr>)}
        </tbody>
      </table>
      {!isLoading && sessions.length === 0 && <EmptyState title="No sessions found" detail="Create a session below to start a Vivado debug run." />}
    </section>

    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-body" style={{ display: 'flex', gap: 8 }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createNow() }} placeholder="New session name (optional)" />
        <Button className="primary" onClick={createNow} disabled={create.isPending}><Plus size={15} /> Create Session</Button>
      </div>
    </div>
  </div>
}
