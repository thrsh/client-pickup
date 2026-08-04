// src/pages/Login.jsx
//
// Single shared login page for every role, mounted once at /login (see
// App.jsx). Same form for admin, verifier, and approver accounts — after
// auth, where they're SENT is decided entirely by their actual
// profiles.role, read from the database, never by anything in the URL or
// form. RequireRole still gates every protected route on the real role.
//
// v4 — layout + session-security pass:
//  - Split brand/form layout on larger screens (single column on mobile),
//    so the trust signals (2FA, RA 10173, role-based access) get real
//    visual space instead of being crammed into the card footer.
//  - Session lifetime is now tab-scoped: see the storage strategy comment
//    in ../lib/supabaseClient.js. Close the tab (or the browser) and the
//    next visit requires signing in again — there is nothing to configure
//    here in Login.jsx for that, it's a property of the Supabase client
//    itself, which is the correct place for it to live.
//  - FIXED: the password-verification session (thrown away before OTP) was
//    being closed with a bare `supabase.auth.signOut()`, which defaults to
//    `{ scope: 'global' }` and revokes EVERY session for that user — so
//    signing in on a new device was silently signing the person out of
//    their other open tabs/devices. Now scoped to `{ scope: 'local' }`.
//  - FIXED: the "check your email" screen for password reset had a raw
//    `\u2019` sitting in JSX text (not inside a string literal), so it was
//    rendering as the literal six characters `\u2019` instead of an
//    apostrophe.
//  - No gradients anywhere (solid fills only, per design direction).
//  - Deliberate motion: entrance animation on load, a mode-switch
//    transition between signin/otp/forgot, a shake on validation failure,
//    a segmented animated OTP input, and consistent hover/press states.
//  - Mandatory Data Privacy Act (RA 10173) + Terms & Conditions consent.
//  - "Remember my email" (client-side only — never remembers a password),
//    offline detection, in-app policy preview sheet.
//  - prefers-reduced-motion is respected — all decorative animation is
//    disabled for people who've asked their OS for that.
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
  Check,
  X,
  WifiOff,
  FileText,
  ShieldAlert,
  Fingerprint,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { cn } from '../lib/utils'
import { recordLogin } from '../lib/adminAuditApi'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const OTP_LENGTH = 6
const BASE_RESEND_COOLDOWN_SECONDS = 60
const MAX_RESEND_COOLDOWN_SECONDS = 300
const MAX_RESENDS_BEFORE_SOFT_LOCK = 6
const RESEND_STATE_RESET_MS = 30 * 60 * 1000 // resend-count backoff resets after 30 min of inactivity

const OTP_STATE_STORAGE_KEY_PREFIX = 'csba_verifier_otp_state:'
const REMEMBERED_EMAIL_KEY = 'csba_remembered_email'

// ---------------------------------------------------------------------------
// Local, scoped animation styles. Kept inline so this component doesn't
// depend on custom keyframes being present in tailwind.config.js. All of it
// is solid-color motion — no gradients — and every rule is neutralized
// under prefers-reduced-motion.
// ---------------------------------------------------------------------------
function MotionStyles() {
  return (
    <style>{`
      @keyframes csba-float {
        0%, 100% { transform: translate(0, 0); }
        50% { transform: translate(10px, -14px); }
      }
      @keyframes csba-accent-grow {
        from { transform: scaleX(0); }
        to { transform: scaleX(1); }
      }
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
      .csba-float { animation: csba-float 10s ease-in-out infinite; }
      .csba-accent { transform-origin: left center; animation: csba-accent-grow 600ms cubic-bezier(0.16,1,0.3,1) both; }
      .csba-shake { animation: csba-shake 480ms cubic-bezier(.36,.07,.19,.97) both; }
      .csba-pop { animation: csba-pop 220ms cubic-bezier(0.34,1.56,0.64,1) both; }
      .csba-rise { animation: csba-rise 420ms cubic-bezier(0.16,1,0.3,1) both; }
      @media (prefers-reduced-motion: reduce) {
        .csba-float, .csba-accent, .csba-shake, .csba-pop, .csba-rise {
          animation: none !important;
        }
      }
    `}</style>
  )
}

// ---------------------------------------------------------------------------
// Resend state: { lastSentAt: number, count: number }
// Stored per-email so the exponential backoff and soft-lock survive page
// refreshes, remounts, and throttled background tabs (computed from real
// elapsed time, never from a ticking counter).
//
// NOTE: this deliberately still uses localStorage, not sessionStorage. It
// holds no session/identity material — just "how many OTP resends has this
// email address asked for recently" — and it needs to survive exactly the
// tab-close/reopen case that the auth session itself should NOT survive, or
// someone could dodge the resend cooldown just by opening a new tab.
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

function getRememberedEmail() {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(REMEMBERED_EMAIL_KEY) || ''
  } catch {
    return ''
  }
}

function setRememberedEmail(email) {
  if (typeof window === 'undefined') return
  try {
    if (email) {
      window.localStorage.setItem(REMEMBERED_EMAIL_KEY, normalizeEmail(email))
    } else {
      window.localStorage.removeItem(REMEMBERED_EMAIL_KEY)
    }
  } catch {
    // ignore — non-critical convenience feature
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
  title: 'Check Releasing Portal',
  description: 'Sign in to manage your check releasing workflow.',
  placeholder: 'you@csba.ph',
}

// Trust signals shown on the brand panel. Each one names an actual
// property of this login flow (not decoration) — someone reading it
// should learn something true about how the portal protects their account.
const TRUST_POINTS = [
  {
    icon: KeyRound,
    title: 'Two-step verification',
    description: 'Every sign-in needs your password and a one-time code sent to your email.',
  },
  {
    icon: Fingerprint,
    title: 'Role-based access',
    description: 'Every check moves through verifier and approver sign-off before it is released.',
  },
  {
    icon: ShieldAlert,
    title: 'RA 10173 compliant',
    description: 'Your data is handled under the Data Privacy Act of 2012.',
  },
]

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

// ---------------------------------------------------------------------------
// Legal copy for the in-app preview sheet. Placeholder body text — swap in
// your actual DPO-approved Data Privacy Notice and Terms & Conditions before
// shipping. Kept as plain components so the sheet can render either without
// a network round trip (and without ever blocking sign-in on a fetch).
// ---------------------------------------------------------------------------
function DataPrivacyNoticeBody() {
  return (
    <>
      <p>
        CSBA collects and processes the personal data you provide on this portal (name, email
        address, role, and login activity) solely to authenticate your identity, maintain audit
        records, and administer your account.
      </p>
      <p>
        Your data is processed in accordance with the Data Privacy Act of 2012 (Republic Act No.
        10173) and its Implementing Rules and Regulations. It is retained only for as long as
        necessary for these purposes, stored with administrative and technical safeguards, and
        never sold or shared with third parties for marketing purposes.
      </p>
      <p>
        You may request access to, correction of, or deletion of your personal data, subject to
        our recordkeeping obligations, by contacting the Data Protection Officer.
      </p>
    </>
  )
}

function TermsOfUseBody() {
  return (
    <>
      <p>
        Access to this portal is limited to authorized CSBA personnel. Your account credentials
        are personal to you — do not share your password or verification codes with anyone,
        including colleagues or support staff.
      </p>
      <p>
        You agree to use this system only for its intended administrative purpose, to keep your
        account information accurate, and to report any suspected unauthorized access
        immediately.
      </p>
      <p>
        Login activity, including timestamps and general device information, is logged for
        security auditing. Misuse of this system may result in account suspension and further
        action under applicable law.
      </p>
    </>
  )
}

// Bottom-sheet on mobile, centered dialog on larger screens. Self-contained
// (no external dialog dependency) so it works regardless of which shadcn
// primitives are already generated in this project.
function NoticeSheet({ notice, onClose }) {
  const closeButtonRef = useRef(null)

  useEffect(() => {
    if (!notice) return
    closeButtonRef.current?.focus()
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [notice, onClose])

  if (!notice) return null

  const title = notice === 'privacy' ? 'Data Privacy Notice' : 'Terms & Conditions of Use'
  const Icon = notice === 'privacy' ? ShieldAlert : FileText

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-gray-900/50 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="notice-sheet-title"
      onClick={onClose}
    >
      <div
        className="animate-in slide-in-from-bottom-6 sm:zoom-in-95 sm:slide-in-from-bottom-0 flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl duration-200 sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-gray-200 sm:hidden" />

        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-gray-100 px-5 pb-4 pt-3 sm:px-6 sm:pt-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
              <Icon className="h-4 w-4" />
            </div>
            <h3 id="notice-sheet-title" className="text-base font-semibold text-gray-900">
              {title}
            </h3>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
            aria-label="Close"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed text-gray-600 sm:px-6 sm:py-5">
          {notice === 'privacy' ? <DataPrivacyNoticeBody /> : <TermsOfUseBody />}
        </div>

        <div className="shrink-0 border-t border-gray-100 px-5 py-4 sm:px-6">
          <Button
            type="button"
            onClick={onClose}
            className="w-full bg-teal-600 text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md active:translate-y-0 focus-visible:ring-teal-500"
          >
            I understand
          </Button>
        </div>
      </div>
    </div>
  )
}

// Accessible, dependency-free checkbox styled to match shadcn/ui's visual
// language (rounded-md, ring-based focus state, teal fill on check, and a
// small pop when it becomes checked). Swap for ../components/ui/checkbox
// if you've already generated that primitive — the markup contract
// (checked/onChange) is the same either way.
function ConsentCheckbox({ id, checked, onChange, invalid, children }) {
  return (
    <label
      htmlFor={id}
      className="group flex cursor-pointer select-none items-start gap-3 rounded-lg p-1 -m-1 transition-colors active:bg-gray-100"
    >
      <span className="relative mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
        <input
          id={id}
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          onChange={onChange}
          aria-invalid={invalid || undefined}
        />
        <span
          className={cn(
            'h-5 w-5 rounded-md border-2 bg-white transition-colors duration-150',
            'peer-checked:border-teal-600 peer-checked:bg-teal-600',
            'peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2',
            invalid ? 'border-red-300' : 'border-gray-300 group-hover:border-teal-400'
          )}
        />
        {checked && (
          <Check
            className="csba-pop pointer-events-none absolute h-3.5 w-3.5 text-white"
            strokeWidth={3}
          />
        )}
      </span>
      <span className="text-[13px] leading-relaxed text-gray-600">{children}</span>
    </label>
  )
}

// Segmented, animated OTP field: six boxes rendered from one hidden input so
// typing, backspace, and pasting a full code all behave normally, while each
// digit pops in as it lands. Replaces a plain letter-spaced text input with
// something that actually shows progress.
function OtpBoxes({ value, onChange, disabled, inputRef, invalid }) {
  return (
    <div className="relative">
      <input
        ref={inputRef}
        id="otp"
        name="otp"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={OTP_LENGTH}
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-label="6-digit verification code"
        className="absolute inset-0 h-full w-full cursor-text opacity-0 disabled:cursor-not-allowed"
      />
      <div className="flex justify-between gap-1.5 sm:gap-2" aria-hidden="true">
        {Array.from({ length: OTP_LENGTH }).map((_, i) => {
          const char = value[i]
          const isNextToFill = i === value.length
          return (
            <div
              key={i}
              className={cn(
                'flex h-12 flex-1 items-center justify-center rounded-lg border-2 bg-white text-lg font-semibold text-gray-800 transition-colors duration-150 sm:h-14',
                char ? 'border-teal-600' : 'border-gray-200',
                isNextToFill && !disabled && !char && 'border-teal-400',
                invalid && 'border-red-300'
              )}
            >
              {char ? (
                <span key={char + '-' + i} className="csba-pop">
                  {char}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Left-hand brand panel — desktop/tablet only (lg+). Carries the trust
// signals that used to be squeezed into the form card's footer, and gives
// the portal an actual identity instead of a bare white card floating on
// gray.
//
// Background photography: drop a real image at public/brand/check-release-hero.jpg
// (a check-processing floor, teller line, vault, or ledger close-up all read
// well here). Using a local asset — rather than hotlinking a stock photo —
// means it won't break if the source disappears and avoids licensing risk;
// swap in whatever's cleared for production. The gradient overlay is tuned
// to keep the copy legible over any image you drop in, and to keep the
// panel on-brand even before an image is added.
function BrandPanel() {
  return (
    <div className="relative hidden w-[42%] shrink-0 flex-col justify-between overflow-hidden bg-teal-100 px-10 py-12 text-white lg:flex xl:w-[38%] xl:px-14">
      <div
        className="absolute inset-0 bg-[url('/brand/check-release-hero.jpg')] bg-cover bg-center"
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-teal-950/80" aria-hidden="true" />
      <div
        className="csba-float pointer-events-none absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-teal-600/30 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -top-10 left-1/3 h-40 w-40 rounded-full bg-teal-800/40 blur-3xl"
        aria-hidden="true"
      />

      <div className="relative z-10 flex items-center gap-2.5">
        
        <span className="text-sm font-semibold tracking-wide text-teal-50">
          Check Releasing Portal
        </span>
      </div>

      <div className="relative z-10 max-w-sm">
        <h2 className="text-3xl font-bold leading-tight tracking-tight text-white">
          Every check, verified before it's released.
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-teal-100">
          Admin, verifier, and approver accounts sign in here to manage your bank's check
          releasing workflow — every session is verified, scoped to your role, and logged.
        </p>

        <ul className="mt-8 flex flex-col gap-5">
          {TRUST_POINTS.map(({ icon: Icon, title, description }) => (
            <li key={title} className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10">
                <Icon className="h-4.5 w-4.5 text-teal-50" />
              </span>
              <div>
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-teal-100">{description}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative z-10 text-xs text-teal-200">
        Authorized personnel only. Access is managed by Credit Solutions & Business Alliances, Inc.
      </p>
    </div>
  )
}

// Single shared login for every role — same form for admin, verifier, and
// approver accounts.
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
  const [checkingExistingSession, setCheckingExistingSession] = useState(true)

  // Consent — required every sign-in, independent of the credentials
  // themselves, so accepting old terms never silently carries forward.
  const [consents, setConsents] = useState({ privacy: false, terms: false })
  const [consentError, setConsentError] = useState('')
  const [activeNotice, setActiveNotice] = useState(null) // 'privacy' | 'terms' | null

  // Bumped on every validation/auth failure so the relevant panel can
  // replay its shake animation, including on repeated identical errors.
  const [shakeTick, setShakeTick] = useState(0)
  const [otpShakeTick, setOtpShakeTick] = useState(0)

  // Convenience — remembers only the email locally, never the password.
  const [rememberEmail, setRememberEmail] = useState(false)

  // Connectivity — surfaces a clear reason when requests would otherwise
  // just hang, instead of leaving people staring at a spinner.
  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine
  )

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

  // Prefill a remembered email (client-side convenience only — password is
  // never stored).
  useEffect(() => {
    const remembered = getRememberedEmail()
    if (remembered) {
      setEmail(remembered)
      setRememberEmail(true)
    }
  }, [])

  // Track connectivity so the UI can explain a stalled request instead of
  // leaving a spinner running indefinitely.
  useEffect(() => {
    function goOnline() {
      setIsOnline(true)
    }
    function goOffline() {
      setIsOnline(false)
    }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  // If someone already has a live session and lands on this page (e.g. a
  // stale bookmark, or clicking back after signing in), send them straight
  // to their area instead of re-prompting for credentials. Because the
  // Supabase client is configured with sessionStorage (see
  // ../lib/supabaseClient.js), this only ever finds a session if the
  // current TAB has one — a fresh tab, or a reopened browser, always lands
  // here with nothing to find and falls through to the sign-in form.
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
  // OTP before treating the user as authenticated. NOTE: this session is
  // deliberately thrown away, so it is NOT logged as a login — the real
  // login is recorded in submitOtp below, once OTP verification succeeds.
  async function handleSubmit(e) {
    e.preventDefault()

    const emailErr = validateEmail(email)
    const passwordErr = validatePassword(password)
    setFieldErrors({ email: emailErr, password: passwordErr })

    const missingConsent = !consents.privacy || !consents.terms
    setConsentError(
      missingConsent
        ? 'Please accept the Data Privacy Notice and Terms & Conditions to continue.'
        : ''
    )

    if (emailErr || passwordErr || missingConsent) {
      setShakeTick((t) => t + 1)
      return
    }

    if (!isOnline) {
      setError('You appear to be offline. Reconnect and try again.')
      setShakeTick((t) => t + 1)
      return
    }

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
      setShakeTick((t) => t + 1)
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
      setShakeTick((t) => t + 1)
      recordServerAttempt(trimmedEmail, 'password', false)
      return
    }

    recordServerAttempt(trimmedEmail, 'password', true)
    setRememberedEmail(rememberEmail ? trimmedEmail : '')

    // Password confirmed correct — but don't trust this session until OTP
    // passes. IMPORTANT: scope this to 'local'. The default scope is
    // 'global', which revokes every refresh token this user has anywhere —
    // so a bare signOut() here would silently log the person out of any
    // other tab/device they were already signed into, every single time
    // they logged in again from somewhere new. 'local' only tears down the
    // session that was just created in THIS tab, which is the one we
    // actually want to discard.
    await supabase.auth.signOut({ scope: 'local' })
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
      setShakeTick((t) => t + 1)
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

  // Step 2: verify the 6-digit code. This is what actually establishes the
  // session — so this is where the login gets recorded, not handleSubmit.
  async function submitOtp(code) {
    if (!/^\d{6}$/.test(code)) {
      setOtpError('Enter the 6-digit code.')
      setOtpShakeTick((t) => t + 1)
      return
    }

    if (!isOnline) {
      setOtpError('You appear to be offline. Reconnect and try again.')
      setOtpShakeTick((t) => t + 1)
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
      setOtpShakeTick((t) => t + 1)
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
      setOtpShakeTick((t) => t + 1)
      recordServerAttempt(trimmedEmail, 'otp', false)
      return
    }

    recordServerAttempt(trimmedEmail, 'otp', true)
    clearOtpResendState(trimmedEmail)

    const { data: { user } } = await supabase.auth.getUser()

    // Real login happens HERE — the password-check session in handleSubmit
    // above gets torn down immediately and never counts. Fire-and-forget:
    // a failed audit write should never block someone from getting into
    // their account.
    if (user?.id) {
      recordLogin(user.id).catch(() => {})
    }

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
      setOtpShakeTick((t) => t + 1)
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
      setOtpShakeTick((t) => t + 1)

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
    if (emailErr) {
      setShakeTick((t) => t + 1)
      return
    }

    if (!isOnline) {
      setError('You appear to be offline. Reconnect and try again.')
      setShakeTick((t) => t + 1)
      return
    }

    setError('')
    setLoading(true)
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      normalizeEmail(email),
      // Shared across all three portals. Wire this up at /reset-password
      // (see src/pages/ResetPassword.jsx) — it reads the recovery code
      // Supabase appends to this URL and lets the person set a new password.
      { redirectTo: `${window.location.origin}/reset-password` }
    )
    setLoading(false)

    if (resetError) {
      setError(friendlyAuthError(resetError.message))
      setShakeTick((t) => t + 1)
      return
    }
    setMode('forgot-sent')
  }

  if (checkingExistingSession) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-gray-50">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="relative flex min-h-[100dvh] overflow-hidden bg-gray-50">
      <MotionStyles />

      <BrandPanel />

      <div className="relative flex flex-1 items-start justify-center px-4 pb-10 pt-14 sm:px-6 sm:pb-12 sm:pt-20 lg:px-10 lg:pt-24">
        {/* One quiet, slow-drifting solid shape instead of a cluster of
            blurred gradient blobs — a single deliberate accent, not
            decoration. Only shown here on mobile/tablet; the brand panel
            carries its own on lg+. */}
        <div
          className="csba-float pointer-events-none absolute -top-16 -left-16 h-64 w-64 rounded-full bg-teal-100/60 blur-3xl lg:hidden"
          aria-hidden="true"
        />

        <Card className="csba-rise relative w-full max-w-lg overflow-hidden border-0 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_rgba(15,23,42,0.08)]">
          {!isOnline && (
            <div className="flex items-center justify-center gap-2 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-700">
              <WifiOff className="h-3.5 w-3.5 shrink-0" />
              You're offline — reconnect to sign in.
            </div>
          )}

          <CardHeader className="items-center space-y-4 pt-10 text-center">
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
                  'Enter your account email and we\u2019ll send you a link to reset your password.'}
                {mode === 'forgot-sent' &&
                  'If an account exists for that address, a reset link is on its way. It can take a few minutes to arrive.'}
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="px-8 pb-10 sm:px-10">
            {mode === 'signin' && (
              <form
                onSubmit={handleSubmit}
                noValidate
                className="csba-rise flex flex-col gap-4"
              >
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
                      'text-base transition-shadow duration-150 focus-visible:ring-teal-500 sm:text-sm',
                      fieldErrors.email && 'border-red-300 focus-visible:ring-red-400'
                    )}
                  />
                  {fieldErrors.email && (
                    <p id="email-error" className="csba-rise flex items-center gap-1 text-xs text-red-600">
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
                      className="text-xs font-medium text-teal-600 transition-colors hover:text-teal-700 hover:underline"
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
                        'pr-10 text-base transition-shadow duration-150 focus-visible:ring-teal-500 sm:text-sm',
                        fieldErrors.password && 'border-red-300 focus-visible:ring-red-400'
                      )}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {fieldErrors.password && (
                    <p id="password-error" className="csba-rise flex items-center gap-1 text-xs text-red-600">
                      <AlertCircle className="h-3 w-3 shrink-0" />
                      {fieldErrors.password}
                    </p>
                  )}
                  {capsLockOn && (
                    <p className="csba-rise flex items-center gap-1 text-xs text-orange-600">
                      <AlertCircle className="h-3 w-3 shrink-0" />
                      Caps Lock is on
                    </p>
                  )}
                </div>

                <label className="flex w-fit items-center gap-2 text-xs text-gray-500">
                  <input
                    type="checkbox"
                    checked={rememberEmail}
                    onChange={(e) => setRememberEmail(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-teal-600 transition-colors focus-visible:ring-2 focus-visible:ring-teal-500"
                  />
                  Remember my email on this device
                </label>

                {/* Data Privacy Act + Terms consent — required to proceed */}
                <div
                  key={`consent-${shakeTick}`}
                  className={cn(
                    'space-y-3 rounded-xl border p-3.5 transition-colors duration-200',
                    consentError
                      ? 'border-red-200 bg-red-50/50 csba-shake'
                      : 'border-gray-200 bg-gray-50/60'
                  )}
                >
                  <ConsentCheckbox
                    id="consent-privacy"
                    checked={consents.privacy}
                    invalid={!!consentError && !consents.privacy}
                    onChange={(e) => {
                      setConsents((c) => ({ ...c, privacy: e.target.checked }))
                      setConsentError('')
                    }}
                  >
                    I consent to the collection and processing of my personal data as described in
                    the{' '}
                    <button
                      type="button"
                      onClick={() => setActiveNotice('privacy')}
                      className="font-medium text-teal-700 underline underline-offset-2 hover:text-teal-800"
                    >
                      Data Privacy Notice
                    </button>
                    , in accordance with the Data Privacy Act of 2012 (RA 10173).
                  </ConsentCheckbox>

                  <ConsentCheckbox
                    id="consent-terms"
                    checked={consents.terms}
                    invalid={!!consentError && !consents.terms}
                    onChange={(e) => {
                      setConsents((c) => ({ ...c, terms: e.target.checked }))
                      setConsentError('')
                    }}
                  >
                    I have read and agree to the{' '}
                    <button
                      type="button"
                      onClick={() => setActiveNotice('terms')}
                      className="font-medium text-teal-700 underline underline-offset-2 hover:text-teal-800"
                    >
                      Terms & Conditions
                    </button>{' '}
                    of use of this portal.
                  </ConsentCheckbox>

                  {consentError && (
                    <p className="flex items-center gap-1.5 text-xs text-red-600">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      {consentError}
                    </p>
                  )}
                </div>

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

                {failedAttempts >= 3 && (
                  <div className="csba-rise flex items-start gap-2 rounded-md border border-teal-200 bg-teal-50 p-3 text-xs text-teal-800">
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
                  disabled={loading || !isOnline}
                  aria-busy={loading}
                  className="mt-1 h-11 w-full bg-teal-600 text-base font-medium text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md focus-visible:ring-teal-500 active:translate-y-0 active:scale-[0.99] disabled:translate-y-0 disabled:opacity-60 disabled:shadow-sm sm:text-sm"
                >
                  {loading ? 'Signing in\u2026' : 'Sign in'}
                </Button>
              </form>
            )}

            {mode === 'otp' && (
              <form onSubmit={handleOtpSubmit} noValidate className="csba-rise flex flex-col gap-4">
                <div className="space-y-1.5">
                  <label htmlFor="otp" className="text-sm font-medium text-gray-700">
                    Verification code
                  </label>
                  <div key={`otp-${otpShakeTick}`} className={otpError ? 'csba-shake' : undefined}>
                    <OtpBoxes
                      value={otp}
                      onChange={handleOtpChange}
                      disabled={loading || resendsExhausted}
                      inputRef={otpInputRef}
                      invalid={!!otpError}
                    />
                  </div>
                  {otpError && (
                    <p id="otp-error" className="flex items-center gap-1 text-xs text-red-600">
                      <AlertCircle className="h-3 w-3 shrink-0" />
                      {otpError}
                    </p>
                  )}
                </div>

                {otpFailedAttempts >= 3 && (
                  <div className="csba-rise flex items-start gap-2 rounded-md border border-teal-200 bg-teal-50 p-3 text-xs text-teal-800">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <p>
                      Still not working? Make sure you're using the most recent code sent to your
                      inbox, or request a new one below.
                    </p>
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={loading || otp.length !== OTP_LENGTH || resendsExhausted || !isOnline}
                  aria-busy={loading}
                  className="h-11 w-full bg-teal-600 text-base font-medium text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md focus-visible:ring-teal-500 active:translate-y-0 active:scale-[0.99] disabled:translate-y-0 disabled:opacity-60 sm:text-sm"
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  {loading ? 'Verifying\u2026' : 'Verify & sign in'}
                </Button>

                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={resendCooldown > 0 || loading || otpSendingRef.current || resendsExhausted}
                  className="text-center text-sm font-medium text-teal-600 transition-colors hover:text-teal-700 disabled:cursor-not-allowed disabled:text-gray-400"
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
                  className="flex items-center justify-center gap-1 text-center text-sm font-medium text-gray-500 transition-colors hover:text-gray-700"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to sign in
                </button>
              </form>
            )}

            {mode === 'forgot-form' && (
              <form onSubmit={handleForgotSubmit} noValidate className="csba-rise flex flex-col gap-4">
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
                      'text-base transition-shadow duration-150 focus-visible:ring-teal-500 sm:text-sm',
                      fieldErrors.email && 'border-red-300 focus-visible:ring-red-400'
                    )}
                  />
                  {fieldErrors.email && (
                    <p id="reset-email-error" className="csba-rise flex items-center gap-1 text-xs text-red-600">
                      <AlertCircle className="h-3 w-3 shrink-0" />
                      {fieldErrors.email}
                    </p>
                  )}
                </div>

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
                  disabled={loading || !isOnline}
                  aria-busy={loading}
                  className="mt-2 h-11 w-full bg-teal-600 text-base font-medium text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md focus-visible:ring-teal-500 active:translate-y-0 active:scale-[0.99] sm:text-sm"
                >
                  <Mail className="mr-2 h-4 w-4" />
                  {loading ? 'Sending link\u2026' : 'Send reset link'}
                </Button>

                <button
                  type="button"
                  onClick={goToSignIn}
                  className="text-center text-sm font-medium text-gray-500 transition-colors hover:text-gray-700"
                >
                  Back to sign in
                </button>
              </form>
            )}

            {mode === 'forgot-sent' && (
              <div className="csba-rise flex flex-col gap-4">
                <div className="flex items-start gap-2 rounded-md border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">
                  <CheckCircle2 className="csba-pop mt-0.5 h-4 w-4 shrink-0" />
                  <p>
                    Sent to <span className="font-medium">{normalizeEmail(email)}</span>. Didn't
                    get it? Check your spam folder, or try again in a few minutes.
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={goToSignIn}
                  className="h-11 w-full bg-teal-600 text-base font-medium text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md focus-visible:ring-teal-500 active:translate-y-0 sm:text-sm"
                >
                  Back to sign in
                </Button>
              </div>
            )}

            <p className="mt-8 text-center text-xs text-gray-400 lg:hidden">
              Authorized bank personnel only. Access is managed by CSBA.
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
              {isSecureConnection && (
                <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
                  <Lock className="h-3 w-3" />
                  Connection encrypted
                </p>
              )}
              <p className="flex items-center gap-1.5 text-[11px] text-gray-400 lg:hidden">
                <ShieldCheck className="h-3 w-3" />
                RA 10173 compliant
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <NoticeSheet notice={activeNotice} onClose={() => setActiveNotice(null)} />
    </div>
  )
}