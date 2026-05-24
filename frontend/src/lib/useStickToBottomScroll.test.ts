import { describe, expect, it } from 'vitest'
import { isScrollNearBottom } from './useStickToBottomScroll'

function mockScrollEl({
  scrollHeight,
  clientHeight,
  scrollTop,
}: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}) {
  return { scrollHeight, clientHeight, scrollTop } as HTMLElement
}

describe('isScrollNearBottom', () => {
  it('returns true when within threshold of bottom', () => {
    const el = mockScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 550 })
    expect(isScrollNearBottom(el, 96)).toBe(true)
  })

  it('returns false when scrolled up', () => {
    const el = mockScrollEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 100 })
    expect(isScrollNearBottom(el, 96)).toBe(false)
  })
})
