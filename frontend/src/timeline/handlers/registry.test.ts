import { describe, expect, it } from 'vitest'
import { registerTimelineEventHandler, resolveTimelineEventHandler } from './registry'
import { emptyTimelineState } from '../types'
import type { SessionEvent } from '../../api/types'
import type { TimelineHandlerContext } from '../context'

describe('timeline handler registry', () => {
  it('resolves builtin handlers', () => {
    expect(resolveTimelineEventHandler('tool.started')).not.toBe(resolveTimelineEventHandler('unknown.xyz'))
  })

  it('supports extension registration', () => {
    const marker = { called: false }
    registerTimelineEventHandler('demo.extension', (ctx: TimelineHandlerContext) => {
      marker.called = true
      return ctx.state
    })
    const handler = resolveTimelineEventHandler('demo.extension')
    const event = {
      id: '1',
      session_id: 's',
      seq: 1,
      event_type: 'demo.extension',
      payload: {},
    } as SessionEvent
    handler({
      state: emptyTimelineState(),
      envelope: {} as any,
      event,
      payload: {},
      text: '',
      taskId: null,
      options: {},
    })
    expect(marker.called).toBe(true)
  })

  it('routes custom.* to custom handler', () => {
    const h = resolveTimelineEventHandler('custom.dashboard')
    expect(h.name).toBe('handleCustomOrExtension')
  })
})
