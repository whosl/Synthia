import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../locales/en.json'
import zh from '../locales/zh.json'

const STORAGE_KEY = 'edagent-ui-locale'

function detectLocale(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch { /* private mode */ }

  const nav = navigator.language || (navigator as { userLanguage?: string }).userLanguage || ''
  if (nav.startsWith('zh')) return 'zh'
  return 'en'
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng: detectLocale(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnObjects: true,
})

export function setLocale(locale: 'en' | 'zh') {
  i18n.changeLanguage(locale)
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch { /* ignore */ }
}

export function getLocale(): 'en' | 'zh' {
  const lng = i18n.language
  return lng === 'zh' ? 'zh' : 'en'
}

export default i18n
