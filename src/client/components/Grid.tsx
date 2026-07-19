import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { useApp } from '../context/AppContext'
import ServiceCard, { ServiceAction } from './ServiceCard'
import PortsModal from './PortsModal'
import { IconArchive, IconColumns, IconClock, IconHeight, IconPlug } from './icons'
import { formatMem, formatUptime } from '../utils'

const DEBOUNCE_MS = 500
const POLL_OPTIONS = [1, 2, 3, 5, 10, 15, 30, 60]
const HEIGHT_OPTIONS: { label: string; value: number }[] = [
  { label: 'S', value: 200 },
  { label: 'M', value: 308 },
  { label: 'L', value: 450 },
  { label: 'XL', value: 600 },
]

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) return JSON.parse(raw) as T
  } catch {}
  return fallback
}

export default function Grid() {
  const { services, order, setOrder, saveLayout, logout, connected, serverStats, pm2Health, archivedMap } = useApp()
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [columns, setColumns] = useState<number>(() => loadFromStorage('pm2m-columns', 3))
  const [pollInterval, setPollInterval] = useState<number>(() => loadFromStorage('pm2m-poll', 3))
  const [cardHeight, setCardHeight] = useState<number>(() => loadFromStorage('pm2m-card-height', 308))
  const [showArchived, setShowArchived] = useState<boolean>(() => loadFromStorage('pm2m-show-archived', false))
  const [showPortsModal, setShowPortsModal] = useState(false)
  const [portsMap, setPortsMap] = useState<Record<string, number[]>>({})

  // Cancel any pending layout-save debounce timer on unmount so we don't fire
  // a fetch to /api/layout after logout or when the component tree tears down.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  )

  // Service summary counts and aggregate resource totals — recomputed only when services change.
  const summary = useMemo(() => {
    const all = Object.values(services)
    const online = all.filter(s => s.status === 'online' || s.status === 'launching').length
    const errored = all.filter(s => s.status === 'errored').length
    const stopped = all.filter(s => s.status === 'stopped').length
    const totalCpu = all.reduce((acc, s) => acc + s.cpu, 0)
    const totalMemMB = all.reduce((acc, s) => acc + s.memoryMB, 0)
    return { total: all.length, online, errored, stopped, totalCpu, totalMemMB }
  }, [services])

  // Re-sync the stored poll interval whenever the WebSocket reconnects so the
  // server picks up the user's preference after a reload or reconnect.
  // pollInterval is intentionally excluded from deps: changes are sent immediately via
  // handlePollChange and we don't want a duplicate request on every keystroke.
  useEffect(() => {
    if (!connected) return
    fetch('/api/settings/poll-interval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: pollInterval }),
    }).catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  const handleColumnsChange = useCallback((n: number) => {
    setColumns(n)
    localStorage.setItem('pm2m-columns', JSON.stringify(n))
  }, [])

  const handlePollChange = useCallback((s: number) => {
    setPollInterval(s)
    localStorage.setItem('pm2m-poll', JSON.stringify(s))
    fetch('/api/settings/poll-interval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: s }),
    }).catch(console.error)
  }, [])

  const handleCardHeightChange = useCallback((h: number) => {
    setCardHeight(h)
    localStorage.setItem('pm2m-card-height', JSON.stringify(h))
  }, [])

  const handleShowArchivedChange = useCallback((show: boolean) => {
    setShowArchived(show)
    localStorage.setItem('pm2m-show-archived', JSON.stringify(show))
  }, [])

  // Wrapped in useCallback so the PortsModal onClose keydown effect doesn't
  // re-register on every Grid render (every stats WebSocket tick).
  const handleClosePortsModal = useCallback(() => setShowPortsModal(false), [])

  // openPortsModal: no longer fetches directly — PortsModal owns the single
  // fetch and calls onPortsLoaded to push the data back up to Grid state.
  const openPortsModal = useCallback(() => {
    setShowPortsModal(true)
  }, [])

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = order.indexOf(active.id as string)
    const newIndex = order.indexOf(over.id as string)
    const newOrder = arrayMove(order, oldIndex, newIndex)
    setOrder(newOrder)

    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveLayout(newOrder).catch(console.error)
    }, DEBOUNCE_MS)
  }

  const handleAction = useCallback(
    async (action: ServiceAction, name: string) => {
      const res = await fetch(`/api/service/${encodeURIComponent(name)}/${action}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? `Failed to ${action} ${name}`)
      }
    },
    []
  )

  // Memoized: Grid re-renders on every stats WebSocket tick; recomputing the
  // display order on every render is wasteful since order/services rarely change.
  const displayOrder = useMemo(() => [
    ...order,
    ...Object.keys(services).filter(n => !order.includes(n)),
  ], [order, services])

  const visibleOrder = useMemo(
    () => showArchived ? displayOrder : displayOrder.filter(name => !archivedMap[name]),
    [displayOrder, showArchived, archivedMap]
  )

  const summaryClass = summary.errored > 0
    ? 'service-summary service-summary--error'
    : summary.stopped > 0
      ? 'service-summary service-summary--stopped'
      : 'service-summary service-summary--ok'

  return (
    <div className="dashboard">
      <header className="topbar">
        <div className="topbar-logo">
          <svg width="24" height="24" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="2" width="14" height="14" rx="2" fill="#2ecc71" />
            <rect x="20" y="2" width="14" height="14" rx="2" fill="#2ecc71" fillOpacity="0.5" />
            <rect x="2" y="20" width="14" height="14" rx="2" fill="#2ecc71" fillOpacity="0.5" />
            <rect x="20" y="20" width="14" height="14" rx="2" fill="#2ecc71" fillOpacity="0.3" />
          </svg>
          <span>PM2 Matrix</span>
        </div>

        <div className="topbar-right">
          {/* Service status summary */}
          {summary.total > 0 && (
            <div className={summaryClass} title={`${summary.online} online · ${summary.errored} errored · ${summary.stopped} stopped`}>
              <span className="summary-dot" />
              {summary.online}/{summary.total}
              {summary.errored > 0 && <span className="summary-errored"> · {summary.errored} err</span>}
            </div>
          )}

          {/* PM2 aggregate: total CPU and RAM across all managed processes */}
          {summary.total > 0 && (
            <div className="topbar-stats-group">
              <span className="topbar-stat" title="Total CPU % across all PM2 processes">
                CPU {summary.totalCpu.toFixed(1)}%
              </span>
              <span className="topbar-stat" title="Total RAM across all PM2 processes">
                RAM {formatMem(summary.totalMemMB)}
              </span>
            </div>
          )}

          {/* Server OS stats: load average and used/total memory */}
          {serverStats && (
            <div
              className="topbar-stats-group"
              title={[
                serverStats.loadAvg5 !== null ? `5m: ${serverStats.loadAvg5}` : null,
                serverStats.loadAvg15 !== null ? `15m: ${serverStats.loadAvg15}` : null,
                `uptime: ${formatUptime(serverStats.serverUptimeSec)}`,
                `${serverStats.cpuCount} CPU cores`,
              ].filter(Boolean).join(' · ')}
            >
              {serverStats.loadAvg1 !== null && (
                <span className="topbar-stat">Load {serverStats.loadAvg1}</span>
              )}
              <span className="topbar-stat">
                Mem {formatMem(serverStats.usedMemMB)}/{formatMem(serverStats.totalMemMB)}
              </span>
            </div>
          )}

          {/* Column width selector */}
          <label className="topbar-control" title="Cards per row">
            <IconColumns />
            <select
              className="topbar-select"
              value={columns}
              onChange={e => handleColumnsChange(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                <option key={n} value={n}>
                  {n === 1 ? '1 col' : `${n} cols`}
                </option>
              ))}
            </select>
          </label>

          {/* Card height selector */}
          <label className="topbar-control" title="Card height">
            <IconHeight />
            <select
              className="topbar-select"
              value={cardHeight}
              onChange={e => handleCardHeightChange(Number(e.target.value))}
            >
              {HEIGHT_OPTIONS.map(h => (
                <option key={h.value} value={h.value}>{h.label}</option>
              ))}
            </select>
          </label>

          {/* Poll interval selector */}
          <label className="topbar-control" title="Refresh interval">
            <IconClock />
            <select
              className="topbar-select"
              value={pollInterval}
              onChange={e => handlePollChange(Number(e.target.value))}
            >
              {POLL_OPTIONS.map(s => (
                <option key={s} value={s}>
                  {s}s
                </option>
              ))}
            </select>
          </label>

          {/* Port discovery button */}
          <button
            className="topbar-icon-btn"
            title="View listening ports"
            onClick={openPortsModal}
          >
            <IconPlug />
          </button>

          <button
            className={`topbar-icon-btn${showArchived ? ' topbar-icon-btn--active' : ''}`}
            title={showArchived ? 'Hide archived cards' : 'Show archived cards'}
            onClick={() => handleShowArchivedChange(!showArchived)}
          >
            <IconArchive />
          </button>

          <div className={`ws-indicator${connected ? ' ws-indicator--connected' : ''}`}>
            <span className="ws-dot" />
            {connected ? 'Live' : 'Disconnected'}
          </div>

          {pm2Health && (pm2Health.degraded || !pm2Health.connected || pm2Health.reconnecting) && (
            <div
              className="ws-indicator"
              title={
                pm2Health.reconnecting
                  ? 'PM2 reconnect in progress'
                  : `PM2 unhealthy (${pm2Health.consecutivePollFailures} poll failures)`
              }
            >
              <span className="ws-dot" />
              {pm2Health.reconnecting ? 'PM2 reconnecting' : 'PM2 degraded'}
            </div>
          )}

          <button className="btn-logout" onClick={logout}>Logout</button>
        </div>
      </header>

      {!connected && (
        <div className="disconnect-banner">
          Connection lost — reconnecting…
        </div>
      )}

      <div
        className="grid-container"
        style={{
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          ['--card-height' as string]: `${cardHeight}px`,
        }}
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={visibleOrder} strategy={rectSortingStrategy}>
            {visibleOrder.map(name => {
              const svc = services[name]
              if (!svc) return null
              return (
                <ServiceCard
                  key={name}
                  service={svc}
                  onAction={handleAction}
                  ports={portsMap[name]}
                />
              )
            })}
          </SortableContext>
        </DndContext>
      </div>

      {showPortsModal && (
        <PortsModal
          onClose={handleClosePortsModal}
          onPortsLoaded={setPortsMap}
        />
      )}
    </div>
  )
}
