// src/pages/Login.jsx
//
// Single shared login page for every role, mounted once at /login (see
// App.jsx). Same form for admin, verifier, and approver accounts — after
// auth, where they're SENT is decided entirely by their actual
// profiles.role, read from the database, never by anything in the URL or
// form. RequireRole still gates every protected route on the real role.
import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Lock,
  ShieldCheck,
  AlertCircle,
  Eye,
  EyeOff,
  Mail,
  CheckCircle2,
  KeyRound,
  ArrowLeft,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { cn } from '../lib/utils'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const OTP_LENGTH = 6
const BASE_RESEND_COOLDOWN_SECONDS = 60
const MAX_RESEND_COOLDOWN_SECONDS = 300
const MAX_RESENDS_BEFORE_SOFT_LOCK = 6
const RESEND_STATE_RESET_MS = 30 * 60 * 1000 // resend-count backoff resets after 30 min of inactivity

const OTP_STATE_STORAGE_KEY_PREFIX = 'csba_verifier_otp_state:'

// ---------------------------------------------------------------------------
// Resend state: { lastSentAt: number, count: number }
// Stored per-email so the exponential backoff and soft-lock survive page
// refreshes, remounts, and throttled background tabs (computed from real
// elapsed time, never from a ticking counter).
// ---------------------------------------------------------------------------
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase()
}

function getOtpResendState(email) {
  if (typeof window === 'undefined' || !email) return { lastSentAt: 0, count: 0 }
  try {
    const raw = window.localStorage.getItem(OTP_STATE_STORAGE_KEY_PREFIX + normalizeEmail(email))
    if (!raw) return { lastSentAt: 0, count: 0 }
    const parsed = JSON.parse(raw)
    if (typeof parsed.lastSentAt !== 'number') return { lastSentAt: 0, count: 0 }
    // Backoff resets after a long enough gap — an old lockout shouldn't
    // haunt someone who legitimately comes back the next day.
    if (Date.now() - parsed.lastSentAt > RESEND_STATE_RESET_MS) {
      return { lastSentAt: 0, count: 0 }
    }
    return { lastSentAt: parsed.lastSentAt, count: parsed.count || 0 }
  } catch {
    return { lastSentAt: 0, count: 0 }
  }
}

function markOtpSent(email) {
  if (typeof window === 'undefined' || !email) return
  const prev = getOtpResendState(email)
  const next = { lastSentAt: Date.now(), count: prev.count + 1 }
  try {
    window.localStorage.setItem(
      OTP_STATE_STORAGE_KEY_PREFIX + normalizeEmail(email),
      JSON.stringify(next)
    )
  } catch {
    // Ignore — falls back to in-memory cooldown for this session.
  }
  return next
}

function clearOtpResendState(email) {
  if (typeof window === 'undefined' || !email) return
  try {
    window.localStorage.removeItem(OTP_STATE_STORAGE_KEY_PREFIX + normalizeEmail(email))
  } catch {
    // ignore
  }
}

// Doubles the wait after every resend (60s, 120s, 240s, ...) capped at 5 min,
// instead of a flat 60s. Slows down anyone trying to hammer the OTP endpoint
// while still being tolerable for a genuine user who fat-fingered an inbox check.
function cooldownForCount(count) {
  if (count <= 0) return 0
  const seconds = BASE_RESEND_COOLDOWN_SECONDS * Math.pow(2, count - 1)
  return Math.min(seconds, MAX_RESEND_COOLDOWN_SECONDS)
}

function getOtpCooldownRemaining(email) {
  const { lastSentAt, count } = getOtpResendState(email)
  if (!lastSentAt) return 0
  const elapsedSeconds = Math.floor((Date.now() - lastSentAt) / 1000)
  return Math.max(0, cooldownForCount(count) - elapsedSeconds)
}

// Single shared login for every role — same form for admin, verifier, and
// approver accounts. Which role signs in determines where they land after
// auth (see the redirect logic below); it does not affect what's shown here.
const PORTAL_LABEL = {
  title: 'Portal Login',
  description: 'Sign in to your account.',
  placeholder: 'you@csba.ph',
}

function validateEmail(value) {
  if (!value.trim()) return 'Email is required.'
  if (!EMAIL_PATTERN.test(value.trim())) return 'Enter a valid email address.'
  return ''
}

function validatePassword(value) {
  if (!value) return 'Password is required.'
  return ''
}

// Translate raw Supabase auth errors into copy a non-technical verifier can act on,
// without confirming whether a given email exists in the system.
function friendlyAuthError(message) {
  if (!message) return 'Something went wrong. Please try again.'
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) {
    return 'The email or password you entered is incorrect.'
  }
  if (m.includes('email not confirmed')) {
    return 'This email address hasn\u2019t been confirmed yet. Check your inbox for a confirmation link.'
  }
  if (m.includes('rate limit') || m.includes('too many') || m.includes('security purposes')) {
    return 'Too many attempts. Please wait a moment before trying again.'
  }
  if (m.includes('token has expired') || m.includes('invalid token') || m.includes('otp')) {
    return 'That code is invalid or has expired. Please request a new one.'
  }
  if (m.includes('network') || m.includes('fetch')) {
    return 'Network error \u2014 check your connection and try again.'
  }
  return message
}

// ---------------------------------------------------------------------------
// Optional server-side lockout hooks.
//
// These call Postgres RPCs (`check_login_lockout` / `record_login_attempt`)
// if you've deployed them (see lockout_functions.sql). If the functions
// don't exist yet, both fail open silently — the login flow behaves exactly
// as it does today. This is what makes the lockout "seamless": nothing
// breaks before you add the SQL, and you get real brute-force protection
// the moment you do.
// ---------------------------------------------------------------------------
async function checkServerLockout(email, stage) {
  try {
    const { data, error } = await supabase.rpc('check_login_lockout', {
      p_email: normalizeEmail(email),
      p_stage: stage,
    })
    if (error || !data) return { locked: false }
    return data
  } catch {
    return { locked: false }
  }
}

async function recordServerAttempt(email, stage, success) {
  try {
    await supabase.rpc('record_login_attempt', {
      p_email: normalizeEmail(email),
      p_stage: stage,
      p_success: success,
    })
  } catch {
    // Non-critical — ignore if the function isn't deployed.
  }
}

export default function Login() {
  const portal = PORTAL_LABEL

  // 'signin' | 'otp' | 'forgot-form' | 'forgot-sent'
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [capsLockOn, setCapsLockOn] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({ email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [logoError, setLogoError] = useState(false)
  const [checkingExistingSession, setCheckingExistingSession] = useState(true)

  // OTP-specific state
  const [otp, setOtp] = useState('')
  const [otpError, setOtpError] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendsExhausted, setResendsExhausted] = useState(false)
  const [otpFailedAttempts, setOtpFailedAttempts] = useState(0)
  const otpInputRef = useRef(null)

  // Guards against a request firing twice from a fast double-click or an
  // Enter-key repeat before React has re-rendered the disabled button.
  // `loading` state alone isn't enough for this because setState is async —
  // this ref updates synchronously, so the very next call sees it immediately.
  const otpSendingRef = useRef(false)
  const otpAutoSubmitRef = useRef(false)

  const navigate = useNavigate()

  const isSecureConnection =
    typeof window !== 'undefined' && window.location.protocol === 'https:'

  // If someone already has a live session and lands on this page (e.g. a
  // stale bookmark, or clicking back after signing in), send them straight
  // to their area instead of re-prompting for credentials.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      if (!data?.session) {
        setCheckingExistingSession(false)
        return
      }
      const { data: userData } = await supabase.auth.getUser()
      if (cancelled) return
      const uid = userData?.user?.id
      if (!uid) {
        setCheckingExistingSession(false)
        return
      }
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', uid)
        .maybeSingle()
      if (cancelled) return
      if (profile?.role === 'approver') navigate('/approver', { replace: true })
      else if (profile?.role === 'admin') navigate('/admin', { replace: true })
      else navigate('/verifier', { replace: true })
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Countdown for resend button — recomputed each tick from the stored
  // timestamp rather than decremented, so it stays correct across refreshes,
  // remounts, and throttled background tabs.
  useEffect(() => {
    if (mode !== 'otp' || !email) return

    const tick = () => setResendCooldown(getOtpCooldownRemaining(email))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [mode, email])

  // Autofocus the OTP field when we enter that step
  useEffect(() => {
    if (mode === 'otp' && otpInputRef.current) {
      otpInputRef.current.focus()
    }
  }, [mode])

  function goToForgotPassword() {
    setMode('forgot-form')
    setError('')
    setFieldErrors({ email: '', password: '' })
  }

  function goToSignIn() {
    setMode('signin')
    setError('')
    setOtpError('')
    setOtp('')
    setPassword('')
    setResendsExhausted(false)
    setFieldErrors({ email: '', password: '' })
  }

  async function sendOtp(targetEmail) {
    const { error: otpSendError } = await supabase.auth.signInWithOtp({
      email: targetEmail,
      options: {
        // Never let the OTP endpoint silently create a new account.
        // Only existing users (admin, verifier, or approver) should ever
        // reach this screen.
        shouldCreateUser: false,
      },
    })
    return otpSendError
  }

  // Step 1: verify password. On success, immediately drop the session
  // (signInWithPassword grants a live session token) and require a fresh
  // OTP before treating the user as authenticated.
  async function handleSubmit(e) {
    e.preventDefault()

    const emailErr = validateEmail(email)
    const passwordErr = validatePassword(password)
    setFieldErrors({ email: emailErr, password: passwordErr })
    if (emailErr || passwordErr) return

    const trimmedEmail = normalizeEmail(email)
    setError('')
    setLoading(true)

    // Fails open if no server-side lockout function has been deployed —
    // see checkServerLockout above.
    const lockout = await checkServerLockout(trimmedEmail, 'password')
    if (lockout?.locked) {
      setLoading(false)
      setError(
        lockout.retryAfterMinutes
          ? `Too many failed attempts. Try again in ${lockout.retryAfterMinutes} minute(s).`
          : 'Too many failed attempts. Please try again later.'
      )
      return
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    })

    if (signInError) {
      setLoading(false)
      setError(friendlyAuthError(signInError.message))
      setFailedAttempts((n) => n + 1)
      recordServerAttempt(trimmedEmail, 'password', false)
      return
    }

    recordServerAttempt(trimmedEmail, 'password', true)

    // Password confirmed correct — but don't trust this session until OTP passes.
    await supabase.auth.signOut()
    setPassword('')

    if (otpSendingRef.current) {
      setLoading(false)
      return
    }
    otpSendingRef.current = true
    const otpSendError = await sendOtp(trimmedEmail)
    otpSendingRef.current = false
    setLoading(false)

    if (otpSendError) {
      setError(friendlyAuthError(otpSendError.message))
      return
    }

    setOtp('')
    setOtpError('')
    setOtpFailedAttempts(0)
    setResendsExhausted(false)
    const state = markOtpSent(trimmedEmail)
    setResendCooldown(cooldownForCount(state?.count || 1))
    setMode('otp')
  }

  // Step 2: verify the 6-digit code. This is what actually establishes the session.
  async function submitOtp(code) {
    if (!/^\d{6}$/.test(code)) {
      setOtpError('Enter the 6-digit code.')
      return
    }

    const trimmedEmail = normalizeEmail(email)
    setOtpError('')
    setLoading(true)

    const lockout = await checkServerLockout(trimmedEmail, 'otp')
    if (lockout?.locked) {
      setLoading(false)
      setOtp('')
      setOtpError(
        lockout.retryAfterMinutes
          ? `Too many failed codes. Try again in ${lockout.retryAfterMinutes} minute(s).`
          : 'Too many failed codes. Please try again later.'
      )
      return
    }

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: trimmedEmail,
      token: code,
      type: 'email',
    })

    if (verifyError) {
      setLoading(false)
      setOtpFailedAttempts((n) => n + 1)
      setOtp('')
      setOtpError(friendlyAuthError(verifyError.message))
      recordServerAttempt(trimmedEmail, 'otp', false)
      return
    }

    recordServerAttempt(trimmedEmail, 'otp', true)
    clearOtpResendState(trimmedEmail)

    const { data: { user } } = await supabase.auth.getUser()
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    setLoading(false)

    if (profileError) {
      // No profile row yet — fall back to verifier rather than blocking login.
      navigate('/verifier')
      return
    }

    if (profile.role === 'approver') navigate('/approver')
    else if (profile.role === 'admin') navigate('/admin')
    else navigate('/verifier')
  }

  function handleOtpSubmit(e) {
    e.preventDefault()
    submitOtp(otp)
  }

  // Handles both typing and pasting a 6-digit code. When the field reaches
  // full length, auto-submits instead of making the user hit Enter —
  // otpAutoSubmitRef prevents a double-fire if onChange runs twice in the
  // same tick (React 18 batching + a paste event can do this).
  function handleOtpChange(e) {
    const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH)
    setOtp(digitsOnly)
    setOtpError('')
    if (digitsOnly.length === OTP_LENGTH && !otpAutoSubmitRef.current) {
      otpAutoSubmitRef.current = true
      submitOtp(digitsOnly).finally(() => {
        otpAutoSubmitRef.current = false
      })
    }
  }

  async function handleResendOtp() {
    const trimmedEmail = normalizeEmail(email)

    // Re-check against the real timestamp, not just the `resendCooldown`
    // state — state can lag a tick behind, the timestamp can't.
    const remaining = getOtpCooldownRemaining(trimmedEmail)
    if (remaining > 0) {
      setResendCooldown(remaining)
      return
    }

    const { count } = getOtpResendState(trimmedEmail)
    if (count >= MAX_RESENDS_BEFORE_SOFT_LOCK) {
      setResendsExhausted(true)
      setOtpError('Too many code requests. Please go back and sign in again in a few minutes.')
      return
    }

    // Synchronous lock: blocks a second click that lands before React
    // re-renders the disabled button (e.g. a fast double-click or an
    // Enter-key repeat). `loading` state can't catch this because the
    // state update from the first click hasn't been committed yet.
    if (loading || otpSendingRef.current) return
    otpSendingRef.current = true

    setOtpError('')
    setLoading(true)

    // Reserve the cooldown window immediately, before the network call
    // resolves. This closes the gap where two rapid resend clicks could
    // both slip through while the first request is still in flight.
    const reserved = markOtpSent(trimmedEmail)
    setResendCooldown(cooldownForCount(reserved?.count || 1))

    const otpSendError = await sendOtp(trimmedEmail)

    setLoading(false)
    otpSendingRef.current = false

    if (otpSendError) {
      setOtpError(friendlyAuthError(otpSendError.message))

      // Only release the reserved cooldown for genuine local failures
      // (e.g. the request never reached Supabase). If Supabase itself
      // rejected the request for rate-limit reasons, keep the cooldown
      // running — releasing it would let the person immediately hammer
      // the endpoint again and just collect more rate-limit errors.
      const m = (otpSendError.message || '').toLowerCase()
      const isLocalFailure = m.includes('network') || m.includes('fetch')
      if (isLocalFailure) {
        clearOtpResendState(trimmedEmail)
        setResendCooldown(0)
      }
      return
    }

    setOtp('')
  }

  async function handleForgotSubmit(e) {
    e.preventDefault()

    const emailErr = validateEmail(email)
    setFieldErrors((f) => ({ ...f, email: emailErr }))
    if (emailErr) return

    setError('')
    setLoading(true)
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      normalizeEmail(email),
      // Shared across all three portals — you'll need a /reset-password
      // route/page wired up (not part of what I've seen of your app so
      // far) since it's no longer scoped under /verifier.
      { redirectTo: `${window.location.origin}/reset-password` }
    )
    setLoading(false)

    if (resetError) {
      setError(friendlyAuthError(resetError.message))
      return
    }
    setMode('forgot-sent')
  }

  if (checkingExistingSession) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="relative flex min-h-[80vh] items-center justify-center overflow-hidden bg-gray-50/50 px-4 py-12 sm:px-6 lg:px-8">
      {/* Soft ambient brand color, kept subtle so the page still reads as a secure tool */}
      <div className="pointer-events-none absolute -top-24 -left-24 h-72 w-72 rounded-full bg-teal-200/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-72 w-72 rounded-full bg-orange-200/25 blur-3xl" />

      <Card className="relative w-full max-w-md overflow-hidden border-0 shadow-xl sm:border sm:border-gray-100">
        {/* Brand accent line, teal-to-orange, at the top of the card */}
        <div className="h-1.5 w-full bg-gradient-to-r from-teal-600 via-teal-500 to-orange-500" />

        <CardHeader className="items-center space-y-4 pt-8 text-center">
          <div className="flex flex-col items-center justify-center gap-3">
            {!logoError ? (
              <img
                src="https://csba.ph/logo.png"
                alt="CSBA logo"
                className="h-32 w-32 object-contain drop-shadow-sm"
                onError={() => setLogoError(true)}
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-600 text-base font-bold tracking-wide text-white">
                CSBA
              </div>
            )}
          </div>

          <div className="space-y-1">
            <CardTitle className="text-2xl font-bold tracking-tight text-teal-800">
              {mode === 'signin' && portal.title}
              {mode === 'otp' && 'Enter verification code'}
              {mode === 'forgot-form' && 'Reset your password'}
              {mode === 'forgot-sent' && 'Check your email'}
            </CardTitle>
            <CardDescription className="text-sm text-gray-500">
              {mode === 'signin' && portal.description}
              {mode === 'otp' && (
                <>
                  We sent a 6-digit code to{' '}
                  <span className="font-medium text-gray-700">{normalizeEmail(email)}</span>. It
                  expires in 5 minutes.
                </>
              )}
              {mode === 'forgot-form' &&
                'Enter your verifier email and we\u2019ll send you a link to reset your password.'}
              {mode === 'forgot-sent' &&
                'If an account exists for that address, a reset link is on its way. It can take a few minutes to arrive.'}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="px-6 pb-8 sm:px-8">
          {mode === 'signin' && (
            <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <label htmlFor="email" className="text-sm font-medium text-gray-700">
                  Email Address
                </label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setFieldErrors((f) => ({ ...f, email: '' }))
                  }}
                  onBlur={() => setFieldErrors((f) => ({ ...f, email: validateEmail(email) }))}
                  placeholder={portal.placeholder}
                  aria-invalid={!!fieldErrors.email}
                  aria-describedby={fieldErrors.email ? 'email-error' : undefined}
                  className={cn(
                    'transition-shadow focus-visible:ring-teal-500',
                    fieldErrors.email && 'border-red-300 focus-visible:ring-red-400'
                  )}
                />
                {fieldErrors.email && (
                  <p id="email-error" className="flex items-center gap-1 text-xs text-red-600">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    {fieldErrors.email}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="password" className="text-sm font-medium text-gray-700">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={goToForgotPassword}
                    className="text-xs font-medium text-teal-600 hover:text-teal-700 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      setFieldErrors((f) => ({ ...f, password: '' }))
                    }}
                    onKeyUp={(e) =>
                      setCapsLockOn(e.getModifierState ? e.getModifierState('CapsLock') : false)
                    }
                    onBlur={() =>
                      setFieldErrors((f) => ({ ...f, password: validatePassword(password) }))
                    }
                    placeholder=""
                    aria-invalid={!!fieldErrors.password}
                    aria-describedby={fieldErrors.password ? 'password-error' : undefined}
                    className={cn(
                      'pr-10 transition-shadow focus-visible:ring-teal-500',
                      fieldErrors.password && 'border-red-300 focus-visible:ring-red-400'
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {fieldErrors.password && (
                  <p id="password-error" className="flex items-center gap-1 text-xs text-red-600">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    {fieldErrors.password}
                  </p>
                )}
                {capsLockOn && (
                  <p className="flex items-center gap-1 text-xs text-orange-600">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    Caps Lock is on
                  </p>
                )}
              </div>

              {error && (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600 animate-in fade-in slide-in-from-top-1"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <p>{error}</p>
                </div>
              )}

              {failedAttempts >= 3 && (
                <div className="flex items-start gap-2 rounded-md border border-teal-200 bg-teal-50 p-3 text-xs text-teal-800">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p>
                    Still having trouble signing in?{' '}
                    <button
                      type="button"
                      onClick={goToForgotPassword}
                      className="font-medium underline hover:text-teal-900"
                    >
                      Reset your password
                    </button>{' '}
                    or double-check for typos in your email.
                  </p>
                </div>
              )}

              <Button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className="mt-2 w-full bg-teal-600 text-white shadow-sm transition-colors hover:bg-teal-700 focus-visible:ring-teal-500 disabled:opacity-60"
              >
                {loading ? 'Signing in\u2026' : 'Sign in'}
              </Button>
            </form>
          )}

          {mode === 'otp' && (
            <form onSubmit={handleOtpSubmit} noValidate className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <label htmlFor="otp" className="text-sm font-medium text-gray-700">
                  Verification code
                </label>
                <Input
                  id="otp"
                  name="otp"
                  ref={otpInputRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={OTP_LENGTH}
                  value={otp}
                  onChange={handleOtpChange}
                  disabled={loading || resendsExhausted}
                  placeholder="123456"
                  aria-invalid={!!otpError}
                  aria-describedby={otpError ? 'otp-error' : undefined}
                  className={cn(
                    'text-center text-lg tracking-[0.5em] transition-shadow focus-visible:ring-teal-500',
                    otpError && 'border-red-300 focus-visible:ring-red-400'
                  )}
                />
                {otpError && (
                  <p id="otp-error" className="flex items-center gap-1 text-xs text-red-600">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    {otpError}
                  </p>
                )}
              </div>

              {otpFailedAttempts >= 3 && (
                <div className="flex items-start gap-2 rounded-md border border-teal-200 bg-teal-50 p-3 text-xs text-teal-800">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p>
                    Still not working? Make sure you're using the most recent code sent to your
                    inbox, or request a new one below.
                  </p>
                </div>
              )}

              <Button
                type="submit"
                disabled={loading || otp.length !== OTP_LENGTH || resendsExhausted}
                aria-busy={loading}
                className="w-full bg-teal-600 text-white shadow-sm transition-colors hover:bg-teal-700 focus-visible:ring-teal-500 disabled:opacity-60"
              >
                <KeyRound className="mr-2 h-4 w-4" />
                {loading ? 'Verifying\u2026' : 'Verify & sign in'}
              </Button>

              <button
                type="button"
                onClick={handleResendOtp}
                disabled={resendCooldown > 0 || loading || otpSendingRef.current || resendsExhausted}
                className="text-center text-sm font-medium text-teal-600 hover:text-teal-700 disabled:cursor-not-allowed disabled:text-gray-400"
              >
                {resendsExhausted
                  ? 'Too many requests \u2014 sign in again shortly'
                  : resendCooldown > 0
                  ? `Resend code in ${resendCooldown}s`
                  : 'Resend code'}
              </button>

              <button
                type="button"
                onClick={goToSignIn}
                className="flex items-center justify-center gap-1 text-center text-sm font-medium text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to sign in
              </button>
            </form>
          )}

          {mode === 'forgot-form' && (
            <form onSubmit={handleForgotSubmit} noValidate className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <label htmlFor="reset-email" className="text-sm font-medium text-gray-700">
                  Email Address
                </label>
                <Input
                  id="reset-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setFieldErrors((f) => ({ ...f, email: '' }))
                  }}
                  onBlur={() => setFieldErrors((f) => ({ ...f, email: validateEmail(email) }))}
                  placeholder={portal.placeholder}
                  aria-invalid={!!fieldErrors.email}
                  aria-describedby={fieldErrors.email ? 'reset-email-error' : undefined}
                  className={cn(
                    'transition-shadow focus-visible:ring-teal-500',
                    fieldErrors.email && 'border-red-300 focus-visible:ring-red-400'
                  )}
                />
                {fieldErrors.email && (
                  <p id="reset-email-error" className="flex items-center gap-1 text-xs text-red-600">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    {fieldErrors.email}
                  </p>
                )}
              </div>

              {error && (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600 animate-in fade-in slide-in-from-top-1"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <p>{error}</p>
                </div>
              )}

              <Button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className="mt-2 w-full bg-teal-600 text-white shadow-sm transition-colors hover:bg-teal-700 focus-visible:ring-teal-500 disabled:opacity-60"
              >
                <Mail className="mr-2 h-4 w-4" />
                {loading ? 'Sending link\u2026' : 'Send reset link'}
              </Button>

              <button
                type="button"
                onClick={goToSignIn}
                className="text-center text-sm font-medium text-gray-500 hover:text-gray-700"
              >
                Back to sign in
              </button>
            </form>
          )}

          {mode === 'forgot-sent' && (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-2 rounded-md border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Sent to <span className="font-medium">{normalizeEmail(email)}</span>. Didn\u2019t
                  get it? Check your spam folder, or try again in a few minutes.
                </p>
              </div>
              <Button
                type="button"
                onClick={goToSignIn}
                className="w-full bg-teal-600 text-white shadow-sm transition-colors hover:bg-teal-700 focus-visible:ring-teal-500"
              >
                Back to sign in
              </Button>
            </div>
          )}

          <p className="mt-8 text-center text-xs text-gray-400">
            Authorized personnel only. Accounts are managed by CSBA.
          </p>
          {isSecureConnection && (
            <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-gray-400">
              <Lock className="h-3 w-3" />
              Connection encrypted
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}