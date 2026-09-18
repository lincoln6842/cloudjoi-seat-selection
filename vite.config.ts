import { networkInterfaces } from 'node:os'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { qrcode } from 'vite-plugin-qrcode'
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
      // With --host: a QR of the network URL to open on a phone. Wi-Fi/Ethernet
      // only; a VPN tunnel address (utun*) isn't reachable from the phone.
      qrcode({ filter: (url) => lanAddresses().includes(new URL(url).hostname) }),
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

function lanAddresses(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([name]) => /^(en|eth|wl)/.test(name))
    .flatMap(([, addresses]) => addresses?.map((a) => a.address) ?? [])
}
