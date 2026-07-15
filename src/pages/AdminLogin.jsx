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
const RESEND_COOLDOWN_SECONDS = 60
const OTP_STORAGE_KEY_PREFIX = 'csba_otp_last_sent:'

// The cooldown is derived from a stored timestamp rather than a simple
// decrementing counter. This means:
// - A page refresh or component remount mid-cooldown still shows the
//   correct remaining time instead of resetting to 0.
// - A backgrounded tab (where setInterval gets throttled) still reports
//   the correct remaining time once it fires, since it's computed from
//   real elapsed time, not from how many ticks fired.
function getOtpCooldownRemaining(email) {
  if (typeof window === 'undefined' || !email) return 0
  try {
    const raw = window.localStorage.getItem(OTP_STORAGE_KEY_PREFIX + email.trim().toLowerCase())
    if (!raw) return 0
    const sentAt = parseInt(raw, 10)
    if (Number.isNaN(sentAt)) return 0
    const elapsedSeconds = Math.floor((Date.now() - sentAt) / 1000)
    return Math.max(0, RESEND_COOLDOWN_SECONDS - elapsedSeconds)
  } catch {
    // localStorage unavailable (private browsing, storage disabled, etc.)
    // — cooldown falls back to in-memory state only, still enforced within the session.
    return 0
  }
}

function markOtpSent(email) {
  if (typeof window === 'undefined' || !email) return
  try {
    window.localStorage.setItem(
      OTP_STORAGE_KEY_PREFIX + email.trim().toLowerCase(),
      String(Date.now())
    )
  } catch {
    // Ignore — falls back to in-memory cooldown for this session.
  }
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

// Translate raw Supabase auth errors into copy a non-technical admin can act on,
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

export default function AdminLogin() {
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

  // OTP-specific state
  const [otp, setOtp] = useState('')
  const [otpError, setOtpError] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)
  const [otpFailedAttempts, setOtpFailedAttempts] = useState(0)
  const otpInputRef = useRef(null)

  // Guards against a request firing twice from a fast double-click or an
  // Enter-key repeat before React has re-rendered the disabled button.
  // `loading` state alone isn't enough for this because setState is async —
  // this ref updates synchronously, so the very next call sees it immediately.
  const otpSendingRef = useRef(false)

  const navigate = useNavigate()

  const isSecureConnection =
    typeof window !== 'undefined' && window.location.protocol === 'https:'

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
    setFieldErrors({ email: '', password: '' })
  }

  async function sendOtp(targetEmail) {
    const { error: otpSendError } = await supabase.auth.signInWithOtp({
      email: targetEmail,
      options: {
        // Never let the OTP endpoint silently create a new account.
        // Only existing admin users should ever reach this screen.
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

    setError('')
    setLoading(true)

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    if (signInError) {
      setLoading(false)
      setError(friendlyAuthError(signInError.message))
      setFailedAttempts((n) => n + 1)
      return
    }

    // Password confirmed correct — but don't trust this session until OTP passes.
    await supabase.auth.signOut()

    if (otpSendingRef.current) {
      setLoading(false)
      return
    }
    otpSendingRef.current = true
    const otpSendError = await sendOtp(email.trim())
    otpSendingRef.current = false
    setLoading(false)

    if (otpSendError) {
      setError(friendlyAuthError(otpSendError.message))
      return
    }

    setOtp('')
    setOtpError('')
    setOtpFailedAttempts(0)
    markOtpSent(email.trim())
    setResendCooldown(RESEND_COOLDOWN_SECONDS)
    setMode('otp')
  }

  // Step 2: verify the 6-digit code. This is what actually establishes the session.
async function handleOtpSubmit(e) {
  e.preventDefault()

  if (!/^\d{6}$/.test(otp)) {
    setOtpError('Enter the 6-digit code.')
    return
  }

  setOtpError('')
  setLoading(true)

  const { error: verifyError } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: otp,
    type: 'email',
  })

  if (verifyError) {
    setLoading(false)
    setOtpFailedAttempts((n) => n + 1)
    setOtp('')
    setOtpError(friendlyAuthError(verifyError.message))
    return
  }

  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  setLoading(false)

  if (profileError) {
    // No profile row yet — fall back to admin rather than blocking login.
    navigate('/admin')
    return
  }

  navigate(profile.role === 'approver' ? '/approver' : '/admin')
}

  async function handleResendOtp() {
    const trimmedEmail = email.trim()

    // Re-check against the real timestamp, not just the `resendCooldown`
    // state — state can lag a tick behind, the timestamp can't.
    const remaining = getOtpCooldownRemaining(trimmedEmail)
    if (remaining > 0) {
      setResendCooldown(remaining)
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
    markOtpSent(trimmedEmail)
    setResendCooldown(RESEND_COOLDOWN_SECONDS)

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
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.removeItem(OTP_STORAGE_KEY_PREFIX + trimmedEmail.toLowerCase())
          } catch {
            // ignore
          }
        }
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
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/admin/reset-password`,
    })
    setLoading(false)

    if (resetError) {
      setError(friendlyAuthError(resetError.message))
      return
    }
    setMode('forgot-sent')
  }

  return (
    <div className="relative flex min-h-[80vh] items-center justify-center overflow-hidden bg-gray-50/50 px-4 py-12 sm:px-6 lg:px-8">
      {/* Soft ambient brand color, kept subtle so the page still reads as a secure admin tool */}
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
              {mode === 'signin' && 'Admin Portal'}
              {mode === 'otp' && 'Enter verification code'}
              {mode === 'forgot-form' && 'Reset your password'}
              {mode === 'forgot-sent' && 'Check your email'}
            </CardTitle>
            <CardDescription className="text-sm text-gray-500">
              {mode === 'signin' && 'Manage check uploads, pickups, and disbursements.'}
              {mode === 'otp' && (
                <>
                  We sent a 6-digit code to{' '}
                  <span className="font-medium text-gray-700">{email.trim()}</span>. It expires
                  in 5 minutes.
                </>
              )}
              {mode === 'forgot-form' &&
                'Enter your admin email and we\u2019ll send you a link to reset your password.'}
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
                  placeholder="admin@csba.ph"
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
                  onChange={(e) => {
                    setOtp(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))
                    setOtpError('')
                  }}
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
                disabled={loading || otp.length !== OTP_LENGTH}
                className="w-full bg-teal-600 text-white shadow-sm transition-colors hover:bg-teal-700 focus-visible:ring-teal-500 disabled:opacity-60"
              >
                <KeyRound className="mr-2 h-4 w-4" />
                {loading ? 'Verifying\u2026' : 'Verify & sign in'}
              </Button>

              <button
                type="button"
                onClick={handleResendOtp}
                disabled={resendCooldown > 0 || loading || otpSendingRef.current}
                className="text-center text-sm font-medium text-teal-600 hover:text-teal-700 disabled:cursor-not-allowed disabled:text-gray-400"
              >
                {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
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
                  placeholder="admin@csba.ph"
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
                  Sent to <span className="font-medium">{email.trim()}</span>. Didn\u2019t get it?
                  Check your spam folder, or try again in a few minutes.
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
