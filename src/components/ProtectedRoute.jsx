// src/components/ProtectedRoute.jsx
//
// Session-only guard, same contract as before — role checks live in
// RequireRole (composed alongside it, as in App.jsx), so this stays a
// single, simple responsibility: "is anyone signed in at all".
//
// Default loginPath now points at the single shared /login route used by
// admin, verifier, and approver alike.
import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function ProtectedRoute({ children, loginPath = '/login' }) {
  const location = useLocation()
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-ink-300">
        Loading…
      </div>
    )
  }

  if (!session) {
    return <Navigate to={loginPath} replace state={{ from: location }} />
  }

  return children
}