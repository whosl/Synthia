import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../api/client'
import '../../styles/chat-cards.css'

export function MissingInfoCard({
  data,
  sessionId,
}: {
  data: {
    missing_args?: Array<{
      key: string
      prompt: string
      type?: string
      enum_values?: string[]
      default?: string
    }>
    intent?: { intent_id?: string }
    task_id?: string
  }
  sessionId: string
}) {
  const { t } = useTranslation()
  const missing = data.missing_args || []
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {}
    missing.forEach((m) => {
      v[m.key] = String(m.default ?? '')
    })
    return v
  })
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!sessionId || submitted) return
    setError(null)
    try {
      await request(`/api/v1/sessions/${sessionId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          question: t('chat.continueRun', { defaultValue: '继续执行' }),
          manifest_path: values.manifest_path || '',
          metadata: { intent_resume: true, ...values },
        }),
      })
      setSubmitted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="syn-card syn-missing-info">
      <div className="syn-missing-info__title">
        {t('chat.missingInfoTitle', { defaultValue: '缺少参数' })}
        {data.intent?.intent_id ? ` · ${data.intent.intent_id}` : ''}
      </div>
      <div className="syn-missing-info__form">
        {missing.map((m) => (
          <div key={m.key} className="syn-missing-info__field">
            <label>{m.prompt}</label>
            {m.enum_values?.length ? (
              <select
                value={values[m.key] ?? ''}
                onChange={(e) => setValues({ ...values, [m.key]: e.target.value })}
                disabled={submitted}
              >
                {m.enum_values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={m.type === 'number' ? 'number' : 'text'}
                value={values[m.key] ?? ''}
                onChange={(e) => setValues({ ...values, [m.key]: e.target.value })}
                disabled={submitted}
                placeholder={m.type === 'path' ? '/path/to/...' : ''}
              />
            )}
          </div>
        ))}
        {error && <div className="syn-composer__error">{error}</div>}
        <div className="syn-missing-info__actions">
          <button
            type="button"
            className="syn-button syn-button--primary"
            onClick={() => void submit()}
            disabled={submitted}
          >
            {submitted
              ? t('chat.submitted', { defaultValue: '已提交' })
              : t('chat.submitMissing', { defaultValue: '提交并继续' })}
          </button>
        </div>
      </div>
    </div>
  )
}
