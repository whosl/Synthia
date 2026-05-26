import { Navigate, useParams } from 'react-router-dom'

/** Session detail — opens Terminal with session pre-selected (§12.38 alias). */
export default function SessionDetailPage() {
  const { sessionId = '' } = useParams()
  if (!sessionId) return <Navigate to="/sessions" replace />
  return <Navigate to={`/term?session=${encodeURIComponent(sessionId)}`} replace />
}
