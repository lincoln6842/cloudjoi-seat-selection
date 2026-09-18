import Echo from 'laravel-echo'
import Pusher from 'pusher-js'
import type { Schemas } from './client'

export interface SeatFeedHandlers {
  onChange(payload: Schemas['SeatsChanged']): void
  /** 'live' once subscribed; 'reconnecting' whenever the socket drops. */
  onConnection(state: 'live' | 'reconnecting'): void
  /** The socket came back after a drop: broadcasts may have been missed. */
  onReconnected(): void
}

/**
 * Subscribes to the event's public seat channel (see x-realtime in
 * api/openapi.yaml). Same code in every mode: in dev it talks to the fake
 * Reverb inside the Vite server, otherwise to Laravel Reverb.
 */
export function subscribeSeats(eventId: string, handlers: SeatFeedHandlers): () => void {
  const env = import.meta.env
  const port = Number(env.VITE_REVERB_PORT || location.port || (location.protocol === 'https:' ? 443 : 80))
  const echo = new Echo({
    broadcaster: 'reverb',
    Pusher,
    key: env.VITE_REVERB_APP_KEY,
    wsHost: env.VITE_REVERB_HOST || location.hostname,
    wsPort: port,
    wssPort: port,
    forceTLS: env.VITE_REVERB_SCHEME === 'https',
    enabledTransports: ['ws', 'wss'],
    withoutInterceptors: true,
  })

  // pusher-js states: connecting -> connected; a drop goes back through
  // connecting/unavailable while it retries on its own.
  let everConnected = false
  echo.connector.pusher.connection.bind('state_change', ({ current }: { current: string }) => {
    if (current === 'connected') {
      handlers.onConnection('live')
      if (everConnected) handlers.onReconnected()
      everConnected = true
    } else if (everConnected || current === 'unavailable' || current === 'failed') {
      handlers.onConnection('reconnecting')
    }
  })

  echo.channel(`events.${eventId}.seats`).listen('.seats.changed', handlers.onChange)
  return () => echo.disconnect()
}
