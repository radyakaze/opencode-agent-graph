import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, resolve } from 'node:path'
import {
  ELECTION_THROTTLE_MS,
  FETCH_TIMEOUT_MS,
  MAX_EVENT_BODY_BYTES,
  STALE_PROCESS_CUTOFF_MS,
  STALE_TICK_INTERVAL_MS,
} from './constants.js'
import { accept, processId, removeStale, setNotifier, state } from './dashboard-state.js'
import type { DashboardEvent } from './dashboard-types.js'

export type ServerOptions = { host: string; port: number; publicRoot: string }
const packageMetadata = createRequire(import.meta.url)('../package.json') as {
  version?: unknown
}
const packageVersion =
  typeof packageMetadata.version === 'string' ? packageMetadata.version : 'unknown'
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}
const FALLBACK_MIME = 'application/octet-stream'
const SSE_PACKET = (data: string) => `event: state\ndata: ${data}\n\n`

export function createGraphServer(options: ServerOptions) {
  let server: Server | undefined
  let starting: Promise<boolean> | undefined
  let lastElection = 0
  const clients = new Set<ServerResponse>()
  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
    })
    res.end(JSON.stringify(value))
  }
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolveBody, reject) => {
      let value = ''
      let done = false
      const fail = (error: Error) => {
        if (!done) {
          done = true
          reject(error)
        }
      }
      req.on('data', (chunk: Buffer) => {
        value += chunk.toString()
        if (value.length > MAX_EVENT_BODY_BYTES) fail(new Error('body too large'))
      })
      req.on('end', () => {
        if (!done) {
          done = true
          resolveBody(value)
        }
      })
      req.on('error', fail)
    })
  const publish = () => {
    const packet = SSE_PACKET(JSON.stringify(state()))
    for (const client of clients) {
      if (client.destroyed || !client.write(packet)) clients.delete(client)
    }
  }
  setNotifier(publish)
  async function file(res: ServerResponse, pathname: string) {
    try {
      const path = resolve(options.publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (path !== options.publicRoot && !path.startsWith(`${options.publicRoot}/`))
        throw new Error()
      res.writeHead(200, {
        'content-type': `${MIME_TYPES[extname(path)] ?? FALLBACK_MIME}; charset=utf-8`,
      })
      res.end(await readFile(path))
    } catch {
      json(res, { error: 'not found' }, 404)
    }
  }
  async function handler(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`)
      if (url.pathname === '/health' && req.method === 'GET') return json(res, { ok: true })
      if (url.pathname === '/version' && req.method === 'GET')
        return json(res, { version: packageVersion })
      if (url.pathname === '/state' && req.method === 'GET') return json(res, state())
      if (url.pathname === '/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'content-type': 'text/event-stream; charset=utf-8',
        })
        res.write(SSE_PACKET(JSON.stringify(state())))
        clients.add(res)
        req.on('close', () => clients.delete(res))
        return
      }
      if (url.pathname === '/events' && req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? '')))
          return json(res, { error: 'content-type must be application/json' }, 400)
        try {
          accept(JSON.parse(await body(req)))
          res.writeHead(204)
          res.end()
        } catch (error) {
          json(
            res,
            {
              error:
                error instanceof Error && error.message === 'body too large'
                  ? error.message
                  : 'invalid JSON',
            },
            400,
          )
        }
        return
      }
      if (req.method === 'GET') return file(res, url.pathname)
      json(res, { error: 'not found' }, 404)
    } catch {
      if (!res.headersSent) json(res, { error: 'internal error' }, 500)
      else res.destroy()
    }
  }
  function start() {
    if (server) return Promise.resolve(true)
    if (starting) return starting
    starting = new Promise((done) => {
      const candidate = createServer((req, res) => void handler(req, res))
      candidate.once('error', () => {
        starting = undefined
        candidate.close()
        done(false)
      })
      candidate.listen(options.port, options.host, () => {
        server = candidate
        starting = undefined
        done(true)
      })
    })
    return starting
  }
  const canElect = () => Date.now() - lastElection >= ELECTION_THROTTLE_MS
  const markElection = () => {
    lastElection = Date.now()
  }
  const healthy = async () => {
    try {
      return (
        await fetch(`http://${options.host}:${options.port}/health`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      ).ok
    } catch {
      return false
    }
  }
  async function send(message: DashboardEvent) {
    if (server) return accept(message)
    try {
      if (!(await healthy()) && canElect()) {
        markElection()
        if (await start()) return accept(message)
      }
      await fetch(`http://${options.host}:${options.port}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      if (canElect()) {
        markElection()
        if (await start()) accept(message)
      }
    }
  }
  const staleTimer = setInterval(
    () => removeStale(Date.now() - STALE_PROCESS_CUTOFF_MS),
    STALE_TICK_INTERVAL_MS,
  ) as ReturnType<typeof setInterval>
  staleTimer.unref?.()
  return { start, send, processId }
}
