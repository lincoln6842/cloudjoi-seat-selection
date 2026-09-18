import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * Just enough of the Pusher protocol (what Laravel Reverb speaks) for
 * laravel-echo to connect, subscribe to public channels and receive events.
 * No private/presence channels, no client events.
 */
export function createFakeReverb(httpServer: Server, appKey: string) {
  const wss = new WebSocketServer({ noServer: true })
  const subscriptions = new Map<WebSocket, Set<string>>()
  const send = (ws: WebSocket, message: object) => ws.send(JSON.stringify(message))

  // Vite's own HMR socket shares this server; only take our path.
  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith(`/app/${appKey}`)) return
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket) => {
    const channels = new Set<string>()
    subscriptions.set(ws, channels)
    const socketId = `${Math.floor(Math.random() * 1e9)}.${Math.floor(Math.random() * 1e9)}`
    send(ws, {
      event: 'pusher:connection_established',
      data: JSON.stringify({ socket_id: socketId, activity_timeout: 30 }),
    })

    ws.on('message', (raw) => {
      let message: { event?: string; data?: { channel?: string } }
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      const channel = message.data?.channel
      if (message.event === 'pusher:ping') {
        send(ws, { event: 'pusher:pong', data: '{}' })
      } else if (message.event === 'pusher:subscribe' && channel) {
        channels.add(channel)
        send(ws, { event: 'pusher_internal:subscription_succeeded', channel, data: '{}' })
      } else if (message.event === 'pusher:unsubscribe' && channel) {
        channels.delete(channel)
      }
    })
    ws.on('close', () => subscriptions.delete(ws))
  })

  return {
    broadcast(channel: string, event: string, payload: unknown) {
      const message = JSON.stringify({ event, channel, data: JSON.stringify(payload) })
      for (const [ws, channels] of subscriptions) {
        if (channels.has(channel) && ws.readyState === ws.OPEN) ws.send(message)
      }
    },
    close() {
      for (const ws of subscriptions.keys()) ws.terminate()
      wss.close()
    },
  }
}
