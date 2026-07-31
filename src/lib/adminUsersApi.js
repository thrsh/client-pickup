// src/lib/adminUsersApi.js
//
// Thin wrapper around the `admin-users` Edge Function. All privileged work
// (creating/updating auth users, banning, password resets) happens server-side
// with the service role key — this file never touches that key.
//
// NOTE: adjust the import below if your supabaseClient.js exports the client
// under a different name.
import { supabase } from './supabaseClient'

async function invoke(action, payload) {
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action, payload },
  })

  if (error) {
    // supabase-js wraps non-2xx responses in `error`; try to surface our own message.
    const message = error.context?.error || error.message || 'Request failed'
    throw new Error(message)
  }
  if (data?.error) throw new Error(data.error)

  return data
}

export function listUsers({ page = 1, perPage = 50 } = {}) {
  return invoke('list', { page, perPage })
}

export function createUser({ email, firstName, lastName, role, branch, password }) {
  return invoke('create', { email, firstName, lastName, role, branch, password })
}

export function updateUser({ id, email, firstName, lastName, role, branch }) {
  return invoke('update', { id, email, firstName, lastName, role, branch })
}

export function deactivateUser(id) {
  return invoke('deactivate', { id })
}

export function reactivateUser(id) {
  return invoke('reactivate', { id })
}

export function sendPasswordReset(email) {
  return invoke('sendPasswordReset', { email })
}