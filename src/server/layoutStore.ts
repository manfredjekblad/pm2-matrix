import path from 'path'
import { LayoutData } from './types'
import { readJson, writeJson } from './fileStore'

const LAYOUT_PATH = path.join(process.cwd(), 'data', 'layout.json')

/**
 * In-memory cache.  Populated lazily on first read so that disk I/O is paid
 * once per process rather than once per HTTP request.
 */
let cache: LayoutData | null = null

function ensureCache(): LayoutData {
  if (!cache) {
    const raw = readJson<unknown>(LAYOUT_PATH, { order: [] })
    const layout = raw as LayoutData
    cache = Array.isArray(layout?.order) ? layout : { order: [] }
  }
  return cache
}

export function getLayout(): LayoutData {
  return { order: [...ensureCache().order] }
}

export function saveLayout(order: string[]): void {
  const layout: LayoutData = { order }
  cache = layout
  writeJson(LAYOUT_PATH, layout)
}

/**
 * Merge discovered PM2 service names into the stored layout.
 * New services are appended; existing entries are preserved.
 * Uses a Set for O(1) lookups rather than repeated array.includes().
 */
export function mergeServices(serviceNames: string[]): LayoutData {
  const layout = ensureCache()
  const existing = new Set(layout.order)

  let changed = false
  for (const name of serviceNames) {
    if (!existing.has(name)) {
      layout.order.push(name)
      existing.add(name)
      changed = true
    }
  }

  if (changed) writeJson(LAYOUT_PATH, layout)
  return { order: [...layout.order] }
}

/**
 * Remove layout entries for service names that no longer exist in PM2.
 * Mirrors the equivalent function in filterStore — prevents the layout file
 * from accumulating stale names indefinitely as services are added/removed.
 */
export function pruneUnknown(knownNames: string[]): void {
  const layout = ensureCache()
  const known = new Set(knownNames)
  const before = layout.order.length
  layout.order = layout.order.filter(name => known.has(name))
  if (layout.order.length !== before) {
    writeJson(LAYOUT_PATH, layout)
  }
}
