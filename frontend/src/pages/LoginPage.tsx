import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setApiToken } from '../api/client'
import './LoginPage.css'

export default function LoginPage() {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const submit = async () => {
    const trimmed = token.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/v1/me', {
        headers: { Authorization: `Bearer ${trimmed}` },
      })
      if (!r.ok) {
        const body = await r.text()
        throw new Error(body || `HTTP ${r.status}`)
      }
      setApiToken(trimmed)
      navigate('/')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="syn-login">
      <div className="syn-login__card">
        <h1 className="syn-login__title">Synthia</h1>
        <p className="syn-login__sub">AI-powered Vivado workbench</p>
        <input
          type="password"
          className="syn-login__input"
          placeholder="API token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="syn-login__error">{error}</div>}
        <button
          type="button"
          className="syn-login__btn"
          disabled={busy || !token.trim()}
          onClick={submit}
        >
          {busy ? 'Verifying…' : 'Sign in'}
        </button>
        <p className="syn-login__hint">
          Token from <code>~/.synthia/token</code> or <code>edagent admin create-user</code>
        </p>
      </div>
    </div>
  )
}
