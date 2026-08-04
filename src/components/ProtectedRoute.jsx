import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function ProtectedRoute({ children, loginPath = '/login' }) {
  const location = useLocation()
  const { session, loading, isRecoverySession } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-ink-300">
        Loading…
      </div>
    )
  }

  // A recovery-only session is treated as no session at all — it can
  // never grant access to a protected area, only to the reset form.
  if (!session || isRecoverySession) {
    return <Navigate to={loginPath} replace state={{ from: location }} />
  }

  return children
}