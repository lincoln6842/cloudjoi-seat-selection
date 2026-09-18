import createClient from 'openapi-fetch'
import type { components, paths } from './schema'

export type Schemas = components['schemas']

// Same-origin '/api' in dev (fake API) and local (Vite proxy to Laravel).
// Production points VITE_API_BASE_URL at the real API host.
export const api = createClient<paths>({
  baseUrl: `${import.meta.env.VITE_API_BASE_URL ?? ''}/api`,
})
