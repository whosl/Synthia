import { useTranslation } from 'react-i18next'

export default function PlaceholderPage({ titleKey, phaseKey }: { titleKey: string; phaseKey: string }) {
  const { t } = useTranslation()
  return (
    <div className="page" style={{ padding: 48, textAlign: 'center' }}>
      <h1 className="page-title">{t(titleKey)}</h1>
      <p className="muted">{t(phaseKey)}</p>
    </div>
  )
}
