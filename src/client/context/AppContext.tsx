import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
} from 'react'

export type LogFilter = 'all' | 'stdout' | 'stderr'

export interface ServerStats {
  loadAvg1: number | null
  loadAvg5: number | null
  loadAvg15: number | null
  totalMemMB: number
  usedMemMB: number
  cpuCount: number
  serverUptimeSec: number
}

export interface Pm2Health {
  connected: boolean
  degraded: boolean
  reconnecting: boolean
  consecutivePollFailures: number
  lastSuccessfulPollAt: string | null
}

export interface LogEntry {
  /** Monotonically increasing ID assigned by the server; used as a stable React key. */
  id: number
  timestamp: string
  level: 'stdout' | 'stderr'
  message: string
}

export interface Service {
  name: string
  status: 'online' | 'stopped' | 'errored' | 'launching' | 'unknown'
  cpu: number
  memoryMB: number
  uptimeSec: number
  logs: LogEntry[]
}

interface AppState {
  authenticated: boolean
  connected: boolean
  services: Record<string, Service>
  order: string[]
  cardFilters: Record<string, LogFilter>
  archivedMap: Record<string, boolean>
  serverStats: ServerStats | null
  pm2Health: Pm2Health | null
}

interface AppContextValue extends AppState {
  checkAuth: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Directly update the in-memory card order; use saveLayout to persist. */
  setOrder: (order: string[]) => void
  saveLayout: (order: string[]) => Promise<void>
  setCardFilter: (name: string, filter: LogFilter) => void
  setArchived: (name: string, archived: boolean) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

const MAX_LOGS = 1000
const WS_RETRY_MS = 2000
const FILTER_DEBOUNCE_MS = 300
const ARCHIVE_DEBOUNCE_MS = 300

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [connected, setConnected] = useState(false)
  const [services, setServices] = useState<Record<string, Service>>({})
  const [order, setOrderState] = useState<string[]>([])
  const [cardFilters, setCardFiltersState] = useState<Record<string, LogFilter>>({})
  const [archivedMap, setArchivedMapState] = useState<Record<string, boolean>>({})
  const [serverStats, setServerStats] = useState<ServerStats | null>(null)
  const [pm2Health, setPm2Health] = useState<Pm2Health | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filterSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const archiveSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const mountedRef = useRef(true)
  // Stable ref for connectWs so checkAuth can call it without being a reactive
  // dependency, breaking the circular useCallback chain.
  const connectWsRef = useRef<() => void>(() => {})
  // AbortController for the in-flight checkAuth fetch group — aborted on logout
  // to prevent post-logout state updates if the user logs out while auth is
  // still resolving (fast network race condition).
  const checkAuthAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      // Clear any pending filter-save debounce timers to prevent fetch calls
      // after the component tree unmounts.
      for (const id of Object.values(filterSaveTimers.current)) clearTimeout(id)
      for (const id of Object.values(archiveSaveTimers.current)) clearTimeout(id)
      wsRef.current?.close()
    }
  }, [])

  /**
   * Dispatch a single parsed WebSocket message to the appropriate state
   * updater.  Each branch includes a minimal type guard so malformed messages
   * from an unexpected source cannot silently corrupt client state.
   */
  const handleWsMessage = useCallback((msg: Record<string, unknown>) => {
    if (msg.type === 'stats') {
      if (!Array.isArray(msg.services)) return
      setServices(prev => {
        const next = { ...prev }
        for (const s of msg.services as Service[]) {
          if (typeof s?.name !== 'string') continue
          if (next[s.name]) {
            next[s.name] = { ...next[s.name], ...s }
          } else {
            next[s.name] = { ...s, logs: [] }
          }
        }
        return next
      })
    }

    if (msg.type === 'log') {
      if (
        typeof msg.id !== 'number' ||
        typeof msg.app !== 'string' ||
        typeof msg.timestamp !== 'string' ||
        (msg.level !== 'stdout' && msg.level !== 'stderr') ||
        typeof msg.message !== 'string'
      ) return
      const entry: LogEntry = {
        id: msg.id,
        timestamp: msg.timestamp,
        level: msg.level,
        message: msg.message,
      }
      setServices(prev => {
        const svc = prev[msg.app as string]
        if (!svc) return prev
        const logs = [...svc.logs, entry].slice(-MAX_LOGS)
        return { ...prev, [msg.app as string]: { ...svc, logs } }
      })
    }

    if (msg.type === 'service_added') {
      if (typeof msg.name !== 'string') return
      setOrderState(prev =>
        prev.includes(msg.name as string) ? prev : [...prev, msg.name as string]
      )
      setServices(prev => {
        if (prev[msg.name as string]) return prev
        return {
          ...prev,
          [msg.name as string]: {
            name: msg.name as string,
            status: 'unknown',
            cpu: 0,
            memoryMB: 0,
            uptimeSec: 0,
            logs: [],
          },
        }
      })
    }

    if (msg.type === 'service_removed') {
      if (typeof msg.name !== 'string') return
      setServices(prev => {
        const svc = prev[msg.name as string]
        if (!svc) return prev
        return { ...prev, [msg.name as string]: { ...svc, status: 'stopped', logs: [] } }
      })
    }

    if (msg.type === 'server_stats') {
      if (
        typeof msg.totalMemMB !== 'number' ||
        typeof msg.usedMemMB !== 'number' ||
        typeof msg.cpuCount !== 'number' ||
        typeof msg.serverUptimeSec !== 'number'
      ) return
      setServerStats({
        loadAvg1: typeof msg.loadAvg1 === 'number' ? msg.loadAvg1 : null,
        loadAvg5: typeof msg.loadAvg5 === 'number' ? msg.loadAvg5 : null,
        loadAvg15: typeof msg.loadAvg15 === 'number' ? msg.loadAvg15 : null,
        totalMemMB: msg.totalMemMB,
        usedMemMB: msg.usedMemMB,
        cpuCount: msg.cpuCount,
        serverUptimeSec: msg.serverUptimeSec,
      })
    }
  }, [])

  const refreshPm2Health = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch('/api/health', { signal })
    if (!res.ok) throw new Error(`/api/health returned ${res.status}`)
    const data = await res.json() as { pm2?: Pm2Health }
    if (data.pm2) setPm2Health(data.pm2)
  }, [])

  const connectWs = useCallback(() => {
    if (!mountedRef.current) return
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      setConnected(true)
      refreshPm2Health().catch(() => {})
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      setConnected(false)
      retryTimerRef.current = setTimeout(() => {
        // Call via ref to avoid capturing a stale closure of connectWs.
        if (mountedRef.current) connectWsRef.current()
      }, WS_RETRY_MS)
    }

    ws.onerror = () => {
      ws.close()
    }

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return
      try {
        handleWsMessage(JSON.parse(event.data as string))
      } catch {
        // ignore malformed message
      }
    }
  }, [handleWsMessage, refreshPm2Health])

  // Keep the ref in sync with the latest stable callback so onclose can always
  // reach the current version without a circular useCallback dependency.
  connectWsRef.current = connectWs

  // checkAuth calls connectWs via the ref rather than as a direct dependency to
  // avoid a circular useCallback chain (connectWs → checkAuth → connectWs).
  const checkAuth = useCallback(async () => {
    // Cancel any previous in-flight checkAuth (e.g. rapid tab focus events).
    checkAuthAbortRef.current?.abort()
    const controller = new AbortController()
    checkAuthAbortRef.current = controller
    const { signal } = controller

    try {
      const res = await fetch('/api/me', { signal })
      if (!res.ok) throw new Error(`/api/me returned ${res.status}`)
      const data = await res.json() as { authenticated: boolean }

      if (data.authenticated) {
        setAuthenticated(true)
        const [layoutRes, svcRes, filtersRes, archiveRes, healthRes] = await Promise.all([
          fetch('/api/layout', { signal }),
          fetch('/api/services', { signal }),
          fetch('/api/card-filters', { signal }),
          fetch('/api/card-archive', { signal }),
          fetch('/api/health', { signal }),
        ])
        if (!layoutRes.ok) throw new Error(`/api/layout returned ${layoutRes.status}`)
        if (!svcRes.ok) throw new Error(`/api/services returned ${svcRes.status}`)
        if (!filtersRes.ok) throw new Error(`/api/card-filters returned ${filtersRes.status}`)
        if (!archiveRes.ok) throw new Error(`/api/card-archive returned ${archiveRes.status}`)
        if (!healthRes.ok) throw new Error(`/api/health returned ${healthRes.status}`)

        const layout = await layoutRes.json() as { order: string[] }
        const svcData = await svcRes.json() as { services: Service[]; order: string[] }
        const filters = await filtersRes.json() as Record<string, LogFilter>
        const archive = await archiveRes.json() as Record<string, boolean>
        const health = await healthRes.json() as { pm2?: Pm2Health }

        const svcMap: Record<string, Service> = {}
        for (const s of svcData.services) {
          svcMap[s.name] = { ...s, logs: [] }
        }

        const storedOrder: string[] = layout.order ?? []
        const allNames = Object.keys(svcMap)
        const merged = [
          ...storedOrder,
          ...allNames.filter(n => !storedOrder.includes(n)),
        ]

        setServices(svcMap)
        setOrderState(merged)
        setCardFiltersState(filters)
        setArchivedMapState(archive)
        setPm2Health(health.pm2 ?? null)
        connectWsRef.current()
      }
    } catch (err) {
      // Ignore abort errors (triggered by logout or a fresh checkAuth call).
      if (err instanceof Error && err.name === 'AbortError') return
      throw err
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const data = await res.json() as { error: string }
      throw new Error(data.error ?? 'Login failed')
    }
    await checkAuth()
  }, [checkAuth])

  const logout = useCallback(async () => {
    // Abort any in-flight checkAuth fetches so their continuations cannot
    // set authenticated=true or populate state after we've cleared everything.
    checkAuthAbortRef.current?.abort()
    checkAuthAbortRef.current = null

    await fetch('/api/logout', { method: 'POST' })
    // Cancel any in-flight debounced filter saves before tearing down.
    for (const id of Object.values(filterSaveTimers.current)) clearTimeout(id)
    for (const id of Object.values(archiveSaveTimers.current)) clearTimeout(id)
    filterSaveTimers.current = {}
    archiveSaveTimers.current = {}
    wsRef.current?.close()
    wsRef.current = null
    setAuthenticated(false)
    setConnected(false)
    setServices({})
    setOrderState([])
    setCardFiltersState({})
    setArchivedMapState({})
    setServerStats(null)
    setPm2Health(null)
  }, [])

  // setOrderState is exposed directly as setOrder — the wrapper added no logic.
  const setOrder = setOrderState

  const saveLayout = useCallback(async (newOrder: string[]) => {
    const res = await fetch('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: newOrder }),
    })
    if (!res.ok) {
      console.error('[AppContext] saveLayout failed:', res.status)
      throw new Error(`Failed to save layout: ${res.status}`)
    }
  }, [])

  const setCardFilter = useCallback((name: string, filter: LogFilter) => {
    setCardFiltersState(prev => ({ ...prev, [name]: filter }))

    // Debounce the server save to avoid a request on every filter button click.
    if (filterSaveTimers.current[name]) clearTimeout(filterSaveTimers.current[name])
    filterSaveTimers.current[name] = setTimeout(() => {
      fetch('/api/card-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, filter }),
      }).catch(console.error)
    }, FILTER_DEBOUNCE_MS)
  }, [])

  const setArchived = useCallback((name: string, archived: boolean) => {
    setArchivedMapState(prev => ({ ...prev, [name]: archived }))
    if (archiveSaveTimers.current[name]) clearTimeout(archiveSaveTimers.current[name])
    archiveSaveTimers.current[name] = setTimeout(() => {
      fetch('/api/card-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, archived }),
      }).catch(console.error)
    }, ARCHIVE_DEBOUNCE_MS)
  }, [])

  return (
    <AppContext.Provider
      value={{
        authenticated,
        connected,
        services,
        order,
        cardFilters,
        archivedMap,
        serverStats,
        pm2Health,
        checkAuth,
        login,
        logout,
        setOrder,
        saveLayout,
        setCardFilter,
        setArchived,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}
