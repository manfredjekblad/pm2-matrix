/**
 * PM2 service layer.
 *
 * Data flow:
 *   1. connect()       — opens PM2 RPC connection.
 *   2. startPolling()  — calls pm2.list() on a configurable interval and
 *                        updates the in-memory `services` map; notifies
 *                        statsListeners so websocket.ts can broadcast stats.
 *   3. subscribeToBus() — listens to the PM2 event bus for real-time log
 *                         lines (log:out / log:err).  Each line is appended
 *                         via appendLog() and forwarded to logListeners, which
 *                         websocket.ts uses to broadcast individual log frames.
 *   4. changeListeners — notified when services appear or disappear between
 *                         polls, allowing the WebSocket layer to send
 *                         service_added / service_removed messages.
 */
import pm2 from 'pm2'
import { ServiceState, LogEntry, ServiceStats } from './types'

const MAX_LOG_LINES = 1000
const POLL_INTERVAL_MS = 2000
const RECONNECT_INTERVAL_MS = 3000
const POLL_FAILURE_RECONNECT_THRESHOLD = 3

type LogListener = (id: number, app: string, level: 'stdout' | 'stderr', message: string, timestamp: string) => void
type ServiceChangeListener = (type: 'service_added' | 'service_removed', name: string) => void
type StatsListener = (services: ServiceStats[]) => void

// ─── Module-level state ───────────────────────────────────────────────────────
const services = new Map<string, ServiceState>()
// Monotonic counter for LogEntry.id — gives React a stable key for each line.
let logIdCounter = 0

let logListeners: LogListener[] = []
let changeListeners: ServiceChangeListener[] = []
let statsListeners: StatsListener[] = []
let pollTimer: NodeJS.Timeout | null = null
let connected = false
let currentPollIntervalMs = POLL_INTERVAL_MS
let degraded = false
let consecutivePollFailures = 0
let lastSuccessfulPollAt: string | null = null

// Resolvers waiting for the first successful poll to complete.
// Each entry is { resolve, reject } so we can reject them on permanent failure.
let firstPollResolvers: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
let firstPollDone = false
// Prevents multiple concurrent reconnect loops from being started.
let reconnecting = false
// Reference to the active PM2 event bus.  Kept so that on reconnect the old
// bus listeners can be removed before new ones are attached, preventing a
// growing stack of duplicate log/event handlers after each reconnection.
let activeBus: any = null
// ─────────────────────────────────────────────────────────────────────────────

function markHealthyFromPoll() {
  connected = true
  degraded = false
  consecutivePollFailures = 0
  lastSuccessfulPollAt = new Date().toISOString()
}

function handlePollFailure(err: unknown) {
  consecutivePollFailures += 1
  degraded = true

  if (consecutivePollFailures < POLL_FAILURE_RECONNECT_THRESHOLD) {
    console.warn(
      `[pm2Service] pollStats failed (${consecutivePollFailures}/${POLL_FAILURE_RECONNECT_THRESHOLD}):`,
      err
    )
    return
  }

  console.error(
    `[pm2Service] pollStats failed ${consecutivePollFailures} times, reconnecting to PM2...`,
    err
  )
  reconnectLoop()
}

function appendLog(name: string, entry: Omit<LogEntry, 'id'>) {
  const svc = services.get(name)
  if (!svc) return
  svc.logs.push({ ...entry, id: ++logIdCounter })
  if (svc.logs.length > MAX_LOG_LINES) svc.logs.shift()
}

function normalizeStatus(raw: string | undefined): ServiceState['status'] {
  switch (raw) {
    case 'online': return 'online'
    case 'stopped': case 'stopping': return 'stopped'
    case 'errored': return 'errored'
    case 'launching': return 'launching'
    default: return 'unknown'
  }
}

function processToStats(proc: pm2.ProcessDescription): ServiceStats {
  const monit = proc.monit ?? {}
  const pm2Env = proc.pm2_env as Record<string, unknown> | undefined
  const uptimeMs = typeof pm2Env?.pm_uptime === 'number' ? Date.now() - pm2Env.pm_uptime : 0
  return {
    name: proc.name ?? 'unknown',
    status: normalizeStatus(proc.pm2_env?.status),
    cpu: monit.cpu ?? 0,
    memoryMB: Math.round((monit.memory ?? 0) / 1024 / 1024 * 10) / 10,
    uptimeSec: Math.floor(uptimeMs / 1000),
  }
}

async function pollStats() {
  return new Promise<void>((resolve, reject) => {
    pm2.list((err, list) => {
      if (err || !list) { reject(err ?? new Error('pm2.list returned no data')); return }

      const currentNames = new Set(list.map(p => p.name ?? '').filter(Boolean))

      // Detect new services
      for (const proc of list) {
        const name = proc.name ?? ''
        if (!name) continue
        if (!services.has(name)) {
          services.set(name, {
            name,
            status: normalizeStatus(proc.pm2_env?.status),
            cpu: 0,
            memoryMB: 0,
            uptimeSec: 0,
            pids: [],
            logs: [],
          })
          changeListeners.forEach(l => l('service_added', name))
        }
      }

      // Detect removed services — mark stopped, notify listeners, then remove
      // the entry from the map so ghost services don't accumulate over time.
      const removedNames: string[] = []
      for (const [name] of services) {
        if (!currentNames.has(name)) {
          const svc = services.get(name)!
          svc.status = 'stopped'
          changeListeners.forEach(l => l('service_removed', name))
          removedNames.push(name)
        }
      }
      for (const name of removedNames) {
        services.delete(name)
      }

      // Accumulate fresh PIDs into a local map first, then assign them to
      // services in one step.  This prevents a race condition where
      // getServices() (called by GET /api/ports) could read an empty pids
      // array mid-poll if it were reset eagerly before the refill loop.
      const freshPids = new Map<string, number[]>()

      // Update stats.
      for (const proc of list) {
        const name = proc.name ?? ''
        if (!name) continue
        const stats = processToStats(proc)
        const svc = services.get(name)!
        svc.status = stats.status
        svc.cpu = stats.cpu
        svc.memoryMB = stats.memoryMB
        svc.uptimeSec = stats.uptimeSec
        if (typeof proc.pid === 'number' && proc.pid > 0) {
          const arr = freshPids.get(name) ?? []
          arr.push(proc.pid)
          freshPids.set(name, arr)
        }
      }

      // Atomically replace pids arrays once all data is ready.
      for (const [name, pids] of freshPids) {
        const svc = services.get(name)
        if (svc) svc.pids = pids
      }
      // Clear pids for any service no longer in the PM2 list (e.g. stopped).
      for (const [name, svc] of services) {
        if (!freshPids.has(name)) svc.pids = []
      }

      const allStats: ServiceStats[] = Array.from(services.values()).map(s => ({
        name: s.name,
        status: s.status,
        cpu: s.cpu,
        memoryMB: s.memoryMB,
        uptimeSec: s.uptimeSec,
      }))

      statsListeners.forEach(l => l(allStats))
      markHealthyFromPoll()

      // Notify any callers waiting for the first poll to complete.
      if (!firstPollDone) {
        firstPollDone = true
        firstPollResolvers.forEach(r => r.resolve())
        firstPollResolvers = []
      }

      resolve()
    })
  })
}

function subscribeToBus() {
  // Tear down the previous bus before opening a new one.  Without this, each
  // reconnection adds another set of 'log:out' / 'log:err' listeners on top of
  // the existing ones, causing every log line to be processed and broadcast
  // multiple times (once per reconnection cycle).
  if (activeBus) {
    try { activeBus.close() } catch { /* already closed */ }
    activeBus = null
  }

  pm2.launchBus((err, bus) => {
    if (err) {
      console.error('[pm2Service] Bus error:', err)
      return
    }

    activeBus = bus

    bus.on('log:out', (packet: Record<string, unknown>) => {
      const name = (packet.process as Record<string, unknown>)?.name as string ?? ''
      const data = packet.data as string ?? ''
      const timestamp = new Date().toISOString()
      appendLog(name, { timestamp, level: 'stdout', message: data })
      const id = logIdCounter
      logListeners.forEach(l => l(id, name, 'stdout', data, timestamp))
    })

    bus.on('log:err', (packet: Record<string, unknown>) => {
      const name = (packet.process as Record<string, unknown>)?.name as string ?? ''
      const data = packet.data as string ?? ''
      const timestamp = new Date().toISOString()
      appendLog(name, { timestamp, level: 'stderr', message: data })
      const id = logIdCounter
      logListeners.forEach(l => l(id, name, 'stderr', data, timestamp))
    })

    bus.on('process:event', () => {
      pollStats().catch(() => {})
    })

    bus.on('error', (e: unknown) => {
      console.error('[pm2Service] Bus socket error:', e)
      degraded = true
      connected = false
      reconnectLoop()
    })

    bus.on('close', () => {
      console.warn('[pm2Service] PM2 bus closed, reconnecting...')
      degraded = true
      connected = false
      reconnectLoop()
    })
  })
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollStats().catch(handlePollFailure)
  pollTimer = setInterval(() => {
    pollStats().catch(handlePollFailure)
  }, currentPollIntervalMs)
}

export function setPollInterval(ms: number) {
  currentPollIntervalMs = ms
  if (connected) startPolling()
}

/**
 * Returns a promise that resolves once the first pm2.list() poll has
 * completed, or rejects after a 30-second timeout if PM2 never becomes
 * available.  Callers that need the service map populated (e.g. layout merge
 * on startup) should await this before reading getServices().
 */
export function waitForFirstPoll(): Promise<void> {
  if (firstPollDone) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('[pm2Service] waitForFirstPoll timed out after 30 s'))
    }, 30_000)
    firstPollResolvers.push({
      resolve: () => { clearTimeout(timeout); resolve() },
      reject: (e) => { clearTimeout(timeout); reject(e) },
    })
  })
}

export function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.connect(false, (err) => {
      if (err) { reject(err); return }
      connected = true
      degraded = false
      console.log('[pm2Service] Connected to PM2')
      startPolling()
      subscribeToBus()
      resolve()
    })
  })
}

export function reconnectLoop() {
  // Guard against multiple concurrent loops being started (e.g. if called
  // more than once from error handlers).
  if (reconnecting) return
  reconnecting = true

  // Mark disconnected immediately so callers reading isConnected() don't see
  // a stale true value during the reconnect window.
  connected = false
  degraded = true
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }

  const attempt = () => {
    console.log('[pm2Service] Attempting reconnect...')
    connect().then(() => {
      console.log('[pm2Service] Reconnected successfully')
      reconnecting = false
    }).catch(() => {
      setTimeout(attempt, RECONNECT_INTERVAL_MS)
    })
  }
  setTimeout(attempt, RECONNECT_INTERVAL_MS)
}

export function getServices(): ServiceState[] {
  return Array.from(services.values())
}

export function getServiceStats(): ServiceStats[] {
  return Array.from(services.values()).map(s => ({
    name: s.name,
    status: s.status,
    cpu: s.cpu,
    memoryMB: s.memoryMB,
    uptimeSec: s.uptimeSec,
  }))
}

export function getLogs(name: string): LogEntry[] {
  return services.get(name)?.logs ?? []
}

export function restart(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.restart(name, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export function reload(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.reload(name, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export function stop(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.stop(name, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export function start(name: string): Promise<void> {
  // PM2's JS API accepts a process name string here even though the TypeScript
  // typings only declare StartOptions.  We cast to any to avoid the mismatch.
  return new Promise((resolve, reject) => {
    ;(pm2.start as any)(name, (err: Error | null) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export function onLog(listener: LogListener): () => void {
  logListeners.push(listener)
  return () => { logListeners = logListeners.filter(l => l !== listener) }
}

export function onServiceChange(listener: ServiceChangeListener) {
  changeListeners.push(listener)
  return () => { changeListeners = changeListeners.filter(l => l !== listener) }
}

export function onStats(listener: StatsListener) {
  statsListeners.push(listener)
  return () => { statsListeners = statsListeners.filter(l => l !== listener) }
}

export function isConnected(): boolean {
  return connected
}

export interface Pm2Health {
  connected: boolean
  degraded: boolean
  reconnecting: boolean
  consecutivePollFailures: number
  lastSuccessfulPollAt: string | null
}

export function getHealth(): Pm2Health {
  return {
    connected,
    degraded,
    reconnecting,
    consecutivePollFailures,
    lastSuccessfulPollAt,
  }
}
