import type { CustomEntryPayload } from '../../timeline/types'

export function CustomEntryBlock({ payload }: { payload: CustomEntryPayload }) {
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
