/**
 * Port discovery via /proc/net/tcp (Linux only).
 *
 * Primary strategy (precise):
 *   1. Parse /proc/net/tcp + /proc/net/tcp6 → Map<inode, { port, uid }>
 *      for every LISTEN socket.
 *   2. For each PID, read /proc/<pid>/fd symlinks to find socket inodes
 *      owned by that exact process, then cross-reference with the inode map.
 *
 * Fallback strategy (when /proc/<pid>/fd is not accessible — EACCES):
 *   3. Read the process UID from /proc/<pid>/status.
 *   4. Return all LISTEN ports whose socket UID matches the process UID.
 *   This is less precise (all ports owned by that user, not just that process)
 *   but works when PM2-Matrix and the PM2 apps run as the same OS user and
 *   /proc/<pid>/fd permissions are restricted.
 *
 * All individual fs errors are caught so the module fails silently on
 * non-Linux hosts or when a process exits mid-scan.
 */

import fs from 'fs/promises'
import path from 'path'

// TCP_LISTEN state value in /proc/net/tcp
const LISTEN_STATE = '0A'

// Maximum number of concurrent /proc/fd readlink syscalls.  Without a cap, a
// service with thousands of open FDs could spawn thousands of simultaneous
// async calls per /api/ports request, stressing the OS and event loop.
const MAX_CONCURRENT_FD_READS = 64

/**
 * Simple counting semaphore for capping concurrent async operations.
 * Usage: `const release = await semaphore.acquire(); try { ... } finally { release() }`
 */
function createSemaphore(max: number) {
  let running = 0
  const queue: Array<() => void> = []
  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        const tryRun = () => {
          if (running < max) {
            running++
            resolve(() => {
              running--
              if (queue.length > 0) queue.shift()!()
            })
          } else {
            queue.push(tryRun)
          }
        }
        tryRun()
      })
    },
  }
}

interface SocketEntry {
  port: number
  uid: number
}

/**
 * Parse /proc/net/tcp or /proc/net/tcp6 and return a map of
 * socket inode → { port, uid } for all LISTEN-state rows.
 * Returns an empty map (not an error) when the file does not exist.
 */
async function parseNetTcp(filePath: string): Promise<Map<number, SocketEntry>> {
  const inodeMap = new Map<number, SocketEntry>()
  try {
    const text = await fs.readFile(filePath, 'utf8')
    // First line is the header — skip it.
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      // Data rows have at least 10 whitespace-separated tokens:
      // [0]=sl [1]=local_addr [2]=rem_addr [3]=st [4]=tx:rx_queue
      // [5]=timer [6]=rexmits [7]=uid [8]=timeout [9]=inode
      if (cols.length < 10) continue
      if (cols[3] !== LISTEN_STATE) continue

      const portHex = cols[1].split(':')[1]
      const port = parseInt(portHex, 16)
      const uid = parseInt(cols[7], 10)
      const inode = parseInt(cols[9], 10)

      if (!isNaN(port) && port > 0 && !isNaN(inode) && inode > 0 && !isNaN(uid)) {
        inodeMap.set(inode, { port, uid })
      }
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT = non-Linux host (file simply doesn't exist).
    // EACCES = unusual permission restriction on /proc — both are silent.
    // Any other error is unexpected and worth logging.
    if (code !== 'ENOENT' && code !== 'EACCES') {
      console.warn(`[portService] Failed to parse ${filePath}:`, err)
    }
  }
  return inodeMap
}

// Per-call semaphore shared across all PIDs in a single getPortsForPids
// invocation — created lazily per call so concurrent API requests don't
// share a semaphore (they should be independent).
// Defined at module scope so the constant overhead of construction is paid once.
const fdSemaphore = createSemaphore(MAX_CONCURRENT_FD_READS)

/**
 * Return the set of socket inodes owned by a PID via /proc/<pid>/fd symlinks,
 * and a flag indicating whether the fd directory was accessible at all.
 *
 * Concurrency is capped at MAX_CONCURRENT_FD_READS to prevent a service with
 * thousands of open file descriptors from spawning thousands of simultaneous
 * readlink syscalls per request.
 */
async function getSocketInodesForPid(
  pid: number
): Promise<{ inodes: Set<number>; fdAccessible: boolean }> {
  const inodes = new Set<number>()
  const fdDir = `/proc/${pid}/fd`
  try {
    const entries = await fs.readdir(fdDir)
    // Read symlinks with a concurrency cap to avoid overwhelming the OS.
    await Promise.all(
      entries.map(async (fd) => {
        const release = await fdSemaphore.acquire()
        try {
          const target = await fs.readlink(path.join(fdDir, fd))
          const m = target.match(/^socket:\[(\d+)\]$/)
          if (m) inodes.add(parseInt(m[1], 10))
        } catch {
          // fd closed between readdir and readlink — safe to ignore.
        } finally {
          release()
        }
      })
    )
    return { inodes, fdAccessible: true }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'ENOENT' && code !== 'ESRCH') {
      console.warn(`[portService] Unexpected error reading ${fdDir}:`, err)
    }
    return { inodes, fdAccessible: false }
  }
}

/**
 * Read the effective UID of a process from /proc/<pid>/status.
 * Returns null if the file cannot be read.
 *
 * The Uid line has four fields: real, effective, saved, filesystem.
 * We capture the *effective* UID (second field) which is the one the OS uses
 * to determine socket ownership — important for setuid processes where the
 * real UID differs from the effective UID.
 */
async function getUidForPid(pid: number): Promise<number | null> {
  try {
    const text = await fs.readFile(`/proc/${pid}/status`, 'utf8')
    // "Uid:\t<real>\t<effective>\t<saved>\t<filesystem>"
    const m = text.match(/^Uid:\s+\d+\s+(\d+)/m)
    return m ? parseInt(m[1], 10) : null
  } catch {
    return null
  }
}

export interface PortsResult {
  ports: number[]
  /**
   * True when at least one PID fell back to UID-based socket matching because
   * /proc/<pid>/fd was not accessible.  In that mode, all ports owned by the
   * same OS user are attributed to this service rather than only that process's
   * sockets — so the list may include ports from other co-user processes.
   */
  fallbackUsed: boolean
}

/**
 * Returns a deduplicated, sorted list of TCP ports that the given PIDs are
 * actively listening on, plus a flag indicating whether the UID fallback path
 * was used (less precise — may attribute other co-user services' ports).
 *
 * Returns empty results on non-Linux systems or when no listening ports are
 * found.
 *
 * Uses inode-based matching (precise) when /proc/<pid>/fd is readable,
 * falls back to UID-based matching (all ports owned by that user) otherwise.
 */
export async function getPortsForPids(pids: number[]): Promise<PortsResult> {
  if (pids.length === 0) return { ports: [], fallbackUsed: false }

  // Read IPv4 and IPv6 tables in parallel.
  const [tcp4, tcp6] = await Promise.all([
    parseNetTcp('/proc/net/tcp'),
    parseNetTcp('/proc/net/tcp6'),
  ])

  // Merge both tables; tcp6 entries win on inode collision (shouldn't happen).
  const allSockets = new Map<number, SocketEntry>([...tcp4, ...tcp6])

  if (allSockets.size === 0) {
    // Both files were empty or absent — either non-Linux or no listening sockets.
    return { ports: [], fallbackUsed: false }
  }

  const portSet = new Set<number>()
  let fallbackUsed = false

  await Promise.all(
    pids.map(async (pid) => {
      const { inodes, fdAccessible } = await getSocketInodesForPid(pid)

      if (fdAccessible) {
        // Precise: match by socket inode.
        for (const inode of inodes) {
          const entry = allSockets.get(inode)
          if (entry) portSet.add(entry.port)
        }
      } else {
        // Fallback: match by UID.  Less precise but works when fd permissions
        // prevent inode discovery (same-user PM2 setups on some Linux configs).
        // NOTE: this attributes ALL ports owned by the UID to this PID's service,
        // so co-user processes' ports may bleed through.
        console.warn(
          `[portService] /proc/${pid}/fd not accessible — falling back to UID-based port matching`
        )
        fallbackUsed = true
        const uid = await getUidForPid(pid)
        if (uid !== null) {
          for (const entry of allSockets.values()) {
            if (entry.uid === uid) portSet.add(entry.port)
          }
        } else {
          console.warn(`[portService] Could not read UID for PID ${pid} — port discovery skipped for this process`)
        }
      }
    })
  )

  return { ports: [...portSet].sort((a, b) => a - b), fallbackUsed }
}
