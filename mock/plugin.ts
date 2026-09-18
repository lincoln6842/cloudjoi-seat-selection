import { readFileSync } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { components } from '../src/api/schema.js'
import { createFakeReverb } from './reverb.ts'
import { ApiError, FakeVenue } from './venue.ts'

type Seatmap = components['schemas']['Seatmap']

interface Options {
  reverbAppKey: string
  /** Simulated other buyers. MOCK_BOTS=off for a quiet venue. */
  bots: boolean
  /** Max random response delay in ms, so pending states are visible. MOCK_LATENCY=0 to disable. */
  latency: number
  /** Hold expiry override (MOCK_HOLD_SECONDS=30) to see the expiry flow without waiting 5 minutes. */
  holdSeconds?: number
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))

/**
 * Dev-only fake backend implementing api/openapi.yaml inside the Vite dev
 * server: real HTTP on /api and a fake Reverb WebSocket, one shared state
 * for every browser and device that connects.
 */
export function fakeApi(options: Options): Plugin {
  return {
    name: 'cloudjoi-fake-api',
    apply: 'serve',
    configureServer(server) {
      const httpServer = server.httpServer
      if (!httpServer) return

      const seatmap = readJson<Seatmap>('./data/seatmap.json')
      const { unavailable } = readJson<{ unavailable: string[] }>('./data/availability.json')
      const channel = `events.${seatmap.event.id}.seats`
      const reverb = createFakeReverb(httpServer as Server, options.reverbAppKey)
      const venue = new FakeVenue(seatmap, unavailable, {
        holdTtlMs: options.holdSeconds && options.holdSeconds * 1000,
        now: Date.now,
        random: Math.random,
        broadcast: (payload) => reverb.broadcast(channel, 'seats.changed', payload),
      })

      const timers = [
        setInterval(() => venue.sweep(), 1_000),
        options.bots && setInterval(() => venue.botTick(), 800),
        // Now and then the venue revokes someone's seat, so the "lost seat" flow shows up.
        options.bots && setInterval(() => Math.random() < 0.5 && venue.revoke(), 60_000),
      ]
      httpServer.on('close', () => {
        timers.forEach((t) => t && clearInterval(t))
        reverb.close()
      })

      server.middlewares.use('/api', (req, res) => {
        const delay = Math.random() * options.latency
        setTimeout(() => void route(venue, req, res).catch((e) => sendError(res, e)), delay)
      })
    },
  }
}

async function route(venue: FakeVenue, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  const method = req.method ?? 'GET'
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

  if (method === 'POST' && url.pathname === '/sessions') {
    return send(res, 201, { token: venue.createSession() })
  }
  if (method === 'POST' && url.pathname === '/__dev/revoke') {
    return send(res, 200, { revoked: venue.revoke(token) })
  }

  const [events, eventId, resource, seatId] = parts
  if (events !== 'events' || eventId !== venue.seatmap.event.id) {
    throw new ApiError(404, 'NOT_FOUND', 'No such event.')
  }

  switch (`${method} ${resource}${seatId === undefined ? '' : '/:seat'}`) {
    case 'GET seatmap':
      return send(res, 200, venue.seatmap)
    case 'GET availability': {
      const since = url.searchParams.get('since')
      return send(res, 200, venue.availability(since === null ? undefined : Number(since)))
    }
    case 'GET holds':
      return send(res, 200, venue.holdSet(token))
    case 'POST holds': {
      const body = await readBody(req)
      if (typeof body?.seat_id !== 'string') throw new ApiError(422, 'VALIDATION_FAILED', 'seat_id is required.')
      const created = venue.hold(token, body.seat_id)
      return send(res, created ? 201 : 200, venue.holdSet(token))
    }
    case 'DELETE holds/:seat':
      venue.release(token, seatId)
      return send(res, 200, venue.holdSet(token))
    case 'POST checkout':
      return send(res, 201, { order_id: venue.checkout(token) })
    default:
      throw new ApiError(404, 'NOT_FOUND', `No route ${method} ${url.pathname}.`)
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Body must be JSON.')
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, error: unknown) {
  if (error instanceof ApiError) {
    return send(res, error.status, { error: { code: error.code, message: error.message } })
  }
  console.error(error)
  send(res, 500, { error: { code: 'INTERNAL', message: 'Fake API crashed.' } })
}
