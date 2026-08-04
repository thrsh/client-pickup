// src/pages/ResetPassword.jsx
//
// Mounted at /reset-password (see App.jsx — add
// `<Route path="/reset-password" element={<ResetPassword />} />`). This is
// where the link from `supabase.auth.resetPasswordForEmail()` in
// Login.jsx's "forgot password" step lands.
//
import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Lock,
  ShieldCheck,
  WifiOff,
} from 'lucide-react'
import { markRecoverySessionActive, clearRecoverySessionActive } from '../lib/recoverySession'
import { supabase } from '../lib/supabaseClient'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { cn } from '../lib/utils'
import PasswordField from '../components/PasswordField'
import PasswordStrengthMeter from '../components/PasswordStrengthMeter'
import { evaluatePassword } from '../lib/password'

function MotionStyles() {
  return (
    <style>{`
      @keyframes csba-shake {
        10%, 90% { transform: translateX(-1px); }
        20%, 80% { transform: translateX(2px); }
        30%, 50%, 70% { transform: translateX(-4px); }
        40%, 60% { transform: translateX(4px); }
      }
      @keyframes csba-pop {
        0% { transform: scale(0.5); opacity: 0; }
        60% { transform: scale(1.12); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes csba-rise {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes csba-accent-grow {
        from { transform: scaleX(0); }
        to { transform: scaleX(1); }
      }
      .csba-shake { animation: csba-shake 480ms cubic-bezier(.36,.07,.19,.97) both; }
      .csba-pop { animation: csba-pop 220ms cubic-bezier(0.34,1.56,0.64,1) both; }
      .csba-rise { animation: csba-rise 420ms cubic-bezier(0.16,1,0.3,1) both; }
      .csba-accent { transform-origin: left center; animation: csba-accent-grow 600ms cubic-bezier(0.16,1,0.3,1) both; }
      @media (prefers-reduced-motion: reduce) {
        .csba-shake, .csba-pop, .csba-rise, .csba-accent { animation: none !important; }
      }
    `}</style>
  )
}

function friendlyUpdateError(message) {
  if (!message) return 'Something went wrong. Please try again.'
  const m = message.toLowerCase()
  if (m.includes('same') || m.includes('different from the old')) {
    return 'Your new password must be different from your current password.'
  }
  if (m.includes('should be at least') || m.includes('weak') || m.includes('leaked')) {
    return 'That password isn\u2019t strong enough. Try adding more length or variety.'
  }
  if (m.includes('rate limit') || m.includes('too many')) {
    return 'Too many attempts. Please wait a moment before trying again.'
  }
  if (m.includes('expired') || m.includes('invalid') || m.includes('session')) {
    return 'Your reset link has expired. Request a new one to continue.'
  }
  if (m.includes('network') || m.includes('fetch')) {
    return 'Network error \u2014 check your connection and try again.'
  }
  return message
}

function formatCountdown(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function ResetPassword() {
  const navigate = useNavigate()
  const [linkStatus, setLinkStatus] = useState('checking')
  const [expiresAt, setExpiresAt] = useState(null) // unix seconds
  const [secondsLeft, setSecondsLeft] = useState(null)

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [capsLockOn, setCapsLockOn] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [redirectSeconds, setRedirectSeconds] = useState(3)
  const [shakeTick, setShakeTick] = useState(0)

  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine
  )

  const submittingRef = useRef(false)

  // --- Connectivity -------------------------------------------------------
  useEffect(() => {
    const goOnline = () => setIsOnline(true)
    const goOffline = () => setIsOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  // --- Validate the recovery link ------------------------------------------
  // detectSessionInUrl finishes parsing the link asynchronously, so we
  // listen for the auth event AND poll getSession() once as a fallback in
  // case parsing completed before this effect subscribed.
  useEffect(() => {
    let cancelled = false
    let fallbackTimer = null

    function acceptSession(session) {
      if (cancelled || !session) return
      // This is the ONE place a recovery session gets marked active — the
      // moment we've confirmed Supabase actually parsed the reset link
      // into a session. ProtectedRoute elsewhere in the app depends on
      // this flag having been set before this form becomes usable, so it
      // must fire on every path that accepts a session below, not just
      // the happy path.
      markRecoverySessionActive()
      setLinkStatus('valid')
      setExpiresAt(session.expires_at || null)
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) {
        acceptSession(session)
      }
    })

    ;(async () => {
      try {
        const { data, error: getSessionError } = await supabase.auth.getSession()
        if (cancelled) return
        if (getSessionError) {
          console.error('getSession failed while validating reset link:', getSessionError)
          setLinkStatus('invalid')
          return
        }
        if (data?.session) {
          acceptSession(data.session)
          return
        }
        // Give the URL parser a brief moment before giving up.
        fallbackTimer = setTimeout(async () => {
          if (cancelled) return
          try {
            const { data: retry, error: retryError } = await supabase.auth.getSession()
            if (cancelled) return
            if (retryError || !retry?.session) {
              if (retryError) console.error('getSession retry failed:', retryError)
              setLinkStatus('invalid')
              return
            }
            acceptSession(retry.session)
          } catch (err) {
            if (cancelled) return
            console.error('Unexpected error validating reset link:', err)
            setLinkStatus('invalid')
          }
        }, 1500)
      } catch (err) {
        if (cancelled) return
        console.error('Unexpected error validating reset link:', err)
        setLinkStatus('invalid')
      }
    })()

    return () => {
      cancelled = true
      if (fallbackTimer) clearTimeout(fallbackTimer)
      subscription?.unsubscribe()
    }
  }, [])

  // --- Live countdown of the recovery session's remaining lifetime --------
  // This is the actual JWT expiry (`expires_at`, a unix timestamp on the
  // access token Supabase issued for this recovery session) — not a fixed
  // client-side timer, so it stays accurate even if this tab was idle in
  // the background for a while. If it reaches zero, the session really is
  // gone, so we flip back to the "invalid" state rather than let someone
  // submit a form that's guaranteed to fail.
  useEffect(() => {
    if (!expiresAt) return

    function tick() {
      const remaining = expiresAt - Math.floor(Date.now() / 1000)
      setSecondsLeft(Math.max(0, remaining))
      if (remaining <= 0) {
        setLinkStatus('invalid')
      }
    }

    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [expiresAt])

  // --- Redirect countdown after a successful reset -------------------------
  useEffect(() => {
    if (!success) return
    if (redirectSeconds <= 0) {
      navigate('/login', { replace: true })
      return
    }
    const t = setTimeout(() => setRedirectSeconds((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [success, redirectSeconds, navigate])

  const { isValid: policyMet } = evaluatePassword(newPassword)
  const passwordsTyped = newPassword.length > 0 && confirmPassword.length > 0
  const passwordsMatch = newPassword === confirmPassword
  const canSubmit = policyMet && passwordsTyped && passwordsMatch && !loading && isOnline

  // Leaving the flow via a nav link, rather than through a successful
  // submit, still needs to tear down the recovery-session flag — a
  // successful submit clears it via signOut() below, but every other exit
  // path from this page has to do it explicitly or the flag can outlive
  // the session it describes for the rest of this tab's life.
  function leaveWithoutSubmitting() {
    clearRecoverySessionActive()
    navigate('/login')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (submittingRef.current) return

    if (!policyMet) {
      setError('Your password doesn\u2019t meet all the requirements yet.')
      setShakeTick((t) => t + 1)
      return
    }
    if (!passwordsMatch) {
      setError('Passwords don\u2019t match.')
      setShakeTick((t) => t + 1)
      return
    }
    if (!isOnline) {
      setError('You appear to be offline. Reconnect and try again.')
      setShakeTick((t) => t + 1)
      return
    }

    submittingRef.current = true
    setError('')
    setLoading(true)

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })

      if (updateError) {
        setError(friendlyUpdateError(updateError.message))
        setShakeTick((t) => t + 1)
        if (/expired|invalid|session/i.test(updateError.message || '')) {
          setLinkStatus('invalid')
        }
        return
      }

      // Password changed. Tear down this recovery session (local scope
      // only — see Login.jsx for why global signOut is the wrong default
      // here) so the only way back into the portal is a fresh sign-in
      // with the new password, through the normal password + OTP flow.
      // Wrapped in its own try/catch: even if this call fails, the
      // password update itself already succeeded, so the user still
      // needs to see success — clearRecoverySessionActive() as a
      // fallback guarantees the flag doesn't linger even if signOut
      // itself errors.
      try {
        await supabase.auth.signOut({ scope: 'local' })
      } catch (signOutErr) {
        console.error('signOut after password reset failed:', signOutErr)
        clearRecoverySessionActive()
      }

      setNewPassword('')
      setConfirmPassword('')
      setSuccess(true)
    } catch (err) {
      console.error('Unexpected error updating password:', err)
      setError(friendlyUpdateError(err?.message))
      setShakeTick((t) => t + 1)
    } finally {
      setLoading(false)
      submittingRef.current = false
    }
  }

  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-gray-50 px-4 py-10 sm:px-6 sm:py-12 lg:px-8">
      <MotionStyles />

      <Card className="csba-rise relative w-full max-w-md overflow-hidden border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_rgba(15,23,42,0.08)]">
        <div className="flex h-1 w-full overflow-hidden bg-gray-100">
          <div className="csba-accent h-full w-full bg-teal-600" />
        </div>

        {!isOnline && linkStatus === 'valid' && !success && (
          <div className="flex items-center justify-center gap-2 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-700">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            You're offline — reconnect to continue.
          </div>
        )}

        <CardHeader className="items-center space-y-3 pt-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-50 text-teal-600">
            {success ? (
              <CheckCircle2 className="csba-pop h-7 w-7" />
            ) : (
              <Lock className="h-7 w-7" />
            )}
          </div>
          <div className="space-y-1">
            <CardTitle className="text-2xl font-bold tracking-tight text-teal-800">
              {success
                ? 'Password updated'
                : linkStatus === 'invalid'
                ? 'Link expired'
                : 'Set a new password'}
            </CardTitle>
            <CardDescription className="text-sm text-gray-500">
              {success &&
                `Redirecting you to sign in\u2026 (${redirectSeconds}s)`}
              {!success &&
                linkStatus === 'valid' &&
                'Choose a strong password you haven\u2019t used before on this account.'}
              {!success &&
                linkStatus === 'invalid' &&
                'This reset link is no longer valid. Request a new one from the sign-in page.'}
              {!success && linkStatus === 'checking' && 'Verifying your reset link\u2026'}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="px-6 pb-8 sm:px-8">
          {linkStatus === 'checking' && !success && (
            <div className="flex justify-center py-6">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
            </div>
          )}

          {linkStatus === 'invalid' && !success && (
            <div className="csba-rise flex flex-col gap-4">
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Reset links are only valid for a short time and can only be used once. If
                  yours expired or was already used, request a fresh one.
                </p>
              </div>
              <Button
                type="button"
                onClick={leaveWithoutSubmitting}
                className="h-11 w-full bg-teal-600 text-base font-medium text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md focus-visible:ring-teal-500 active:translate-y-0 sm:text-sm"
              >
                Back to sign in
              </Button>
            </div>
          )}

          {linkStatus === 'valid' && !success && (
            <form onSubmit={handleSubmit} noValidate className="csba-rise flex flex-col gap-4">
              {secondsLeft !== null && (
                <div
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium',
                    secondsLeft <= 60 ? 'text-amber-700' : 'text-gray-400'
                  )}
                >
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  This link expires in {formatCountdown(secondsLeft)}
                </div>
              )}

              <PasswordField
                id="new-password"
                label="New password"
                value={newPassword}
                onChange={setNewPassword}
                onKeyUp={(e) =>
                  setCapsLockOn(e.getModifierState ? e.getModifierState('CapsLock') : false)
                }
                autoFocus
              />

              <PasswordStrengthMeter password={newPassword} />

              <PasswordField
                id="confirm-password"
                label="Confirm new password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                error={
                  confirmPassword.length > 0 && !passwordsMatch ? 'Passwords don\u2019t match.' : ''
                }
                rightAdornment={
                  passwordsTyped && passwordsMatch ? (
                    <span className="csba-pop flex items-center gap-1 text-xs font-medium text-teal-700">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Match
                    </span>
                  ) : null
                }
              />

              {capsLockOn && (
                <p className="csba-rise -mt-2 flex items-center gap-1 text-xs text-orange-600">
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  Caps Lock is on
                </p>
              )}

              {error && (
                <div
                  key={`error-${shakeTick}`}
                  role="alert"
                  aria-live="assertive"
                  className="csba-shake flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <p>{error}</p>
                </div>
              )}

              <Button
                type="submit"
                disabled={!canSubmit}
                aria-busy={loading}
                className="mt-1 h-11 w-full bg-teal-600 text-base font-medium text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md focus-visible:ring-teal-500 active:translate-y-0 active:scale-[0.99] disabled:translate-y-0 disabled:opacity-60 disabled:shadow-sm sm:text-sm"
              >
                {loading ? 'Updating\u2026' : 'Update password'}
              </Button>

              <button
                type="button"
                onClick={leaveWithoutSubmitting}
                className="flex items-center justify-center gap-1 text-center text-sm font-medium text-gray-500 transition-colors hover:text-gray-700"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to sign in
              </button>
            </form>
          )}

          {success && (
            <div className="csba-rise flex flex-col gap-4">
              <div className="flex items-start gap-2 rounded-md border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  For your security, you'll need to sign in again with your new password —
                  including a fresh email verification code.
                </p>
              </div>
              <Button
                type="button"
                onClick={() => navigate('/login', { replace: true })}
                className="h-11 w-full bg-teal-600 text-base font-medium text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md focus-visible:ring-teal-500 active:translate-y-0 sm:text-sm"
              >
                Sign in now
              </Button>
            </div>
          )}

          <p className="mt-8 flex items-center justify-center gap-1.5 text-center text-[11px] text-gray-400">
            <ShieldCheck className="h-3 w-3" />
            Reset links are single-use and expire automatically.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}