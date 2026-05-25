import { Navigate, useLocation } from 'react-router-dom'

/** Legacy routes — KB review merged into Evolution → KB tab. */
export default function KnowledgeBasePage() {
  const location = useLocation()
  return <Navigate to={`/evolution?tab=kb${location.search ? `&${location.search.slice(1)}` : ''}`} replace />
}
