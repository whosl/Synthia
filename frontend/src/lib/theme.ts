import i18n from './i18n'

export type ThemeId = 'warm' | 'obsidian' | 'meadow'

export const THEME_STORAGE_KEY = 'edagent-ui-theme'

export function getThemes() {
  return [
    { id: 'warm' as ThemeId, label: i18n.t('theme.warm'), description: i18n.t('theme.warmDesc'), swatches: ['#FAF9F7', '#D97706', '#FFFFFF'] },
    { id: 'obsidian' as ThemeId, label: i18n.t('theme.obsidian'), description: i18n.t('theme.obsidianDesc'), swatches: ['#000000', '#FAFAFA', '#27272A'] },
    { id: 'meadow' as ThemeId, label: i18n.t('theme.meadow'), description: i18n.t('theme.meadowDesc'), swatches: ['#F7FAF3', '#D9EDC2', '#1A1A1A'] },
  ]
}

export const THEMES = typeof window !== 'undefined' ? getThemes() : [
  { id: 'warm' as ThemeId, label: 'Warm', description: 'Light cream surfaces with amber accents (default).', swatches: ['#FAF9F7', '#D97706', '#FFFFFF'] },
  { id: 'obsidian' as ThemeId, label: 'Obsidian', description: 'True-black shell inspired by your Figma site reference.', swatches: ['#000000', '#FAFAFA', '#27272A'] },
  { id: 'meadow' as ThemeId, label: 'Meadow', description: 'Mint canvas, lime panels, and soft pastel accents from your reference.', swatches: ['#F7FAF3', '#D9EDC2', '#1A1A1A'] },
]

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return value === 'warm' || value === 'obsidian' || value === 'meadow'
}

export function getStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    if (isThemeId(raw)) return raw
  } catch {
    /* private mode */
  }
  return 'warm'
}

export function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* ignore */
  }
}

/** Call before React paint to reduce theme flash. */
export function initTheme() {
  applyTheme(getStoredTheme())
}
