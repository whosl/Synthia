import { Check, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../common/Button'

export interface InputFieldDef {
  id: string
  label: string
  field_type: 'text' | 'select' | 'search_select'
  options?: { value: string; label: string }[]
  placeholder?: string
  recommendations?: string[]
  required?: boolean
}

export interface InputRequestBlockProps {
  id: string
  title: string
  message: string
  fields: InputFieldDef[]
  status: 'pending' | 'responded'
  response?: Record<string, string>
  onSubmit?: (id: string, values: Record<string, string>) => void
}

function SearchSelect({ field, value, onChange }: { field: InputFieldDef; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)

  const filtered = useMemo(() => {
    if (!field.options) return []
    if (!search) return field.options.slice(0, 50)
    const q = search.toLowerCase()
    return field.options.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)).slice(0, 50)
  }, [field.options, search])

  return <div className="search-select">
    <div className="search-select-input" onClick={() => setOpen(!open)}>
      <Search size={13} />
      <input
        type="text"
        value={open ? search : value || ''}
        placeholder={field.placeholder || t('inputRequest.search')}
        onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
      />
      {value && <span className="search-select-value">{value}</span>}
    </div>
    {open && <div className="search-select-dropdown">
      {field.recommendations && !search && <div className="search-select-section">
        <span className="section-label">{t('inputRequest.recommendations')}</span>
        {field.recommendations.map(r => <div key={r} className="search-select-option recommended" onClick={() => { onChange(r); setOpen(false); setSearch('') }}>{r}</div>)}
      </div>}
      {filtered.length > 0 && <div className="search-select-section">
        {search && <span className="section-label">{t('inputRequest.searchResults', { n: filtered.length })}</span>}
        {filtered.map(o => <div key={o.value} className={`search-select-option ${o.value === value ? 'selected' : ''}`} onClick={() => { onChange(o.value); setOpen(false); setSearch('') }}>{o.label}</div>)}
      </div>}
      {filtered.length === 0 && search && <div className="search-select-empty">{t('inputRequest.noResults')}</div>}
    </div>}
  </div>
}

export function InputRequestBlock({ id, title, message, fields, status, response, onSubmit }: InputRequestBlockProps) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>({})
  const isPending = status === 'pending'

  const setValue = (fieldId: string, value: string) => {
    setValues(prev => ({ ...prev, [fieldId]: value }))
  }

  const canSubmit = fields.filter(f => f.required !== false).every(f => values[f.id]?.trim())

  const handleSubmit = () => {
    if (canSubmit && onSubmit) onSubmit(id, values)
  }

  if (!isPending && response) {
    return <div className="interaction-block input-block status-responded">
      <div className="interaction-header">
        <span className="interaction-title">{title}</span>
        <span className="interaction-badge responded">{t('inputRequest.submitted')}</span>
      </div>
      <div className="interaction-response-summary">
        {fields.map(f => <div key={f.id} className="response-item">
          <span className="response-label">{f.label}:</span>
          <span className="response-value">{response[f.id] || '—'}</span>
          <span className="response-tag">{t('inputRequest.userSelection')}</span>
        </div>)}
      </div>
    </div>
  }

  return <div className="interaction-block input-block status-pending">
    <div className="interaction-header">
      <span className="interaction-title">{title}</span>
    </div>
    {message && <div className="interaction-message">{message}</div>}

    <div className="input-fields">
      {fields.map(field => <div key={field.id} className="input-field-row">
        <label className="input-field-label">
          {field.label} {field.required !== false && <span className="required">*</span>}
        </label>
        {field.field_type === 'text' && <input
          type="text"
          className="input-field-text"
          placeholder={field.placeholder}
          value={values[field.id] || ''}
          onChange={(e) => setValue(field.id, e.target.value)}
        />}
        {field.field_type === 'select' && <select
          className="input-field-select"
          value={values[field.id] || ''}
          onChange={(e) => setValue(field.id, e.target.value)}
        >
          <option value="">{field.placeholder || t('inputRequest.pleaseSelect')}</option>
          {field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>}
        {field.field_type === 'search_select' && <SearchSelect
          field={field}
          value={values[field.id] || ''}
          onChange={(v) => setValue(field.id, v)}
        />}
        {field.recommendations && field.field_type === 'text' && <div className="field-recommendations">
          <span className="rec-label">{t('inputRequest.recommendationsHeading')}</span>
          {field.recommendations.map(r => <button key={r} className="rec-chip" onClick={() => setValue(field.id, r)}>{r}</button>)}
        </div>}
      </div>)}
    </div>

    <div className="interaction-actions">
      <Button className="primary" onClick={handleSubmit} disabled={!canSubmit}>
        <Check size={14} /> {t('inputRequest.submit')}
      </Button>
    </div>
  </div>
}
