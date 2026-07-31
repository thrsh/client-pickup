// src/components/AccountSettings.jsx
//
// One page, three behaviors:
//  - verifier / approver: see their login email (read-only), change password
//  - admin: edit login email, add/edit a personal recovery email, change
//    password with the extra "advanced" options (generate + sign out
//    other sessions)
//
// Wire the on* callbacks up to your API. Each one should return a Promise
// that resolves on success or throws an Error with a user-facing message.

import React, { useEffect, useMemo, useState } from 'react'
import { Mail, ShieldAlert, KeyRound, Sparkles, CheckCircle2, Lock } from 'lucide-react'
import { cn } from '../lib/utils'
import PasswordField from './PasswordField'
import PasswordStrengthMeter from './PasswordStrengthMeter'
import { evaluatePassword, generateStrongPassword, isValidEmail } from '../lib/password'

const ROLE_LABEL = {
  verifier: 'Verifier',
  approver: 'Approver',
  admin: 'Administrator',
}

function Card({ icon: Icon, title, description, children }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-gray-500">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function Banner({ tone = 'success', children }) {
  const toneClasses =
    tone === 'success'
      ? 'border-teal-200 bg-teal-50 text-teal-800'
      : 'border-red-200 bg-red-50 text-red-700'
  return (
    <div className={cn('mb-4 rounded-lg border px-3 py-2 text-xs', toneClasses)}>
      {children}
    </div>
  )
}

export default function AccountSettings({
  role = 'verifier', // 'verifier' | 'approver' | 'admin'
  user = { email: '', recoveryEmail: '' },
  onChangePassword, // (currentPassword, newPassword, opts) => Promise
  onUpdateEmail, // admin only: (newEmail) => Promise
  onUpdateRecoveryEmail, // admin only: (recoveryEmail) => Promise
}) {
  const isAdmin = role === 'admin'

  return (
    <div className="w-full">
      <div className="mb-6 border-b border-gray-100 pb-5">
        <h1 className="text-xl font-bold text-gray-900">Account settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Signed in as <span className="font-medium text-gray-700">{ROLE_LABEL[role]}</span>
        </p>
      </div>

      {/* Full-width, two-column on large screens: identity on the left,
          password on the right (it has the most fields, so it gets the
          wider column). Stacks to one column below xl instead of ever
          squeezing into a fixed narrow strip. */}
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
        <div className="flex flex-col gap-6 xl:col-span-5">
          <LoginEmailCard
            isAdmin={isAdmin}
            email={user.email}
            onUpdateEmail={onUpdateEmail}
          />

          {isAdmin && (
            <RecoveryEmailCard
              recoveryEmail={user.recoveryEmail}
              onUpdateRecoveryEmail={onUpdateRecoveryEmail}
            />
          )}
        </div>

        <div className="xl:col-span-7">
          <PasswordCard isAdmin={isAdmin} onChangePassword={onChangePassword} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Login email
// ---------------------------------------------------------------------------

function LoginEmailCard({ isAdmin, email, onUpdateEmail }) {
  const [value, setValue] = useState(email)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null) // { tone, text }

  // `email` often arrives after the first render (useAuth resolves the
  // user asynchronously), so the field would otherwise mount blank and
  // stay blank forever. Backfill it once real data shows up — but only
  // while the field is still untouched, so it never clobbers something
  // the admin is actively typing.
  useEffect(() => {
    setValue((prev) => (prev === '' ? email : prev))
  }, [email])

  if (!isAdmin) {
    return (
      <Card
        icon={Mail}
        title="Login email"
        description="This is the email address used to sign in to your account."
      >
        <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <span className="truncate text-sm text-gray-700">{email}</span>
          <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            Locked
          </span>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-800">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>You can&apos;t change your login email yourself. Contact your administrator if it needs to be updated.</p>
        </div>
      </Card>
    )
  }

  const dirty = value.trim() !== email
  const emailValid = isValidEmail(value)

  const handleSave = async () => {
    if (!emailValid || !dirty) return
    setSaving(true)
    setMessage(null)
    try {
      await onUpdateEmail?.(value.trim())
      setMessage({
        tone: 'success',
        text: 'Confirmation link sent to the new address. The email won\u2019t change until you click it.',
      })
    } catch (err) {
      setMessage({ tone: 'error', text: err?.message || 'Could not update email.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      icon={Mail}
      title="Login email"
      description="The email address you use to sign in. Only administrators can edit this."
    >
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      <label htmlFor="login-email" className="mb-1.5 block text-sm font-medium text-gray-700">
        Email address
      </label>
      <input
        id="login-email"
        type="email"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition-colors focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
      />
      {dirty && !emailValid && (
        <p className="mt-1 text-xs text-red-600">Enter a valid email address.</p>
      )}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={!dirty || !emailValid || saving}
          onClick={handleSave}
          className={cn(
            'rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-colors',
            !dirty || !emailValid || saving
              ? 'cursor-not-allowed bg-gray-100 text-gray-400'
              : 'bg-teal-600 text-white hover:bg-teal-700'
          )}
        >
          {saving ? 'Saving…' : 'Save email'}
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Recovery email (admin only)
// ---------------------------------------------------------------------------

function RecoveryEmailCard({ recoveryEmail, onUpdateRecoveryEmail }) {
  const [value, setValue] = useState(recoveryEmail || '')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    setValue((prev) => (prev === '' && recoveryEmail ? recoveryEmail : prev))
  }, [recoveryEmail])

  const dirty = value.trim() !== (recoveryEmail || '')
  const emailValid = value.trim() === '' || isValidEmail(value)

  const handleSave = async () => {
    if (!emailValid || !dirty) return
    setSaving(true)
    setMessage(null)
    try {
      await onUpdateRecoveryEmail?.(value.trim())
      setMessage({ tone: 'success', text: 'Recovery email saved.' })
    } catch (err) {
      setMessage({ tone: 'error', text: err?.message || 'Could not save recovery email.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      icon={ShieldAlert}
      title="Recovery email"
      description="A personal email used only for account recovery — for example, if you forget your password. Not used to sign in."
    >
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      <label htmlFor="recovery-email" className="mb-1.5 block text-sm font-medium text-gray-700">
        Personal email address
      </label>
      <input
        id="recovery-email"
        type="email"
        placeholder="you@personal-email.com"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition-colors focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
      />
      {value.trim() && !emailValid && (
        <p className="mt-1 text-xs text-red-600">Enter a valid email address.</p>
      )}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={!dirty || !emailValid || saving}
          onClick={handleSave}
          className={cn(
            'rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-colors',
            !dirty || !emailValid || saving
              ? 'cursor-not-allowed bg-gray-100 text-gray-400'
              : 'bg-teal-600 text-white hover:bg-teal-700'
          )}
        >
          {saving ? 'Saving…' : recoveryEmail ? 'Update recovery email' : 'Add recovery email'}
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

function PasswordCard({ isAdmin, onChangePassword }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [signOutOthers, setSignOutOthers] = useState(isAdmin)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  const evaluation = useMemo(
    () => evaluatePassword(newPassword, { currentPassword }),
    [newPassword, currentPassword]
  )

  const confirmMatches = confirmPassword.length > 0 && confirmPassword === newPassword
  const confirmError =
    confirmPassword.length > 0 && !confirmMatches ? 'Passwords do not match.' : null

  const canSubmit =
    currentPassword.length > 0 && evaluation.isValid && confirmMatches && !saving

  const handleGenerate = () => {
    const generated = generateStrongPassword()
    setNewPassword(generated)
    setConfirmPassword(generated)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    setMessage(null)
    try {
      await onChangePassword?.(currentPassword, newPassword, { signOutOthers })
      setMessage({ tone: 'success', text: 'Password updated successfully.' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setMessage({ tone: 'error', text: err?.message || 'Could not update password. Check your current password and try again.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      icon={KeyRound}
      title={isAdmin ? 'Advanced password settings' : 'Change password'}
      description={
        isAdmin
          ? 'Update your password, generate a strong one automatically, and control your other active sessions.'
          : 'Choose a new password. You\u2019ll need to confirm it twice.'
      }
    >
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <PasswordField
          id="current-password"
          label="Current password"
          value={currentPassword}
          onChange={setCurrentPassword}
          autoComplete="current-password"
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="new-password" className="text-sm font-medium text-gray-700">
                New password
              </label>
              {isAdmin && (
                <button
                  type="button"
                  onClick={handleGenerate}
                  className="flex items-center gap-1 text-xs font-semibold text-teal-700 hover:text-teal-800"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate
                </button>
              )}
            </div>
            <PasswordField
              id="new-password"
              label=""
              value={newPassword}
              onChange={setNewPassword}
              error={
                evaluation.reusesCurrent ? 'Must differ from your current password.' : null
              }
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="confirm-password" className="text-sm font-medium text-gray-700">
                Confirm new password
              </label>
              {isAdmin && <span className="h-[17px]" aria-hidden="true" />}
            </div>
            <PasswordField
              id="confirm-password"
              label=""
              value={confirmPassword}
              onChange={setConfirmPassword}
              error={confirmError}
            />
          </div>
        </div>

        <PasswordStrengthMeter password={newPassword} currentPassword={currentPassword} />

        {confirmMatches && evaluation.isValid && (
          <div className="flex items-center gap-1.5 text-xs font-medium text-teal-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Passwords match and meet all requirements.
          </div>
        )}

        {isAdmin && (
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={signOutOthers}
              onChange={(e) => setSignOutOthers(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
            />
            Sign out of all other active sessions after changing my password
          </label>
        )}

        <div className="mt-1 flex justify-end">
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-colors',
              canSubmit
                ? 'bg-teal-600 text-white hover:bg-teal-700'
                : 'cursor-not-allowed bg-gray-100 text-gray-400'
            )}
          >
            <Lock className="h-3.5 w-3.5" />
            {saving ? 'Updating…' : 'Update password'}
          </button>
        </div>
      </form>
    </Card>
  )
}