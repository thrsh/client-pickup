// src/components/RoleHome.jsx
//
// Used as the `redirectTo` target on RequireRole for all three protected
// areas. Instead of hardcoding e.g. redirectTo="/approver" on the verifier
// route (which breaks the moment a THIRD role, like admin, shows up — an
// admin landing on /verifier would get bounced to /approver, rejected
// there too, bounced back, etc.), every RequireRole points here, and this
// reads the person's actual role once and sends them to the one place
// that's actually correct for them.
import React from 'react'
import { Navigate } from 'react-router-dom'
import { useProfile } from '../context/ProfileContext'

const ROLE_HOME_PATH = {
  admin: '/admin',
  verifier: '/verifier',
  approver: '/approver',
}

export default function RoleHome() {
  const { role, loading } = useProfile()

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-ink-300">
        Loading…
      </div>
    )
  }

  const path = ROLE_HOME_PATH[role]
  if (path) return <Navigate to={path} replace />

  // Signed in, but no recognized role (e.g. profile row exists with a
  // role value that isn't admin/verifier/approver, or role is null).
  // Don't bounce them into another loop — show something actionable.
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm font-semibold text-ink-700">Your account isn't assigned to an area yet</p>
      <p className="max-w-sm text-xs text-ink-400">
        Ask an admin to set a role (admin, verifier, or approver) on your profile.
      </p>
    </div>
  )
}