import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getApprovals, setPatchApproval, setVivadoApproval } from '../api/settings'
import { Panel } from '../components/common/Panel'
import { PageStickyTop } from '../components/layout/PageStickyTop'
import { StatusBadge } from '../components/common/StatusBadge'
import { applyTheme, getStoredTheme, getThemes, type ThemeId } from '../lib/theme'
import { getLocale, setLocale } from '../lib/i18n'
import '../styles/settings.css'

export default function SettingsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [theme, setTheme] = useState<ThemeId>(() => getStoredTheme())
  const [locale, setLocaleState] = useState<'en' | 'zh'>(getLocale)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const approvals = useQuery({ queryKey: ['approvals'], queryFn: getApprovals })
  const patchMut = useMutation({
    mutationFn: setPatchApproval,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  })
  const vivadoMut = useMutation({
    mutationFn: setVivadoApproval,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  })

  const patchOn = Boolean(approvals.data?.patch_approved)
  const vivadoOn = Boolean(approvals.data?.vivado_execution_approved)

  return (
    <div className="page">
      <PageStickyTop>
        <div className="page-header">
          <div>
            <h1 className="page-title">{t('settings.title')}</h1>
            <p className="page-subtitle">{t('settings.subtitle')}</p>
          </div>
        </div>
      </PageStickyTop>
      <div style={{ display: 'grid', gap: 16, maxWidth: 600 }}>
        <Panel title={t('settings.appearance')}>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
            {t('settings.appearanceDesc')}
          </p>
          <div className="theme-picker" role="radiogroup" aria-label={t('settings.colorScheme')}>
            {getThemes().map((th) => (
              <label
                key={th.id}
                className={`theme-option ${theme === th.id ? 'active' : ''}`}
              >
                <input
                  type="radio"
                  name="ui-theme"
                  value={th.id}
                  checked={theme === th.id}
                  onChange={() => setTheme(th.id)}
                />
                <span className="theme-option-copy">
                  <strong>{th.label}</strong>
                  <span>{th.description}</span>
                </span>
                <span className="theme-swatches" aria-hidden>
                  {th.swatches.map((color) => (
                    <span key={color} className="theme-swatch" style={{ background: color }} />
                  ))}
                </span>
              </label>
            ))}
          </div>
        </Panel>

        <Panel title={t('settings.language')}>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
            {t('settings.languageDesc')}
          </p>
          <div className="language-picker" role="radiogroup" aria-label={t('settings.language')}>
            {(['en', 'zh'] as const).map((lng) => (
              <label
                key={lng}
                className={`theme-option ${locale === lng ? 'active' : ''}`}
              >
                <input
                  type="radio"
                  name="ui-locale"
                  value={lng}
                  checked={locale === lng}
                  onChange={() => { setLocale(lng); setLocaleState(lng) }}
                />
                <span className="theme-option-copy">
                  <strong>{t(`settings.lang${lng === 'en' ? 'En' : 'Zh'}`)}</strong>
                </span>
              </label>
            ))}
          </div>
        </Panel>

        <Panel title={t('settings.filePatchApproval')} actions={<StatusBadge status={patchOn ? 'done' : 'warning'} />}>
          <div style={{ marginBottom: 12, color: patchOn ? 'var(--success)' : 'var(--warning)', fontSize: 13 }}>
            {patchOn
              ? t('settings.filePatchAuto')
              : t('settings.filePatchManual')}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={patchOn}
              onChange={(e) => patchMut.mutate(e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            <span>{t('settings.autoApproveFilePatches')}</span>
          </label>
        </Panel>

        <Panel title={t('settings.vivadoExecutionApproval')} actions={<StatusBadge status={vivadoOn ? 'done' : 'warning'} />}>
          <div style={{ marginBottom: 12, color: vivadoOn ? 'var(--success)' : 'var(--warning)', fontSize: 13 }}>
            {vivadoOn
              ? t('settings.vivadoExecutionAuto')
              : t('settings.vivadoExecutionManual')}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={vivadoOn}
              onChange={(e) => vivadoMut.mutate(e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            <span>{t('settings.autoApproveVivado')}</span>
          </label>
        </Panel>

        <Panel title={t('settings.runtimeConfig')}>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
            {t('settings.runtimeConfigDesc')}
          </div>
        </Panel>
      </div>
    </div>
  )
}