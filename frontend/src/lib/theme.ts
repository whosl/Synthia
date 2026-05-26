import i18n from './i18n'

export type ThemeId = 'warm' | 'claude-dark' | 'obsidian' | 'meadow'

export const THEME_STORAGE_KEY = 'synthia.theme'
const LEGACY_THEME_KEY = 'edagent-ui-theme'

export function getThemes() {
  return [
    {
      id: 'warm' as ThemeId,
      label: i18n.t('theme.warm'),
      description: i18n.t('theme.warmDesc'),
      swatches: ['#FAF7F2', '#CC785C', '#FFFFFF'],
    },
    {
      id: 'claude-dark' as ThemeId,
      label: 'Claude dark',
      description: 'Deep warm charcoal with caramel accent (default in dark mode).',
      swatches: ['#1A1815', '#D97757', '#2A2622'],
    },
    {
      id: 'obsidian' as ThemeId,
      label: i18n.t('theme.obsidian'),
      description: i18n.t('theme.obsidianDesc'),
      swatches: ['#000000', '#FAFAFA', '#27272A'],
    },
    {
      id: 'meadow' as ThemeId,
      label: i18n.t('theme.meadow'),
      description: i18n.t('theme.meadowDesc'),
      swatches: ['#F7FAF3', '#D9EDC2', '#1A1A1A'],
    },
  ]
}

export const THEMES =
  typeof window !== 'undefined'
    ? getThemes()
    : [
        { id: 'warm' as ThemeId, label: 'Warm', description: 'Light cream surfaces.', swatches: ['#FAF7F2', '#CC785C', '#FFFFFF'] },
        { id: 'claude-dark' as ThemeId, label: 'Claude dark', description: 'Dark warm shell.', swatches: ['#1A1815', '#D97757', '#2A2622'] },
        { id: 'obsidian' as ThemeId, label: 'Obsidian', description: 'True-black shell.', swatches: ['#000000', '#FAFAFA', '#27272A'] },
        { id: 'meadow' as ThemeId, label: 'Meadow', description: 'Mint canvas.', swatches: ['#F7FAF3', '#D9EDC2', '#1A1A1A'] },
      ]

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return value === 'warm' || value === 'claude-dark' || value === 'obsidian' || value === 'meadow'
}

export function getStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY) ?? localStorage.getItem(LEGACY_THEME_KEY)
    if (isThemeId(raw)) return raw
  } catch {
    /* private mode */
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'claude-dark'
  }
  return 'warm'
}

export function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
    localStorage.setItem(LEGACY_THEME_KEY, theme)
  } catch {
    /* ignore */
  }
}

/** Call before React paint to reduce theme flash. */
export function initTheme() {
  applyTheme(getStoredTheme())
}
