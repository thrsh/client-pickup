// src/pages/AccountPages.jsx
//
// Thin per-role wrappers around <AccountSettings />. Drop these into your
// router as the element for /verifier/account, /approver/account, and
// /admin/account. Replace the mock handlers with real API calls — each
// handler should reject with `new Error('message shown to the user')` on
// failure so AccountSettings can surface it.

import React from 'react'
import AccountSettings from '../components/AccountSettings'

// TODO: replace with your real "current user" source (context, query, etc.)
function useCurrentUser() {
  return {
    email: 'verifier01@yourcompany.com',
    recoveryEmail: '',
  }
}

async function changePassword(currentPassword, newPassword, opts) {
  const res = await fetch('/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword, ...opts }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || 'Current password is incorrect.')
  }
}

async function updateEmail(newEmail) {
  const res = await fetch('/api/account/email', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: newEmail }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || 'That email is already in use.')
  }
}

async function updateRecoveryEmail(recoveryEmail) {
  const res = await fetch('/api/account/recovery-email', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recoveryEmail }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || 'Could not save recovery email.')
  }
}

export function VerifierAccountPage() {
  const user = useCurrentUser()
  return <AccountSettings role="verifier" user={user} onChangePassword={changePassword} />
}

export function ApproverAccountPage() {
  const user = useCurrentUser()
  return <AccountSettings role="approver" user={user} onChangePassword={changePassword} />
}

export function AdminAccountPage() {
  const user = useCurrentUser()
  return (
    <AccountSettings
      role="admin"
      user={user}
      onChangePassword={changePassword}
      onUpdateEmail={updateEmail}
      onUpdateRecoveryEmail={updateRecoveryEmail}
    />
  )
}
