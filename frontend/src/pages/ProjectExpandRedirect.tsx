import { Navigate, useParams } from 'react-router-dom'

/** Legacy /projects/:id → home with project expanded */
export default function ProjectExpandRedirect() {
  const { projectId = '' } = useParams()
  if (!projectId) return <Navigate to="/" replace />
  return <Navigate to={`/?expand=${encodeURIComponent(projectId)}`} replace />
}
