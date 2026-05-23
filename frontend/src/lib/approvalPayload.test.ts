import { describe, expect, it } from 'vitest'
import { parseApprovalPayload } from './approvalPayload'

describe('parseApprovalPayload', () => {
  it('drops legacy details field that repeats script', () => {
    const script = 'open_checkpoint /tmp/foo.dcp\nreport_utilization'
    const reason = JSON.stringify({
      reason: '需要导出 utilization',
      action: 'Run script',
      script,
      target_id: 'default-remote',
      details: `Allow executing this Vivado Tcl script on the target?\nScript:\n${script}`,
    })
    const rows = parseApprovalPayload(reason)
    expect(rows.map((r) => r.key)).not.toContain('details')
    expect(rows.map((r) => r.label)).not.toContain('说明')
    expect(rows.find((r) => r.key === 'script')?.value).toContain('open_checkpoint')
  })
})
