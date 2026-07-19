import 'dotenv/config'
import express from 'express'
import http from 'http'
import path from 'path'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { sessionMiddleware, requireAuth, loginHandler, logoutHandler, meHandler } from './auth'
import * as pm2Service from './pm2Service'
import * as layoutStore from './layoutStore'
import * as filterStore from './filterStore'
import * as archiveStore from './archiveStore'
import * as portService from './portService'
import { setupWebSocket } from './websocket'
import { LogFilter } from './types'

const HOST = process.env.PM2_MATRIX_HOST ?? '0.0.0.0'
const PORT = parseInt(process.env.PM2_MATRIX_PORT ?? '8080', 10)

// Maximum number of service names allowed in a layout order array.
// Keeps the stored file and in-memory cache from growing unboundedly.
const MAX_ORDER_LENGTH = 200
// Maximum length of a service name accepted by the API.
const MAX_NAME_LENGTH = 200

const app = express()
const server = http.createServer(app)

// Trust the first hop (reverse proxy) only when explicitly opted in via the
// TRUST_PROXY env var.  Enabling this unconditionally when not behind a proxy
// allows attackers to spoof their IP via X-Forwarded-For, which defeats the
// rate-limiter's per-IP bucketing.
// Set TRUST_PROXY=1 in your .env when running behind Nginx, Caddy, etc.
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1)
}

// HTTP security headers.  CSP is disabled because the React SPA uses inline
// styles from dnd-kit; all other protections are active.
app.use(helmet({ contentSecurityPolicy: false }))

app.use(express.json())
app.use(sessionMiddleware)

// Brute-force protection: max 20 login attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
})

// --- Auth routes (no auth guard) ---
app.post('/api/login', loginLimiter, loginHandler)
app.post('/api/logout', requireAuth, logoutHandler)
app.get('/api/me', meHandler)
app.get('/api/health', requireAuth, (req, res) => {
  res.json({ pm2: pm2Service.getHealth() })
})

// --- Protected API routes ---
app.get('/api/services', requireAuth, (req, res) => {
  const services = pm2Service.getServiceStats()
  const layout = layoutStore.getLayout()
  res.json({ services, order: layout.order })
})

/**
 * Validates that the requested service name exists in the current PM2 service
 * map before dispatching to PM2.  This prevents acting on arbitrary names
 * injected via the URL, and keeps read + write routes consistent.
 */
function requireKnownService(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const knownNames = pm2Service.getServices().map(s => s.name)
  if (!knownNames.includes(req.params.name)) {
    res.status(404).json({ error: 'Service not found' })
    return
  }
  next()
}

app.get('/api/services/:name/logs', requireAuth, requireKnownService, (req, res) => {
  const logs = pm2Service.getLogs(req.params.name)
  res.json({ logs })
})

/**
 * Factory that creates an authenticated, name-validated service action handler.
 * Each action (restart/reload/stop/start) follows the same pattern; this avoids
 * repeating 10 lines of boilerplate for every route.
 */
function serviceActionHandler(
  action: string,
  fn: (name: string) => Promise<void>
): express.RequestHandler[] {
  return [
    requireAuth,
    requireKnownService,
    async (req, res) => {
      try {
        await fn(req.params.name)
        res.json({ ok: true })
      } catch (err) {
        console.error(`[api] ${action} failed:`, err)
        res.status(500).json({ error: 'Action failed' })
      }
    },
  ]
}

app.post('/api/service/:name/restart', ...serviceActionHandler('restart', pm2Service.restart))
app.post('/api/service/:name/reload',  ...serviceActionHandler('reload',  pm2Service.reload))
app.post('/api/service/:name/stop',    ...serviceActionHandler('stop',    pm2Service.stop))
app.post('/api/service/:name/start',   ...serviceActionHandler('start',   pm2Service.start))

app.get('/api/ports', requireAuth, async (req, res) => {
  try {
    const services = pm2Service.getServices()
    let anyFallback = false
    const entries = await Promise.all(
      services.map(async (svc) => {
        if (!svc.pids.length) {
          console.warn(`[api] /api/ports: "${svc.name}" has no PIDs (status: ${svc.status}) — skipping`)
          return [svc.name, []] as [string, number[]]
        }
        const result = await portService.getPortsForPids(svc.pids)
        console.log(`[api] /api/ports: "${svc.name}" pids=[${svc.pids}] → ports=[${result.ports}] fallback=${result.fallbackUsed}`)
        if (result.fallbackUsed) anyFallback = true
        return [svc.name, result.ports] as [string, number[]]
      })
    )
    // fallbackUsed signals to the frontend that UID-based matching was used for
    // at least one service, so port data may include ports from co-user processes.
    res.json({ ports: Object.fromEntries(entries), fallbackUsed: anyFallback })
  } catch (err) {
    console.error('[api] /api/ports failed:', err)
    res.json({ ports: {}, fallbackUsed: false })
  }
})

app.post('/api/settings/poll-interval', requireAuth, (req, res) => {
  const { seconds } = req.body as { seconds?: number }
  if (typeof seconds !== 'number' || !isFinite(seconds)) {
    res.status(400).json({ error: 'seconds must be a number' })
    return
  }
  const clamped = Math.max(1, Math.min(60, Math.round(seconds)))
  pm2Service.setPollInterval(clamped * 1000)
  res.json({ ok: true, seconds: clamped })
})

app.get('/api/card-filters', requireAuth, (req, res) => {
  res.json(filterStore.getFilters())
})

app.get('/api/card-archive', requireAuth, (req, res) => {
  res.json(archiveStore.getArchivedMap())
})

app.post('/api/card-filters', requireAuth, (req, res) => {
  const { name, filter } = req.body as { name?: string; filter?: string }

  // Validate filter value first.
  if (!name || !['all', 'stdout', 'stderr'].includes(filter ?? '')) {
    res.status(400).json({ error: 'name and valid filter required' })
    return
  }

  // Reject names that are too long or not a known service to prevent unbounded
  // growth of the persisted filter file.
  if (name.length > MAX_NAME_LENGTH) {
    res.status(400).json({ error: 'name too long' })
    return
  }
  const knownNames = pm2Service.getServices().map(s => s.name)
  if (!knownNames.includes(name)) {
    res.status(404).json({ error: 'Service not found' })
    return
  }

  try {
    filterStore.setFilter(name, filter as LogFilter)
    // Opportunistically remove entries for services that no longer exist so
    // both persisted files do not grow indefinitely as services are added/removed.
    archiveStore.pruneUnknown(knownNames)
    filterStore.pruneUnknown(knownNames)
    layoutStore.pruneUnknown(knownNames)
  } catch {
    res.status(500).json({ error: 'Failed to save filter' })
    return
  }
  res.json({ ok: true })
})

app.post('/api/card-archive', requireAuth, (req, res) => {
  const { name, archived } = req.body as { name?: string; archived?: unknown }
  if (!name || typeof archived !== 'boolean') {
    res.status(400).json({ error: 'name and archived(boolean) required' })
    return
  }
  if (name.length > MAX_NAME_LENGTH) {
    res.status(400).json({ error: 'name too long' })
    return
  }
  const knownNames = pm2Service.getServices().map(s => s.name)
  if (!knownNames.includes(name)) {
    res.status(404).json({ error: 'Service not found' })
    return
  }

  try {
    archiveStore.setArchived(name, archived)
    archiveStore.pruneUnknown(knownNames)
    filterStore.pruneUnknown(knownNames)
    layoutStore.pruneUnknown(knownNames)
  } catch {
    res.status(500).json({ error: 'Failed to save archive setting' })
    return
  }
  res.json({ ok: true })
})

app.get('/api/layout', requireAuth, (req, res) => {
  res.json(layoutStore.getLayout())
})

app.post('/api/layout', requireAuth, (req, res) => {
  const { order } = req.body as { order?: unknown[] }

  if (!Array.isArray(order)) {
    res.status(400).json({ error: 'order must be an array' })
    return
  }

  // Validate length and that every element is a non-empty string.  This
  // prevents unbounded disk writes from a malicious authenticated request.
  if (order.length > MAX_ORDER_LENGTH) {
    res.status(400).json({ error: `order may contain at most ${MAX_ORDER_LENGTH} entries` })
    return
  }
  if (!order.every(e => typeof e === 'string' && e.length > 0 && e.length <= MAX_NAME_LENGTH)) {
    res.status(400).json({ error: 'each order entry must be a non-empty string' })
    return
  }

  try {
    layoutStore.saveLayout(order as string[])
  } catch {
    res.status(500).json({ error: 'Failed to save layout' })
    return
  }
  res.json({ ok: true })
})

// Return a JSON 404 for any unmatched API route so that typos in API paths do
// not silently fall through to the SPA catch-all and return HTML.
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// --- Serve static React build ---
const staticDir = path.join(__dirname, '..', 'dist')
app.use(express.static(staticDir))
app.get('*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'))
})

// --- WebSocket ---
setupWebSocket(server)

// --- Connect PM2 and start ---
pm2Service.connect()
  .then(async () => {
    // Wait for the first poll to complete so that getServices() returns actual
    // data before we merge into the layout.
    await pm2Service.waitForFirstPoll()
    const names = pm2Service.getServices().map(s => s.name)
    layoutStore.mergeServices(names)

    server.listen(PORT, HOST, () => {
      console.log(`[pm2-matrix] Listening on http://${HOST}:${PORT}`)
    })
  })
  .catch((err) => {
    console.error('[pm2-matrix] Failed to connect to PM2:', err)
    console.log('[pm2-matrix] Starting without PM2 and scheduling reconnect...')
    pm2Service.reconnectLoop()

    server.listen(PORT, HOST, () => {
      console.log(`[pm2-matrix] Listening on http://${HOST}:${PORT}`)
    })
  })
