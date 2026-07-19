import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import AnsiToHtml from 'ansi-to-html'
import { LogEntry, LogFilter } from '../context/AppContext'
import { IconWarn, IconPause, IconPlay, IconSearch, IconCopy, IconReload, IconRestart, IconStop, IconStart } from './icons'
import { ServiceAction } from './ServiceCard'

const converter = new AnsiToHtml({ escapeXML: true, newline: true })

const FONT_SIZES: Record<string, number> = { S: 11, M: 13, L: 15 }

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) return JSON.parse(raw) as T
  } catch {}
  return fallback
}

/**
 * Wraps all occurrences of `term` (case-insensitive) in the given HTML-rendered
 * log string with <mark> tags.  Replacement is restricted to text that lies
 * outside HTML tags (i.e. not inside `<...>`) to avoid corrupting attribute
 * values produced by ansi-to-html.
 *
 * The search term is HTML-escaped before being inserted to prevent XSS —
 * e.g. searching for `<script>` injects `&lt;script&gt;` into the DOM, not
 * a real element.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function highlightMatch(html: string, term: string): string {
  if (!term) return html
  const reEscaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Split on HTML tags; odd-indexed segments are tags, even-indexed are text.
  const parts = html.split(/(<[^>]*>)/)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part // inside a tag — leave intact
      const re = new RegExp(`(${reEscaped})`, 'gi')
      // HTML-escape the matched text before wrapping so the search term itself
      // cannot inject markup (e.g. user types "<img src=x onerror=...>").
      return part.replace(re, (match) => `<mark>${escapeHtml(match)}</mark>`)
    })
    .join('')
}

interface Props {
  name: string
  logs: LogEntry[]
  status?: string
  ports?: number[]
  onAction?: (action: ServiceAction) => Promise<void>
  onClose: () => void
}

export default function Modal({ name, logs, status, ports, onAction, onClose }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const frozenRef = useRef<LogEntry[]>([])
  const lastSeenStderrCount = useRef<number>(0)
  const lastCopiedRef = useRef<string>('')
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks the inner fade-out timer so it can be cancelled on remount or rapid
  // successive toasts — prevents stale state updates after unmount.
  const clipboardFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [autoScroll, setAutoScroll] = useState(true)
  const [filter, setFilter] = useState<LogFilter>('all')
  const [paused, setPaused] = useState(false)
  const [clipboardMsg, setClipboardMsg] = useState('')
  const [clipboardFade, setClipboardFade] = useState(false)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [fontSize, setFontSize] = useState<'S' | 'M' | 'L'>(() =>
    loadFromStorage<'S' | 'M' | 'L'>('pm2m-modal-font', 'M')
  )
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Avoid scanning the full log array on every render.
  const stderrCount = useMemo(
    () => logs.filter(e => e.level === 'stderr').length,
    [logs]
  )

  useEffect(() => {
    if (filter === 'stderr') {
      lastSeenStderrCount.current = stderrCount
    }
  }, [filter, stderrCount])

  const hasUnread = filter !== 'stderr' && stderrCount > lastSeenStderrCount.current
  const unreadCount = Math.max(0, stderrCount - lastSeenStderrCount.current)

  const applyFilter = useCallback((entries: LogEntry[]) =>
    filter === 'all' ? entries : entries.filter(e => e.level === filter),
    [filter]
  )

  const filteredLogs = applyFilter(logs)

  // Apply search filter on top of log-level filter.
  const searchedLogs = useMemo(() => {
    if (!search.trim()) return filteredLogs
    const q = search.toLowerCase()
    return filteredLogs.filter(e => e.message.toLowerCase().includes(q))
  }, [filteredLogs, search])

  const displayLogs = paused ? applyFilter(frozenRef.current) : searchedLogs

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }, [])

  useEffect(() => {
    if (!paused && autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [displayLogs, autoScroll, paused])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !searchOpen) {
        onClose()
        return
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearch('')
        setSearchOpen(false)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 50)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, searchOpen])

  // When the text selection is cleared, reset the dedup tracker so that the
  // same text can be copied again if the user re-selects it.
  useEffect(() => {
    function onSelectionChange() {
      if (!window.getSelection()?.toString()) {
        lastCopiedRef.current = ''
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  // Clear search and cancel all timers when modal unmounts to prevent state
  // updates on an unmounted component.
  useEffect(() => () => {
    setSearch('')
    setSearchOpen(false)
    if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current)
    if (clipboardFadeTimerRef.current) clearTimeout(clipboardFadeTimerRef.current)
  }, [])

  function handleFilterChange(f: LogFilter) {
    setFilter(f)
    if (f === 'stderr') {
      lastSeenStderrCount.current = stderrCount
    }
  }

  function handlePause() {
    if (!paused) {
      frozenRef.current = [...logs]
      setAutoScroll(false)
    } else {
      setAutoScroll(true)
    }
    setPaused(p => !p)
  }

  function showClipboardToast(msg: string) {
    if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current)
    if (clipboardFadeTimerRef.current) clearTimeout(clipboardFadeTimerRef.current)
    setClipboardFade(false)
    setClipboardMsg(msg)
    clipboardTimerRef.current = setTimeout(() => {
      setClipboardFade(true)
      clipboardFadeTimerRef.current = setTimeout(() => {
        setClipboardMsg('')
        setClipboardFade(false)
      }, 400)
    }, 1800)
  }

  /**
   * Write text to the clipboard with a fallback for non-secure contexts (plain
   * HTTP deployments) where navigator.clipboard is unavailable.
   */
  function writeToClipboard(text: string, successMsg: string) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
        .then(() => showClipboardToast(successMsg))
        .catch(() => showClipboardToast('Clipboard unavailable'))
    } else {
      // Fallback: create a temporary textarea and use execCommand.
      try {
        const el = document.createElement('textarea')
        el.value = text
        el.style.position = 'fixed'
        el.style.opacity = '0'
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
        showClipboardToast(successMsg)
      } catch {
        showClipboardToast('Clipboard unavailable')
      }
    }
  }

  // Automatically copy selected text to clipboard (PuTTY-style).
  function handlePointerUp() {
    const selection = window.getSelection()
    const text = selection?.toString() ?? ''
    if (!text || text === lastCopiedRef.current) return
    lastCopiedRef.current = text
    writeToClipboard(text, 'Copied to clipboard')
  }

  // Copy all visible log lines to the clipboard.
  function handleCopyAll() {
    const text = displayLogs
      .map(e => `[${e.timestamp.slice(11, 23)}] ${e.message}`)
      .join('\n')
    writeToClipboard(text, `Copied ${displayLogs.length} lines`)
  }

  function handleFontSize(s: 'S' | 'M' | 'L') {
    setFontSize(s)
    localStorage.setItem('pm2m-modal-font', JSON.stringify(s))
  }

  async function handleAction(action: ServiceAction) {
    if (!onAction) return
    setActionLoading(action)
    try {
      await onAction(action)
    } catch { /* errors are already shown in ServiceCard */ } finally {
      setActionLoading(null)
    }
  }

  const isStopped = status === 'stopped'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-expanded" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{name}</span>

          {/* Port badges: inline for 1-2 ports, read-only dropdown for 3+ */}
          {ports && ports.length > 0 && (
            ports.length <= 2
              ? (
                <div className="modal-ports">
                  {ports.map(p => (
                    <span key={p} className="port-badge" title="Listening port">:{p}</span>
                  ))}
                </div>
              )
              : (
                // <select> does not support readOnly, so we block changes via
                // onChange rather than using disabled (which grays it out).
                <select
                  className="port-select-badge"
                  title={`Listening on ${ports.length} ports — click to see all`}
                  value={ports[0]}
                  onChange={e => e.preventDefault()}
                >
                  {ports.map(p => (
                    <option key={p} value={p}>:{p}</option>
                  ))}
                </select>
              )
          )}

          {/* Log level filter */}
          <div className="log-filter">
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
            <button
              className={`log-filter-btn${filter === 'all' ? ' log-filter-btn--active' : ''}`}
              onClick={() => handleFilterChange('all')}
            >
              All
            </button>
            <button
              className={`log-filter-btn${filter === 'stdout' ? ' log-filter-btn--active' : ''}`}
              onClick={() => handleFilterChange('stdout')}
            >
              Out
            </button>
            <button
              className={`log-filter-btn log-filter-btn--err${filter === 'stderr' ? ' log-filter-btn--active log-filter-btn--err-active' : ''}`}
              onClick={() => handleFilterChange('stderr')}
            >
              Err{stderrCount > 0 && <span className="log-filter-count">{stderrCount}</span>}
            </button>
          </div>

          {/* Search bar */}
          {searchOpen && (
            <input
              ref={searchInputRef}
              className="modal-search-input"
              type="text"
              placeholder="Filter logs…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          )}

          {/* Clipboard toast */}
          {clipboardMsg && (
            <span className={`clipboard-msg${clipboardFade ? ' clipboard-msg--fade' : ''}`}>
              {clipboardMsg}
            </span>
          )}

          {/* Font size toggle */}
          <div className="modal-font-btns">
            {(['S', 'M', 'L'] as const).map(s => (
              <button
                key={s}
                className={`modal-pause-btn${fontSize === s ? ' modal-pause-btn--active' : ''}`}
                onClick={() => handleFontSize(s)}
                title={`Font size: ${s}`}
                style={{ fontSize: 10 + (['S', 'M', 'L'].indexOf(s)) * 1 }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Search button */}
          <button
            className={`modal-pause-btn${searchOpen ? ' modal-pause-btn--active' : ''}`}
            onClick={() => {
              const next = !searchOpen
              setSearchOpen(next)
              if (next) setTimeout(() => searchInputRef.current?.focus(), 50)
              else setSearch('')
            }}
            title="Search logs (Ctrl+F)"
          >
            <IconSearch />
          </button>

          {/* Copy all visible logs */}
          <button
            className="modal-pause-btn"
            onClick={handleCopyAll}
            title="Copy all visible logs"
          >
            <IconCopy />
          </button>

          {/* Service action buttons */}
          {onAction && (
            <div className="modal-actions">
              <button
                className="action-btn"
                title="Reload"
                disabled={actionLoading !== null}
                onClick={() => handleAction('reload')}
              >
                <IconReload />
              </button>
              <button
                className="action-btn"
                title="Restart"
                disabled={actionLoading !== null}
                onClick={() => handleAction('restart')}
              >
                <IconRestart />
              </button>
              {isStopped ? (
                <button
                  className="action-btn action-btn--start"
                  title="Start"
                  disabled={actionLoading !== null}
                  onClick={() => handleAction('start')}
                >
                  <IconStart />
                </button>
              ) : (
                <button
                  className="action-btn action-btn--stop"
                  title="Stop"
                  disabled={actionLoading !== null}
                  onClick={() => handleAction('stop')}
                >
                  <IconStop />
                </button>
              )}
            </div>
          )}

          {/* Pause / resume */}
          <button
            className={`modal-pause-btn${paused ? ' modal-pause-btn--active' : ''}`}
            onClick={handlePause}
            title={paused ? 'Resume live logs' : 'Pause log display'}
          >
            {paused ? <IconPlay /> : <IconPause />}
          </button>

          <button className="modal-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div
          className="log-window log-window--modal"
          ref={containerRef}
          style={{ fontSize: FONT_SIZES[fontSize] }}
          onScroll={handleScroll}
          onPointerUp={handlePointerUp}
        >
          {displayLogs.length === 0 ? (
            <div className="log-offline" style={{ marginTop: 24 }}>
              {search ? `No results for "${search}"` : `No ${filter !== 'all' ? filter : ''} log entries`}
            </div>
          ) : (
            displayLogs.map((entry) => {
              const html = highlightMatch(converter.toHtml(entry.message), search)
              return (
                <div
                  key={entry.id}
                  className={`log-line${entry.level === 'stderr' ? ' log-line--err' : ''}`}
                >
                  <span className="log-ts" title={entry.timestamp}>{entry.timestamp.slice(11, 23)}</span>
                  <span
                    className="log-msg"
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                </div>
              )
            })
          )}
          <div ref={bottomRef} />
        </div>

        {paused && (
          <div className="paused-banner">
            Paused — <button onClick={handlePause}>Resume</button>
          </div>
        )}

        {!autoScroll && !paused && (
          <button
            className="scroll-to-bottom"
            onClick={() => {
              setAutoScroll(true)
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            }}
          >
            ↓ Jump to bottom
          </button>
        )}
      </div>
    </div>
  )
}
