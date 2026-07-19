import React, { useEffect, useMemo, useState } from 'react'
import { useApp } from '../context/AppContext'

interface PortsData {
  ports: Record<string, number[]>
  fallbackUsed?: boolean
}

interface Props {
  onClose: () => void
  /** Called with the fetched ports map so the parent can update ServiceCard badges. */
  onPortsLoaded?: (ports: Record<string, number[]>) => void
}

export default function PortsModal({ onClose, onPortsLoaded }: Props) {
  const { order, services } = useApp()
  const [ports, setPorts] = useState<Record<string, number[]> | null>(null)
  const [fallbackUsed, setFallbackUsed] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/ports', { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: PortsData) => {
        setPorts(data.ports)
        setFallbackUsed(data.fallbackUsed ?? false)
        // Notify parent so ServiceCard port badges stay in sync without a
        // second independent fetch.
        onPortsLoaded?.(data.ports)
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(true)
      })
    return () => controller.abort()
  // onPortsLoaded is a callback ref — exclude from deps to avoid re-fetching
  // every time the parent re-renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Display services in grid order, appending any not yet in the order list.
  const displayOrder = useMemo(() => [
    ...order,
    ...Object.keys(services).filter(n => !order.includes(n)),
  ], [order, services])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="ports-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Listening Ports</span>
          <span className="ports-modal-note">
            Linux only · updates on each page load
            {fallbackUsed && ' · UID fallback active — ports may include co-user processes'}
          </span>
          <button className="modal-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="ports-modal-body">
          {error && (
            <div className="ports-error">Could not load port data.</div>
          )}

          {!error && ports === null && (
            <div className="ports-loading">Loading…</div>
          )}

          {!error && ports !== null && (
            <table className="ports-table">
              <thead>
                <tr>
                  <th className="ports-th">Service</th>
                  <th className="ports-th">Listening ports</th>
                </tr>
              </thead>
              <tbody>
                {displayOrder.map(name => {
                  const servicePorts = ports[name] ?? []
                  return (
                    <tr key={name} className="ports-row">
                      <td className="ports-svc-name" title={name}>{name}</td>
                      <td className="ports-list">
                        {servicePorts.length === 0 ? (
                          <span className="ports-none">—</span>
                        ) : (
                          servicePorts.map(p => (
                            <span key={p} className="port-badge">{p}</span>
                          ))
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
