import { describe, expect, it } from 'vitest'
import { buildApprovalResponse } from './approvalResponse'

describe('buildApprovalResponse', () => {
  it('keeps duplicate paths when multiple changes target the same file', () => {
    const files = [
      { path: 'rtl/top.v', content: 'a', action: 'modify' },
      { path: 'rtl/top.v', content: 'b', action: 'modify' },
    ]
    const res = buildApprovalResponse(files, [0, 1])
    expect(res.approved_indices).toEqual([0, 1])
    expect(res.approved_files).toEqual(['rtl/top.v', 'rtl/top.v'])
  })
})
