import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, KeyRound, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getApprovals,
  getModelSettings,
  saveModelSettings,
  selectModelPreset,
  setPatchApproval,
  setVivadoApproval,
  type ModelSettings,
} from '../api/settings'
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
  const [modelForm, setModelForm] = useState({
    provider: 'openai-compatible',
    base_url: '',
    model: '',
    api_key: '',
    reasoning_effort: 'medium',
  })
  const [modelStatus, setModelStatus] = useState<'idle' | 'saved' | 'error'>('idle')

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const approvals = useQuery({ queryKey: ['approvals'], queryFn: getApprovals })
  const modelSettings = useQuery({ queryKey: ['settings', 'model'], queryFn: getModelSettings })
  const patchMut = useMutation({
    mutationFn: setPatchApproval,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  })
  const vivadoMut = useMutation({
    mutationFn: setVivadoApproval,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  })
  const modelMut = useMutation({
    mutationFn: saveModelSettings,
    onSuccess: (data) => {
      setModelStatus('saved')
      setModelForm(fromModelSettings(data))
      qc.setQueryData(['settings', 'model'], data)
    },
    onError: () => setModelStatus('error'),
  })
  const presetMut = useMutation({
    mutationFn: ({ presetId, reasoningEffort }: { presetId: string; reasoningEffort?: string }) =>
      selectModelPreset(presetId, reasoningEffort),
    onSuccess: (data) => {
      setModelStatus('saved')
      setModelForm(fromModelSettings(data))
      qc.setQueryData(['settings', 'model'], data)
    },
    onError: () => setModelStatus('error'),
  })

  useEffect(() => {
    if (modelSettings.data) {
      setModelForm(fromModelSettings(modelSettings.data))
    }
  }, [modelSettings.data])

  const patchOn = Boolean(approvals.data?.patch_approved)
  const vivadoOn = Boolean(approvals.data?.vivado_execution_approved)
  const savingModel = modelMut.isPending || presetMut.isPending
  const selectedPreset = modelSettings.data?.presets.find((preset) => preset.model === modelForm.model)

  function saveModelConfig() {
    setModelStatus('idle')
    modelMut.mutate({
      provider: modelForm.provider,
      base_url: modelForm.base_url,
      model: modelForm.model,
      reasoning_effort: modelForm.reasoning_effort,
      api_key: modelForm.api_key || undefined,
    })
  }

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
      <div style={{ display: 'grid', gap: 16, maxWidth: 760 }}>
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

        <Panel
          title={t('settings.modelConfig')}
          actions={<StatusBadge status={modelSettings.data?.has_api_key ? 'done' : 'warning'} />}
        >
          <div className="model-settings">
            <div className="model-settings-head">
              <div className="muted model-settings-copy">
                {t('settings.modelConfigDesc')}
              </div>
              <div className="model-key-state">
                <KeyRound size={15} />
                <span>
                  {modelSettings.data?.has_api_key
                    ? t('settings.apiKeyPresent', {
                        key: modelSettings.data.masked_api_key,
                        source: t(`settings.apiKeySource.${modelSettings.data.api_key_source}`),
                      })
                    : t('settings.apiKeyMissing')}
                </span>
              </div>
            </div>

            <div className="model-preset-grid" role="radiogroup" aria-label={t('settings.modelPreset')}>
              {(modelSettings.data?.presets ?? []).map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`model-preset ${selectedPreset?.id === preset.id ? 'active' : ''}`}
                  onClick={() => {
                    setModelStatus('idle')
                    presetMut.mutate({ presetId: preset.id, reasoningEffort: modelForm.reasoning_effort })
                  }}
                  disabled={savingModel}
                >
                  <span>{preset.label}</span>
                  {selectedPreset?.id === preset.id && <Check size={14} />}
                </button>
              ))}
            </div>

            <div className="model-form-grid">
              <label className="settings-field">
                <span>{t('settings.provider')}</span>
                <select
                  value={modelForm.provider}
                  onChange={(e) => setModelForm((form) => ({ ...form, provider: e.target.value }))}
                >
                  <option value="openai-compatible">{t('settings.openaiCompatible')}</option>
                </select>
              </label>
              <label className="settings-field">
                <span>{t('settings.reasoningEffort')}</span>
                <select
                  value={modelForm.reasoning_effort}
                  onChange={(e) => setModelForm((form) => ({ ...form, reasoning_effort: e.target.value }))}
                >
                  {(modelSettings.data?.reasoning_efforts ?? ['low', 'medium', 'high']).map((effort) => (
                    <option key={effort} value={effort}>{t(`settings.reasoning.${effort}`)}</option>
                  ))}
                </select>
              </label>
              <label className="settings-field wide">
                <span>{t('settings.baseUrl')}</span>
                <input
                  type="url"
                  value={modelForm.base_url}
                  onChange={(e) => setModelForm((form) => ({ ...form, base_url: e.target.value }))}
                  placeholder="https://api-slb.krill-ai.com/codex/v1"
                />
              </label>
              <label className="settings-field">
                <span>{t('settings.modelName')}</span>
                <input
                  type="text"
                  value={modelForm.model}
                  onChange={(e) => setModelForm((form) => ({ ...form, model: e.target.value }))}
                  placeholder="gpt-5.5"
                />
              </label>
              <label className="settings-field">
                <span>{t('settings.apiKey')}</span>
                <input
                  type="password"
                  value={modelForm.api_key}
                  onChange={(e) => setModelForm((form) => ({ ...form, api_key: e.target.value }))}
                  placeholder={modelSettings.data?.has_api_key ? t('settings.apiKeyPlaceholderKeep') : t('settings.apiKeyPlaceholderNew')}
                  autoComplete="new-password"
                />
              </label>
            </div>

            <div className="settings-actions">
              <button className="btn primary" type="button" onClick={saveModelConfig} disabled={savingModel}>
                <Save size={15} />
                {savingModel ? t('settings.saving') : t('settings.saveModelConfig')}
              </button>
              {modelStatus === 'saved' && <span className="settings-save-state success">{t('settings.modelConfigSaved')}</span>}
              {modelStatus === 'error' && <span className="settings-save-state error">{t('settings.modelConfigFailed')}</span>}
              {modelSettings.isLoading && <span className="settings-save-state">{t('settings.loadingModelConfig')}</span>}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function fromModelSettings(settings: ModelSettings) {
  return {
    provider: settings.provider || 'openai-compatible',
    base_url: settings.base_url || '',
    model: settings.model || '',
    api_key: '',
    reasoning_effort: settings.reasoning_effort || 'medium',
  }
}
