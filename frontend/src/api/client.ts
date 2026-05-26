import type { ApiErrorShape } from './types'

export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1'

const TOKEN_KEY = 'synthia.api.token'

export function getApiToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setApiToken(token: string): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
  } else {
    localStorage.removeItem(TOKEN_KEY)
  }
}

export class ApiError extends Error {
  status: number
  body: ApiErrorShape | string | null

  constructor(status: number, body: ApiErrorShape | string | null) {
    const message = typeof body === 'string' ? body : body?.detail || body?.error || body?.message || `HTTP ${status}`
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getApiToken()
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })

  if (!res.ok) {
    let body: ApiErrorShape | string | null = null
    try { body = await res.json() } catch { body = await res.text().catch(() => null) }
    throw new ApiError(res.status, body)
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export function jsonBody(body: unknown): RequestInit {
  return { body: JSON.stringify(body) }
}

export function streamUrl(path: string): string {
  return `${API_BASE}${path}`
}
