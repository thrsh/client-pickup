// src/pages/admin/AdminAccount.jsx
//
// ASSUMPTION: your Supabase client is exported as `supabase` from
// src/lib/supabaseClient.js. If yours lives somewhere else, fix the
// import path below.
//
// NOTE on recovery email: your `profiles` table (from the schema you
// shared) doesn't have a column for it yet. Add one before this will
// work:
//
//   ALTER TABLE public.profiles ADD COLUMN recovery_email text;
//
// Also note Supabase Auth only ever sends password-reset emails to a
// user's real login email — storing a recovery_email on the profile is
// just data at this point. To actually use it for "forgot password", you
// need a small server-side function (Edge Function, since it has to look
// up a user by an email that ISN'T their login email) that: looks up the
// profile by recovery_email, finds that profile's auth user, and calls
// the Admin API to send/trigger the reset to their real login email.
// Flag if you want that Edge Function built next.
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

// Supabase sends a confirmation link to the NEW address before the change
// takes effect (this is a Supabase Auth default, "Secure email change").
// The email in your session won't actually update until that link is
// clicked, so the success message reflects that instead of implying it's
// instant.
async function updateEmail(newEmail) {
  const { error } = await supabase.auth.updateUser({ email: newEmail })
  if (error) {
    throw new Error(error.message || 'Could not update email.')
  }
}

async function updateRecoveryEmail(recoveryEmail) {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error('Could not verify your session. Please sign in again.')
  }

  const { error } = await supabase
    .from('profiles')
    .update({ recovery_email: recoveryEmail })
    .eq('id', user.id)

  if (error) {
    throw new Error(error.message || 'Could not save recovery email.')
  }
}

export default function AdminAccount() {
  const { user } = useAuth()

  return (
    <AccountSettings
      role="admin"
      user={{ email: user?.email || '', recoveryEmail: user?.recoveryEmail || '' }}
      onChangePassword={changePassword}
      onUpdateEmail={updateEmail}
      onUpdateRecoveryEmail={updateRecoveryEmail}
    />
  )
}