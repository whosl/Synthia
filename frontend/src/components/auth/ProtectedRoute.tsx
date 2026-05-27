import { useEffect, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { getApiToken } from '../../api/client'

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState<boolean | null>(null)

  useEffect(() => {
    const tok = getApiToken()
    fetch('/api/v1/me', {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    })
      .then((r) => setAllowed(r.ok))
      .catch(() => setAllowed(false))
  }, [])

  if (allowed === null) {
    return <div className="page muted" style={{ padding: 24 }}>Loading…</div>
  }
  if (!allowed) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}
