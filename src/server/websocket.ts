import { IncomingMessage, Server } from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import os from 'os'
import { sessionMiddleware, isSessionAuthenticated } from './auth'
import * as pm2Service from './pm2Service'
import { WsMessage, WsServerStatsMessage } from './types'
import { Request, Response } from 'express'

let wss: WebSocketServer | null = null

// CPU count is constant for the lifetime of the process; cache it once to
// avoid a /proc/cpuinfo read on every stats broadcast.
const CPU_COUNT = os.cpus().length

/**
 * Reads current OS-level resource stats.  Load averages are set to null on
 * Windows because os.loadavg() always returns [0, 0, 0] there and a null
 * value lets the frontend hide the load display cleanly.
 */
function getServerStats(): WsServerStatsMessage {
  const [l1, l5, l15] = os.loadavg()
  const isWindows = os.platform() === 'win32'
  const totalMem = os.totalmem()
  const totalMemMB = Math.round(totalMem / 1024 / 1024)
  const usedMemMB = Math.round((totalMem - os.freemem()) / 1024 / 1024)
  return {
    type: 'server_stats',
    loadAvg1: isWindows ? null : Math.round(l1 * 100) / 100,
    loadAvg5: isWindows ? null : Math.round(l5 * 100) / 100,
    loadAvg15: isWindows ? null : Math.round(l15 * 100) / 100,
    totalMemMB,
    usedMemMB,
    cpuCount: CPU_COUNT,
    serverUptimeSec: Math.floor(os.uptime()),
  }
}

function broadcast(msg: WsMessage) {
  if (!wss) return
  const data = JSON.stringify(msg)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

export function setupWebSocket(server: Server) {
  wss = new WebSocketServer({ noServer: true })

  // Authenticate upgrade request via session
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (!req.url?.startsWith('/ws')) {
      socket.destroy()
      return
    }

    // express-session requires a Response-like object even for upgrade
    // requests where no real HTTP response is sent.  The session middleware
    // only calls getHeader/setHeader/end and — depending on the store — may
    // also call EventEmitter methods (on, once, emit, removeListener).
    // All are stubbed here to prevent TypeErrors if session-file-store calls
    // any of them in an edge case (e.g. after a write error).
    const mockReq = req as unknown as Request
    const noop = () => {}
    const mockRes = {
      getHeader: () => undefined,
      setHeader: noop,
      end: noop,
      on: noop,
      once: noop,
      emit: noop,
      removeListener: noop,
      // Some session store implementations (including session-file-store) guard
      // writes by checking these flags before calling setHeader/end.  Without
      // them, an edge-case store write attempt throws a TypeError that would
      // silently drop the WebSocket upgrade.
      headersSent: false,
      writableEnded: false,
    } as unknown as Response

    try {
      sessionMiddleware(mockReq, mockRes, () => {
        if (!isSessionAuthenticated(mockReq)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }

        wss!.handleUpgrade(req, socket, head, (ws) => {
          wss!.emit('connection', ws, req)
        })
      })
    } catch (err) {
      console.error('[websocket] Session middleware error during upgrade:', err)
      socket.destroy()
    }
  })

  wss.on('connection', (ws: WebSocket) => {
    // Send current PM2 stats and server OS stats immediately on connect so
    // the topbar populates before the first poll interval fires.
    const initStats: WsMessage = { type: 'stats', services: pm2Service.getServiceStats() }
    ws.send(JSON.stringify(initStats))
    ws.send(JSON.stringify(getServerStats()))

    ws.on('error', (err) => {
      console.error('[websocket] Client error:', err)
    })
  })

  // Subscribe to PM2 events and broadcast both service stats and server stats
  // together so the topbar numbers update at the same cadence as the cards.
  pm2Service.onStats((services) => {
    broadcast({ type: 'stats', services })
    broadcast(getServerStats())
  })

  pm2Service.onLog((id, app, level, message, timestamp) => {
    broadcast({ type: 'log', id, app, level, message, timestamp })
  })

  pm2Service.onServiceChange((type, name) => {
    broadcast({ type, name } as WsMessage)
  })

  console.log('[websocket] WebSocket server ready')
}
