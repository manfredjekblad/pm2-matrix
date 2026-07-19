import path from 'path'
import { readJson, writeJson } from './fileStore'

const ARCHIVE_PATH = path.join(process.cwd(), 'data', 'card-archive.json')

let cache: Record<string, boolean> | null = null

function load(): Record<string, boolean> {
  const raw = readJson<Record<string, unknown>>(ARCHIVE_PATH, {})
  const valid: Record<string, boolean> = {}
  for (const [name, val] of Object.entries(raw)) {
    if (typeof val === 'boolean') valid[name] = val
  }
  return valid
}

function ensureCache(): Record<string, boolean> {
  if (!cache) cache = load()
  return cache
}

export function getArchivedMap(): Record<string, boolean> {
  return { ...ensureCache() }
}

export function setArchived(name: string, archived: boolean): void {
  const archive = ensureCache()
  archive[name] = archived
  writeJson(ARCHIVE_PATH, archive)
}

export function pruneUnknown(knownNames: string[]): void {
  const archive = ensureCache()
  const known = new Set(knownNames)
  let changed = false
  for (const name of Object.keys(archive)) {
    if (!known.has(name)) {
      delete archive[name]
      changed = true
    }
  }
  if (changed) writeJson(ARCHIVE_PATH, archive)
}
