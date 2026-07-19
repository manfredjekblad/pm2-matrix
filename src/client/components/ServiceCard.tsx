import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import AnsiToHtml from 'ansi-to-html'
import { Service, LogFilter, useApp } from '../context/AppContext'
import ConfirmModal from './ConfirmModal'
import Modal from './Modal'
import { IconReload, IconRestart, IconStop, IconStart, IconWarn, IconArchive, IconUnarchive } from './icons'
import { formatMem, formatUptime } from '../utils'

const converter = new AnsiToHtml({ escapeXML: true, newline: true })

const STATUS_COLORS: Record<string, string> = {
  online: '#2ecc71',
  stopped: '#6c757d',
  errored: '#e74c3c',
  launching: '#f1c40f',
  unknown: '#6c757d',
}

export type ServiceAction = 'restart' | 'reload' | 'stop' | 'start'

interface Props {
  service: Service
  onAction: (action: ServiceAction, name: string) => Promise<void>
  ports?: number[]
}

export default function ServiceCard({ service, onAction, ports }: Props) {
  const { cardFilters, setCardFilter, archivedMap, setArchived } = useApp()
  const filter: LogFilter = cardFilters[service.name] ?? 'all'
  const isArchived = archivedMap[service.name] === true

  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: service.name })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const cardRef = useRef<HTMLDivElement | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const lastSeenStderrCount = useRef<number>(0)
  const actionErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [pendingAction, setPendingAction] = useState<'restart' | 'stop' | null>(null)
  const [loadingAction, setLoadingAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)
  // narrow: true → show dropdown; false → show pill group
  const [narrow, setNarrow] = useState(false)

  const isOnline = service.status === 'online' || service.status === 'launching'
  const isStopped = service.status === 'stopped'

  // Avoid scanning the full log array on every render.
  const stderrCount = useMemo(
    () => service.logs.filter(e => e.level === 'stderr').length,
    [service.logs]
  )

  // Track the count when the user is actively viewing the stderr filter so the
  // warning triangle can be dismissed accurately.
  useEffect(() => {
    if (filter === 'stderr') {
      lastSeenStderrCount.current = stderrCount
    }
  }, [filter, stderrCount])

  const hasUnread = filter !== 'stderr' && stderrCount > lastSeenStderrCount.current
  const unreadCount = Math.max(0, stderrCount - lastSeenStderrCount.current)

  // Memoized so the filter scan doesn't re-run on unrelated re-renders
  // (e.g. when only CPU/RAM stats update without any new log entries).
  const filteredLogs = useMemo(
    () => filter === 'all' ? service.logs : service.logs.filter(e => e.level === filter),
    [service.logs, filter]
  )

  // Clear action error timer on unmount to prevent state updates after the
  // component is gone (e.g. when the service card is removed from the grid).
  useEffect(() => {
    return () => {
      if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current)
    }
  }, [])

  // ResizeObserver: switch between pills and dropdown based on card width.
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setNarrow(entry.contentRect.width < 320)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }, [])

  useEffect(() => {
    if (autoScroll) {
      const el = logRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [filteredLogs, autoScroll])

  function handleFilterChange(f: LogFilter) {
    setCardFilter(service.name, f)
    if (f === 'stderr') {
      lastSeenStderrCount.current = stderrCount
    }
  }

  function showActionError(msg: string) {
    setActionError(msg)
    if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current)
    actionErrorTimer.current = setTimeout(() => setActionError(null), 4000)
  }

  async function handleAction(action: ServiceAction) {
    if (action === 'restart' || action === 'stop') {
      setPendingAction(action)
      return
    }
    setLoadingAction(action)
    try {
      await onAction(action, service.name)
    } catch (err) {
      showActionError(err instanceof Error ? err.message : `Failed to ${action}`)
    } finally {
      setLoadingAction(null)
    }
  }

  async function confirmAction() {
    if (!pendingAction) return
    const action = pendingAction
    setPendingAction(null)
    setLoadingAction(action)
    try {
      await onAction(action, service.name)
    } catch (err) {
      showActionError(err instanceof Error ? err.message : `Failed to ${action}`)
    } finally {
      setLoadingAction(null)
    }
  }

  // Assign both dnd-kit's ref and the local cardRef in one named callback to
  // avoid cluttering the JSX with an inline cast.
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el)
      cardRef.current = el
    },
    [setNodeRef]
  )

  const statusColor = STATUS_COLORS[service.status] ?? '#6c757d'

  const filterControls = (
    <div className="titlebar-filter" onPointerDown={e => e.stopPropagation()}>
      {hasUnread && (
        <button
          className="warn-triangle"
          title={`${unreadCount} unread error${unreadCount !== 1 ? 's' : ''} — click to view`}
          onClick={() => handleFilterChange('stderr')}
        >
          <IconWarn />
          {unreadCount > 0 && (
            <span className="warn-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
          )}
        </button>
      )}
      {narrow ? (
        <select
          className="topbar-select titlebar-filter-select"
          value={filter}
          onChange={e => handleFilterChange(e.target.value as LogFilter)}
        >
          <option value="all">All</option>
          <option value="stdout">Out</option>
          <option value="stderr">Err{stderrCount > 0 ? ` (${stderrCount > 99 ? '99+' : stderrCount})` : ''}</option>
        </select>
      ) : (
        <div className="titlebar-filter-pills">
          <button
            className={`card-filter-btn${filter === 'all' ? ' card-filter-btn--active' : ''}`}
            onClick={() => handleFilterChange('all')}
          >
            All
          </button>
          <button
            className={`card-filter-btn${filter === 'stdout' ? ' card-filter-btn--active' : ''}`}
            onClick={() => handleFilterChange('stdout')}
          >
            Out
          </button>
          <button
            className={`card-filter-btn card-filter-btn--err${filter === 'stderr' ? ' card-filter-btn--active card-filter-btn--err-active' : ''}`}
            onClick={() => handleFilterChange('stderr')}
          >
            Err
            {stderrCount > 0 && (
              <span className="card-filter-count">{stderrCount > 99 ? '99+' : stderrCount}</span>
            )}
          </button>
        </div>
      )}
    </div>
  )

  const cardClasses = [
    'service-card',
    isArchived ? 'service-card--archived' : '',
    isDragging ? 'service-card--dragging' : '',
    isOver && !isDragging ? 'service-card--drop-target' : '',
  ].filter(Boolean).join(' ')

  return (
    <>
      <div ref={setRefs} style={style} className={cardClasses}>
        {/* Title bar — drag handle + double-click to expand */}
        <div
          className="card-titlebar"
          {...listeners}
          {...attributes}
          onDoubleClick={() => setShowModal(true)}
          title="Double-click to expand • Drag to reorder"
        >
          <div className="card-title-left">
            <span className="status-dot" style={{ background: statusColor }} />
            <span className="card-name" title={service.name}>{service.name}</span>
            <span className="card-status" style={{ color: statusColor }}>{service.status}</span>
          </div>
          <div className="card-stats">
            <span title="CPU">{service.cpu.toFixed(1)}%</span>
            <span title="RAM">{formatMem(service.memoryMB)}</span>
            <span title="Uptime">{formatUptime(service.uptimeSec)}</span>
          </div>
          {filterControls}
          <div className="card-actions" onPointerDown={e => e.stopPropagation()}>
            <button
              className="action-btn"
              title="Reload"
              disabled={loadingAction !== null}
              onClick={() => handleAction('reload')}
            >
              <IconReload />
            </button>
            <button
              className="action-btn"
              title="Restart"
              disabled={loadingAction !== null}
              onClick={() => handleAction('restart')}
            >
              <IconRestart />
            </button>
            {isStopped ? (
              <button
                className="action-btn action-btn--start"
                title="Start"
                disabled={loadingAction !== null}
                onClick={() => handleAction('start')}
              >
                <IconStart />
              </button>
            ) : (
              <button
                className="action-btn action-btn--stop"
                title="Stop"
                disabled={loadingAction !== null}
                onClick={() => handleAction('stop')}
              >
                <IconStop />
              </button>
            )}
            <button
              className={`action-btn${isArchived ? ' action-btn--start' : ''}`}
              title={isArchived ? 'Unarchive card' : 'Archive card'}
              disabled={loadingAction !== null}
              onClick={() => setArchived(service.name, !isArchived)}
            >
              {isArchived ? <IconUnarchive /> : <IconArchive />}
            </button>
          </div>
        </div>

        {/* Transient error banner shown when a service action fails */}
        {actionError && (
          <div className="card-action-error">{actionError}</div>
        )}

        {/* Console window */}
        <div
          className={`log-window${!isOnline ? ' log-window--offline' : ''}`}
          ref={logRef}
          onScroll={handleScroll}
        >
          {isOnline ? (
            filteredLogs.length === 0 ? (
              <div className="log-offline">No {filter !== 'all' ? filter : ''} log entries yet</div>
            ) : (
              filteredLogs.map((entry) => (
                <div
                  key={entry.id}
                  className={`log-line${entry.level === 'stderr' ? ' log-line--err' : ''}`}
                >
                  <span className="log-ts" title={entry.timestamp}>{entry.timestamp.slice(11, 23)}</span>
                  <span
                    className="log-msg"
                    dangerouslySetInnerHTML={{ __html: converter.toHtml(entry.message) }}
                  />
                </div>
              ))
            )
          ) : (
            <div className="log-offline">Service is {service.status}</div>
          )}
        </div>

        {!autoScroll && isOnline && (
          <button
            className="scroll-to-bottom"
            onClick={() => {
              setAutoScroll(true)
              const el = logRef.current
              if (el) el.scrollTop = el.scrollHeight
            }}
          >
            ↓ Jump to bottom
          </button>
        )}
      </div>

      {pendingAction && (
        <ConfirmModal
          message={`Are you sure you want to ${pendingAction} "${service.name}"?`}
          onConfirm={confirmAction}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {showModal && (
        <Modal
          name={service.name}
          logs={service.logs}
          status={service.status}
          ports={ports}
          onAction={(action) => onAction(action, service.name)}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  )
}
