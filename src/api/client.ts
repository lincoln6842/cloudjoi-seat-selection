import createClient from 'openapi-fetch'
import type { components, paths } from './schema'

export type Schemas = components['schemas']

export const EVENT_ID = import.meta.env.VITE_EVENT_ID ?? '1'

// Same-origin '/api' in dev (fake API) and local (Vite proxy to Laravel).
// Production points VITE_API_BASE_URL at the real API host.
export const api = createClient<paths>({
  baseUrl: `${import.meta.env.VITE_API_BASE_URL ?? ''}/api`,
})

// The anonymous session token lives in localStorage so a reload keeps
// the user's holds. Storage can be unavailable (private mode): then the
// session only lasts for this page load.
const TOKEN_KEY = 'cloudjoi.session'
let token: string | null = readToken()

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {})

api.use({
  onRequest({ request }) {
    if (token) request.headers.set('Authorization', `Bearer ${token}`)
    return request
  },
})

let starting: Promise<void> | null = null

/** Starts a session if we have none. `fresh` discards the stored one (e.g. after a 401). */
export function ensureSession(fresh = false): Promise<void> {
  if (fresh) token = null
  if (token) return Promise.resolve()
  starting ??= startSession().finally(() => (starting = null))
  return starting
}

async function startSession(): Promise<void> {
  const { data, error } = await api.POST('/sessions')
  if (error || !data) throw new Error('Could not start a session.')
  token = data.token
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Session still works for this page load.
  }
}
