import React, { useEffect, useState } from 'react'
import { AppProvider, useApp } from './context/AppContext'
import Login from './components/Login'
import Grid from './components/Grid'

function Inner() {
  const { authenticated, checkAuth } = useApp()
  const [checking, setChecking] = useState(true)
  const [serverError, setServerError] = useState(false)

  useEffect(() => {
    void checkAuth()
      .catch(() => setServerError(true))
      .finally(() => setChecking(false))
  }, [checkAuth])

  if (checking) {
    return (
      <div className="splash">
        <span className="spinner" />
      </div>
    )
  }

  if (authenticated) return <Grid />

  return (
    <>
      {serverError && (
        <div className="server-error-banner">
          Cannot reach server — check that PM2 Matrix is running and refresh the page.
        </div>
      )}
      <Login />
    </>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Inner />
    </AppProvider>
  )
}
