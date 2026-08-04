// Tracks "this tab currently holds a session obtained via a password-reset
// link" as a fact ProtectedRoute can check — a recovery session proves
// email access, not a completed password + OTP login, and must never
// substitute for one. Deliberately conservative: only cleared on an
// actual sign-out (see useAuth.js), never on link expiry alone, since a
// stale-but-still-valid session object could otherwise slip through
// during the moment the UI flips to "invalid" but before Supabase has
// actually rejected it server-side.
const FLAG_KEY = 'csba_recovery_session_active'
const CHANGE_EVENT = 'csba-recovery-session-change'

export function isRecoverySessionActive() {
  if (typeof window === 'undefined') return false
  try {
    return window.sessionStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return false
  }
}

function setFlag(active) {
  if (typeof window === 'undefined') return
  try {
    if (active) window.sessionStorage.setItem(FLAG_KEY, '1')
    else window.sessionStorage.removeItem(FLAG_KEY)
  } catch {
    // Storage can fail (private mode, quota) — the in-memory React state
    // in useAuth still gates correctly for the rest of this tab's life.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export const markRecoverySessionActive = () => setFlag(true)
export const clearRecoverySessionActive = () => setFlag(false)

// Storage events don't fire in the same tab that made the change, so
// useAuth subscribes to this instead to notice ResetPassword.jsx's calls
// without needing a remount.
export function subscribeToRecoverySessionChange(callback) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(CHANGE_EVENT, callback)
  return () => window.removeEventListener(CHANGE_EVENT, callback)
}