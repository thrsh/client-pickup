// src/components/RequireRole.jsx
//
// Gates a subtree by profiles.role. Two rules that fix the bug class you
// hit:
//
// 1. NEVER make a redirect decision until `loading` is false. The original
//    bug is redirecting the instant `role !== 'admin'`, which is also true
//    on the very first render for EVERY signed-in user, because the role
//    hasn't been fetched yet (it starts as null). That's why an admin was
//    bouncing to /approver — not a permissions problem, a timing one.
//
// 2. A failed/blocked profile fetch (misconfigured RLS policy, missing
//    profiles row, network error) is NOT the same thing as "wrong role".
//    Silently treating it as "wrong role" and redirecting hides real
//    misconfiguration from you. This shows a visible, actionable error
//    instead.
import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { useProfile, hasRole } from '../context/ProfileContext'

export default function RequireRole({ role, roles, redirectTo = '/', children }) {
  const location = useLocation()
  const allowed = roles || (role ? [role] : [])
  const { role: currentRole, loading, error } = useProfile()

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-ink-300">
        Loading…
      </div>
    )
  }

  if (error) {
    return <ProfileError error={error} />
  }

  if (!hasRole(currentRole, allowed)) {
    return <Navigate to={redirectTo} replace state={{ from: location }} />
  }

  return children
}

function ProfileError({ error }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <AlertTriangle className="h-8 w-8 text-red-300" />
      <p className="text-sm font-semibold text-ink-700">Couldn't verify your account permissions</p>
      <p className="max-w-sm text-xs text-ink-400">{error}</p>
      <button
        onClick={() => window.location.reload()}
        className="rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50"
      >
        Retry
      </button>
    </div>
  )
}