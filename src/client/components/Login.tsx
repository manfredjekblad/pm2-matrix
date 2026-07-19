import React, { useState, FormEvent } from 'react'
import { useApp } from '../context/AppContext'

export default function Login() {
  const { login } = useApp()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="36" height="36" rx="8" fill="#2ecc71" fillOpacity="0.15" />
            <rect x="6" y="6" width="10" height="10" rx="2" fill="#2ecc71" />
            <rect x="20" y="6" width="10" height="10" rx="2" fill="#2ecc71" fillOpacity="0.5" />
            <rect x="6" y="20" width="10" height="10" rx="2" fill="#2ecc71" fillOpacity="0.5" />
            <rect x="20" y="20" width="10" height="10" rx="2" fill="#2ecc71" fillOpacity="0.3" />
          </svg>
          <span>PM2 Matrix</span>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
