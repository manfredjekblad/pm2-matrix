/**
 * Generic JSON file persistence helper.
 *
 * Provides read/write wrappers with consistent error handling so that
 * layoutStore and filterStore share the same I/O logic instead of
 * duplicating it.
 */
import fs from 'fs'
import path from 'path'

/**
 * Read a JSON file and parse it.  Returns `defaultValue` on any error
 * (file missing, corrupt JSON, unexpected shape).
 */
export function readJson<T>(filePath: string, defaultValue: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}

/**
 * Write `data` as pretty JSON to `filePath` using a write-to-temp-then-rename
 * pattern so that the target file is never left in a partially written state
 * if the process is killed mid-write.  Parent directories are created if they
 * do not exist.
 *
 * Note: fs.renameSync is atomic on POSIX when src and dst are on the same
 * filesystem.  On Windows it is not truly atomic but is still far safer than
 * a direct overwrite because the original file is only replaced once the temp
 * file is fully written.
 */
export function writeJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp'
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    console.error(`[fileStore] Failed to write ${filePath}:`, err)
    // Clean up the temp file if it was created before the failure.
    try { fs.unlinkSync(tmpPath) } catch { /* already absent */ }
    // Re-throw so callers (HTTP route handlers) can return a 500 rather than
    // silently serving stale data after a disk-full or permission error.
    throw err
  }
}
