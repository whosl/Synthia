import { describe, expect, it } from 'vitest'
import { isSessionRunning, sessionInitials } from './sessionVisual'

describe('sessionVisual', () => {
  it('builds initials from names', () => {
    expect(sessionInitials('Hapi 调试')).toMatch(/H|调/)
    expect(sessionInitials('weather bot')).toBe('WB')
  })

  it('detects running states', () => {
    expect(isSessionRunning('running')).toBe(true)
    expect(isSessionRunning('stopping')).toBe(true)
    expect(isSessionRunning('idle')).toBe(false)
  })
})
