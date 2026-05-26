import { Command } from 'cmdk'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { applyTheme, type ThemeId } from '../../lib/theme'

export function CommandPalette() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const nav = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const go = (path: string) => {
    nav(path)
    setOpen(false)
  }

  const setTheme = (theme: ThemeId) => {
    applyTheme(theme)
    setOpen(false)
  }

  return (
    <Command.Dialog open={open} onOpenChange={setOpen} label={t('settings.title')}>
      <Command.Input placeholder="Type a command or search…" />
      <Command.List>
        <Command.Empty>No results.</Command.Empty>

        <Command.Group heading="Navigate">
          <Command.Item onSelect={() => go('/')}>{t('nav.projects')}</Command.Item>
          <Command.Item onSelect={() => go('/sessions')}>{t('nav.sessions')}</Command.Item>
          <Command.Item onSelect={() => go('/term')}>Terminal</Command.Item>
          <Command.Item onSelect={() => go('/runs')}>{t('nav.runs')}</Command.Item>
          <Command.Item onSelect={() => go('/reports')}>{t('nav.reports')}</Command.Item>
          <Command.Item onSelect={() => go('/approvals')}>{t('nav.approvals')}</Command.Item>
          <Command.Item onSelect={() => go('/connectors')}>{t('nav.connectors')}</Command.Item>
          <Command.Item onSelect={() => go('/settings')}>{t('nav.settings')}</Command.Item>
        </Command.Group>

        <Command.Group heading="Theme">
          <Command.Item onSelect={() => setTheme('warm')}>Light (warm)</Command.Item>
          <Command.Item onSelect={() => setTheme('claude-dark')}>Dark (claude)</Command.Item>
          <Command.Item onSelect={() => setTheme('obsidian')}>Obsidian</Command.Item>
          <Command.Item onSelect={() => setTheme('meadow')}>Meadow</Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  )
}
