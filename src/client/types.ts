/**
 * Client-side type barrel.
 *
 * Re-exports all shared types from AppContext so that components have a single
 * stable import point.  Adding new client types here keeps them co-located and
 * avoids the temptation to duplicate them inline in individual component files.
 */
export type { LogFilter, LogEntry, Service, ServerStats } from './context/AppContext'
