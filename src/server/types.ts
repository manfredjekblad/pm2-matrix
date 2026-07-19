/**
 * Shared type definitions for the PM2-Matrix server.
 *
 * Type duplication note:
 * The client re-declares LogFilter, LogEntry, and the Service shape in
 * src/client/context/AppContext.tsx because the server's ServiceState carries
 * additional fields (pids, logs) that should not be sent to the browser, and
 * Vite cannot import from src/server at build time.  If these types diverge,
 * the WebSocket message guards in AppContext.tsx will catch the mismatch at
 * runtime.  Consider a src/shared/ package with a path alias if this project
 * grows to require strict compile-time cross-boundary type checking.
 */

/** The log filter applied to a service card: show all, stdout-only, or stderr-only. */
export type LogFilter = 'all' | 'stdout' | 'stderr'

export interface LogEntry {
  /** Monotonically increasing counter assigned by pm2Service; used as a stable React key. */
  id: number
  timestamp: string
  level: 'stdout' | 'stderr'
  message: string
}

export interface ServiceState {
  name: string
  status: 'online' | 'stopped' | 'errored' | 'launching' | 'unknown'
  cpu: number
  memoryMB: number
  uptimeSec: number
  logs: LogEntry[]
  /** PIDs of all running workers (>1 in cluster mode). Empty when stopped. */
  pids: number[]
}

export interface ServiceStats {
  name: string
  status: ServiceState['status']
  cpu: number
  memoryMB: number
  uptimeSec: number
}

export interface WsStatsMessage {
  type: 'stats'
  services: ServiceStats[]
}

export interface WsLogMessage {
  type: 'log'
  id: number
  app: string
  level: 'stdout' | 'stderr'
  message: string
  timestamp: string
}

export interface WsServiceAddedMessage {
  type: 'service_added'
  name: string
}

export interface WsServiceRemovedMessage {
  type: 'service_removed'
  name: string
}

export interface WsServerStatsMessage {
  type: 'server_stats'
  /** null on Windows where os.loadavg() always returns [0,0,0] */
  loadAvg1: number | null
  loadAvg5: number | null
  loadAvg15: number | null
  totalMemMB: number
  usedMemMB: number
  cpuCount: number
  serverUptimeSec: number
}

export type WsMessage =
  | WsStatsMessage
  | WsLogMessage
  | WsServiceAddedMessage
  | WsServiceRemovedMessage
  | WsServerStatsMessage

export interface LayoutData {
  order: string[]
}

export interface ArchiveData {
  [serviceName: string]: boolean
}

declare module 'express-session' {
  interface SessionData {
    authenticated: boolean
    username: string
  }
}
