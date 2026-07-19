import path from 'path'
import { LogFilter } from './types'
import { readJson, writeJson } from './fileStore'

const FILTERS_PATH = path.join(process.cwd(), 'data', 'card-filters.json')

const VALID_FILTERS = new Set<LogFilter>(['all', 'stdout', 'stderr'])

/**
 * In-memory cache.  Populated lazily on first read so that disk I/O is paid
 * once per process rather than once per HTTP request.
 *
 * Deliberate trade-off: external edits to the JSON file on disk are ignored
 * for the lifetime of the process.  Restart the server to pick up manual
 * changes.
 */
let cache: Record<string, LogFilter> | null = null

function load(): Record<string, LogFilter> {
  const raw = readJson<Record<string, unknown>>(FILTERS_PATH, {})
  const valid: Record<string, LogFilter> = {}
  for (const [name, val] of Object.entries(raw)) {
    if (VALID_FILTERS.has(val as LogFilter)) {
      valid[name] = val as LogFilter
    }
  }
  return valid
}

function ensureCache(): Record<string, LogFilter> {
  if (!cache) cache = load()
  return cache
}

export function getFilters(): Record<string, LogFilter> {
  return { ...ensureCache() }
}

export function setFilter(name: string, filter: LogFilter): void {
  const filters = ensureCache()
  filters[name] = filter
  writeJson(FILTERS_PATH, filters)
}

/**
 * Remove entries for service names that no longer exist in PM2.
 * Called periodically (on each filter save) to prevent indefinite growth of
 * the persisted file as services are added and removed over time.
 */
export function pruneUnknown(knownNames: string[]): void {
  const filters = ensureCache()
  const known = new Set(knownNames)
  let changed = false
  for (const name of Object.keys(filters)) {
    if (!known.has(name)) {
      delete filters[name]
      changed = true
    }
  }
  if (changed) writeJson(FILTERS_PATH, filters)
}
