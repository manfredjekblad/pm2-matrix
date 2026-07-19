import bcrypt from 'bcrypt'
import { RequestHandler, Request } from 'express'
import session from 'express-session'
import path from 'path'
import fs from 'fs'

const FileStore = require('session-file-store')(session)

const USER = process.env.PM2_MATRIX_USER ?? 'admin'
const PASSWORD_HASH = process.env.PM2_MATRIX_PASSWORD_HASH ?? ''
const SESSION_SECRET = process.env.SESSION_SECRET ?? ''

const SESSION_SECRET_PLACEHOLDERS = new Set([
  'changeme',
  'REPLACE_WITH_A_RANDOM_64_CHAR_HEX_STRING',
])
const MIN_SESSION_SECRET_LENGTH = 32

// Fail fast at startup rather than silently accepting insecure defaults.
if (
  !SESSION_SECRET ||
  SESSION_SECRET_PLACEHOLDERS.has(SESSION_SECRET) ||
  SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH
) {
  throw new Error(
    '[auth] SESSION_SECRET is missing, is a documented placeholder, or is shorter than ' +
    `${MIN_SESSION_SECRET_LENGTH} characters. ` +
    'Set a strong random value in your .env file before starting ' +
    '(e.g. openssl rand -hex 32).'
  )
}
if (!PASSWORD_HASH) {
  throw new Error(
    '[auth] PM2_MATRIX_PASSWORD_HASH is not set. ' +
    'Generate a bcrypt hash with: npm run generate-hash <yourpassword>'
  )
}

// Ensure the session directory exists before the session store is created.
// This runs once at module import time (application startup).
const sessionsDir = path.join(process.cwd(), 'data', 'sessions')
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true })

export const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // fileMode 0o600 restricts session files to the owner only, preventing
  // other OS users on a shared host from reading session tokens directly.
  store: new FileStore({ path: sessionsDir, ttl: 86400, retries: 1, fileMode: 0o600 }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    // 'auto' sets Secure only when the request is HTTPS (req.secure).  That
    // works for direct TLS and for HTTPS reverse proxies when TRUST_PROXY=1.
    // Forcing Secure whenever NODE_ENV=production breaks login over plain HTTP
    // (e.g. Tailscale IP access): the browser ignores the cookie, /api/login
    // still returns 200, then /api/me sees no session.
    secure: 'auto',
  },
})

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.session?.authenticated) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

export const loginHandler: RequestHandler = async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string }

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' })
    return
  }

  if (username !== USER) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  let valid = false
  try {
    valid = await bcrypt.compare(password, PASSWORD_HASH)
  } catch {
    res.status(500).json({ error: 'Auth configuration error' })
    return
  }

  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  // Regenerate the session ID before writing auth data to prevent session
  // fixation attacks: an existing session (e.g. from a previous login) gets
  // a fresh ID, invalidating any session token the attacker may have observed.
  req.session.regenerate((err) => {
    if (err) {
      console.error('[auth] Failed to regenerate session:', err)
      res.status(500).json({ error: 'Session error' })
      return
    }
    req.session.authenticated = true
    req.session.username = username
    res.json({ ok: true })
  })
}

export const logoutHandler: RequestHandler = (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      // Log the error but still clear the cookie and respond — the session file
      // may already be gone, and the user should still be logged out client-side.
      console.error('[auth] session.destroy error:', err)
    }
    // Clear the session cookie from the browser so the client cannot present
    // an invalidated session ID after the server-side record is gone.
    res.clearCookie('connect.sid')
    res.json({ ok: true })
  })
}

export const meHandler: RequestHandler = (req, res) => {
  // Prevent browsers/proxies from serving a stale 304 of { authenticated: false }
  // after a successful login (Express ETags would otherwise match the old body).
  res.set('Cache-Control', 'no-store')
  if (req.session?.authenticated) {
    res.json({ authenticated: true, username: req.session.username })
  } else {
    res.json({ authenticated: false })
  }
}

export function isSessionAuthenticated(req: Request): boolean {
  // req.session is augmented with `authenticated` and `username` in types.ts.
  return !!req.session?.authenticated
}
