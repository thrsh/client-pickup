// src/pages/approver/ApproverAccount.jsx
//
// ASSUMPTION: your Supabase client is exported as `supabase` from
// src/lib/supabaseClient.js. If yours lives somewhere else, fix the
// import path below.
import React from 'react'
import AccountSettings from '../../components/AccountSettings'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabaseClient'

// Your project has "Require current password on change" enabled in
// Auth settings, so Supabase itself verifies `current_password` as part
// of this single call — no separate re-auth step needed (or wanted: an
// extra signInWithPassword call was what caused the false
// "current_password_required" error before, since it never actually
// forwarded the current password into updateUser()).
async function changePassword(currentPassword, newPassword, opts = {}) {
  const { error } = await supabase.auth.updateUser({
    password: newPassword,
    current_password: currentPassword,
  })

  if (error) {
    if (
      error.code === 'current_password_required' ||
      error.code === 'invalid_credentials' ||
      /current password/i.test(error.message || '')
    ) {
      throw new Error('Current password is incorrect.')
    }
    if (error.code === 'same_password') {
      throw new Error('New password must be different from your current password.')
    }
    throw new Error(error.message || 'Could not update password.')
  }

  if (opts.signOutOthers) {
    await supabase.auth.signOut({ scope: 'others' })
  }
}

export default function ApproverAccount() {
  const { user } = useAuth()

  return (
    <AccountSettings
      role="approver"
      user={{ email: user?.email || '' }}
      onChangePassword={changePassword}
    />
  )
}