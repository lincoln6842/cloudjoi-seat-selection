import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { fakeApi } from './mock/plugin.ts'

// Modes (see README):
//   development  npm run dev    fake API + fake Reverb inside this server
//   backend      npm run local  /api proxied to the local Laravel app
//   production   npm run build  talks to VITE_API_BASE_URL
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      mode === 'development' &&
        fakeApi({
          reverbAppKey: env.VITE_REVERB_APP_KEY,
          bots: env.MOCK_BOTS !== 'off',
          revoke: env.MOCK_REVOKE === 'on',
          latency: Number(env.MOCK_LATENCY ?? 250),
          holdSeconds: Number(env.MOCK_HOLD_SECONDS) || undefined,
        }),
    ],
    server: {
      proxy: mode === 'backend' ? { '/api': env.BACKEND_URL || 'http://localhost:8000' } : undefined,
    },
  }
})
