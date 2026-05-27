import { useSearchParams } from 'react-router-dom'
import type { CustomEntryPayload } from '../../timeline/types'
import { ArtifactCard } from '../chat/ArtifactCard'
import { MissingInfoCard } from '../chat/MissingInfoCard'
import { RunCard } from '../chat/RunCard'
import { PatchApprovalCard } from '../patches/PatchApprovalCard'

export function CustomEntryBlock({ payload }: { payload: CustomEntryPayload }) {
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session') || ''

  switch (payload.uiKind) {
    case 'missing_info':
      return (
        <MissingInfoCard
          data={payload.data as Parameters<typeof MissingInfoCard>[0]['data']}
          sessionId={sessionId}
        />
      )
    case 'run':
      return <RunCard data={payload.data} />
    case 'artifact':
      return <ArtifactCard data={payload.data} />
    case 'patch': {
      const patchId = String((payload.data as Record<string, unknown>).patch_id || '')
      return patchId ? <PatchApprovalCard patchId={patchId} /> : null
    }
    default:
      break
  }

  const title = payload.title || payload.uiKind
  return (
    <div className="trace-block custom-entry-block">
      <div className="trace-header">
        <span className="custom-entry-kind">{payload.uiKind}</span>
        {title && <span>{title}</span>}
      </div>
      <div className="trace-body">
        <pre className="custom-entry-data">{JSON.stringify(payload.data, null, 2)}</pre>
      </div>
    </div>
  )
}
