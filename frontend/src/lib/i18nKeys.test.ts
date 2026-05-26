import { describe, expect, it } from 'vitest'
import en from '../locales/en.json'
import zh from '../locales/zh.json'

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : []
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return prefix ? [prefix] : []
  return entries.flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key))
}

describe('i18n locale catalog', () => {
  it('keeps English and Chinese translation keys in sync', () => {
    const enKeys = new Set(flattenKeys(en))
    const zhKeys = new Set(flattenKeys(zh))

    const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key)).sort()
    const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key)).sort()

    expect(missingInZh).toEqual([])
    expect(missingInEn).toEqual([])
  })
})
