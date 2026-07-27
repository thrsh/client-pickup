// src/pages/admin/AdminUsers.jsx
//
// Manages verifier/approver accounts. "Last login" and online/offline status
// are pulled from listUserSessions() (audit_log-backed, via adminAuditApi.js)
// rather than the Edge Function's raw last_sign_in_at — the latter updates
// on the throwaway password-check session in the OTP login flow (see
// Login.jsx), before 2FA actually completes, so it's not trustworthy as
// "last real login." listUserSessions() only records a login once OTP
// verification succeeds, so it's the single accurate source for this.
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import {
  ShieldCheck,
  Plus,
  Search,
  Pencil,
  Ban,
  RotateCcw,
  Loader2,
  KeyRound,
  Eye,
  EyeOff,
  X,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Users as UsersIcon,
  ShieldAlert,
  RefreshCw,
  History,
  Clock,
  Radio,
  Circle,
  AlertCircle,
  UserCog,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { Dialog } from '../../components/ui/dialog'
import { Select } from '../../components/ui/select'
import {
  listUsers,
  createUser,
  updateUser,
  deactivateUser,
  reactivateUser,
  sendPasswordReset,
} from '../../lib/adminUsersApi'
import { listUserSessions, logAuditEvent, isAbortError } from '../../lib/adminAuditApi'
import { downloadCsv, downloadXlsx, downloadPdf, ExportMenu } from '../../lib/exportUtils'
import UserDetailDrawer from '../../components/UserDetailDrawer'

// This page only manages verifier/approver accounts.
const ROLE_OPTIONS = [
  { value: 'verifier', label: 'Verifier' },
  { value: 'approver', label: 'Approver' },
]

const ROLE_FILTER_OPTIONS = [{ value: 'all', label: 'All roles' }, ...ROLE_OPTIONS]

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'deactivated', label: 'Deactivated' },
]

// Sign-in presence filter — separate axis from account active/deactivated
// status above. A deactivated account can still show a historical
// "Offline" session; an active account that's never signed in shows
// "Never signed in".
const SESSION_FILTER_OPTIONS = [
  { value: 'all', label: 'Any sign-in status' },
  { value: 'online', label: 'Online now' },
  { value: 'offline', label: 'Offline' },
  { value: 'stale', label: 'Session expired' },
  { value: 'never_logged_in', label: 'Never signed in' },
]

const ROLE_BADGE_STYLE = {
  verifier: 'bg-blue-100 text-blue-800',
  approver: 'bg-amber-100 text-amber-800',
}

// Small local copy of icon/tone metadata for sign-in presence — kept as a
// thin UI lookup here (icons + Tailwind classes), while the underlying
// status strings and labels come from adminAuditApi.js's
// SESSION_STATUS_LABELS/getSessionStatusLabel so both pages describe the
// same four states identically.
const SESSION_STATUS_UI = {
  online: { icon: Radio, tone: 'text-green-700 bg-green-50', pulse: true },
  offline: { icon: Circle, tone: 'text-gray-600 bg-gray-100', pulse: false },
  stale: {
    icon: AlertCircle,
    tone: 'text-amber-700 bg-amber-50',
    pulse: false,
    note: 'Logged in a while ago with no logout on record — likely a closed browser rather than an active session.',
  },
  never_logged_in: { icon: Circle, tone: 'text-gray-500 bg-gray-50', pulse: false },
}

function sessionStatusUi(status) {
  return SESSION_STATUS_UI[status] || SESSION_STATUS_UI.offline
}

const AVATAR_PALETTE = [
  'bg-teal-100 text-teal-700',
  'bg-blue-100 text-blue-700',
  'bg-amber-100 text-amber-700',
  'bg-violet-100 text-violet-700',
  'bg-rose-100 text-rose-700',
  'bg-emerald-100 text-emerald-700',
]

const PAGE_SIZE = 10
const SESSIONS_REFRESH_MS = 30 * 1000 // matches AdminAuditTrail's User Sessions tab cadence

function splitName(fullName = '') {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

function getInitials(fullName, email) {
  const source = (fullName || '').trim()
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean)
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }
  return (email || '?').slice(0, 2).toUpperCase()
}

function avatarStyleFor(key = '') {
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % AVATAR_PALETTE.length
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

function formatRelativeTime(iso) {
  if (!iso) return 'Never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Never'
  const diffMs = Date.now() - date.getTime()
  const diffSec = Math.round(diffMs / 1000)
  const diffMin = Math.round(diffSec / 60)
  const diffHr = Math.round(diffMin / 60)
  const diffDay = Math.round(diffHr / 24)
  if (diffSec < 60) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatAbsoluteTime(iso) {
  if (!iso) return 'Never signed in'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Never signed in'
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return '—'
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 1) return '<1m'
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (mins && !days) parts.push(`${mins}m`)
  return parts.slice(0, 2).join(' ') || '<1m'
}

function useDebouncedValue(value, delay) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

// ----------------------------------------------------------------------------
// Module-level stale-while-revalidate cache. This is what actually removes
// the ~1s blank/skeleton wait on every visit: the first load in a browser
// session still has to pay real network latency, but every subsequent
// mount of this page (switching tabs, navigating away and back) renders the
// last known-good data immediately from this cache, then silently
// refetches in the background to catch up on anything that changed. Module
// scope (not component state) so it survives unmount/remount of the page.
// ----------------------------------------------------------------------------
let usersCache = null // { data, ts }
let sessionsCache = null // { data, ts }
const CACHE_TTL_MS = 60 * 1000

function isCacheFresh(cache) {
  return Boolean(cache) && Date.now() - cache.ts < CACHE_TTL_MS
}

// ----------------------------------------------------------------------------
// Robust, tokenized, case-insensitive search — every space-separated word
// in the query must appear somewhere in the row, so "juan verifier" matches
// a user named Juan with role verifier regardless of field order, the same
// matching behavior used by the audit trail tables.
// ----------------------------------------------------------------------------
function normalizeSearchTokens(term) {
  return String(term || '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function rowMatchesTokens(haystackParts, tokens) {
  if (tokens.length === 0) return true
  const haystack = haystackParts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .join(' \u241F ')
    .toLowerCase()
  return tokens.every((t) => haystack.includes(t))
}

function sessionStatusLabel(status) {
  if (status === 'online') return 'online'
  if (status === 'stale') return 'session expired'
  if (status === 'offline') return 'offline'
  return 'never signed in'
}

function userSearchHaystack(u) {
  return [
    u.full_name,
    u.email,
    u.role,
    u.banned ? 'deactivated' : 'active',
    sessionStatusLabel(u.session?.status),
    u.session?.lastLogin ? formatAbsoluteTime(u.session.lastLogin) : null,
  ]
}

// Generic, locale-aware, null-safe comparator shared by every sortable
// column — numeric getters compare numerically, everything else falls back
// to case-insensitive/locale-aware string comparison, and missing values
// always sort last regardless of direction (so "never signed in" doesn't
// jump to the top just because ascending order was picked).
function compareBy(getter, dir) {
  const mult = dir === 'asc' ? 1 : -1
  return (a, b) => {
    const va = getter(a)
    const vb = getter(b)
    const aEmpty = va === null || va === undefined || va === ''
    const bEmpty = vb === null || vb === undefined || vb === ''
    if (aEmpty && bEmpty) return 0
    if (aEmpty) return 1
    if (bEmpty) return -1
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult
    return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * mult
  }
}

const SESSION_SORT_ORDER = { online: 0, stale: 1, offline: 2, never_logged_in: 3 }

// Client-side getters for every sortable column, used with compareBy above.
const USER_SORT_GETTERS = {
  name: (u) => (u.full_name || u.email || '').toLowerCase() || null,
  email: (u) => (u.email || '').toLowerCase() || null,
  role: (u) => (u.role || '').toLowerCase() || null,
  status: (u) => (u.banned ? 1 : 0),
  session: (u) => SESSION_SORT_ORDER[u.session?.status] ?? SESSION_SORT_ORDER.never_logged_in,
  lastLogin: (u) => (u.session?.lastLogin ? new Date(u.session.lastLogin).getTime() : null),
}

const EMPTY_FORM = {
  id: null,
  email: '',
  firstName: '',
  lastName: '',
  role: 'approver',
  password: '',
}

const BANNER_STYLES = {
  success: {
    wrap: 'border-green-200 bg-green-50 text-green-800',
    icon: CheckCircle2,
    iconClass: 'text-green-600',
    bar: 'bg-green-500/30',
  },
  error: {
    wrap: 'border-red-200 bg-red-50 text-red-800',
    icon: XCircle,
    iconClass: 'text-red-600',
    bar: 'bg-red-500/30',
  },
}

function BannerToast({ banner, onDismiss }) {
  const [entered, setEntered] = useState(false)
  const [shrink, setShrink] = useState(false)

  useEffect(() => {
    setEntered(false)
    setShrink(false)
    const enterFrame = requestAnimationFrame(() => setEntered(true))
    const shrinkFrame = requestAnimationFrame(() => setShrink(true))
    return () => {
      cancelAnimationFrame(enterFrame)
      cancelAnimationFrame(shrinkFrame)
    }
  }, [banner.id])

  const style = BANNER_STYLES[banner.type] || BANNER_STYLES.success
  const Icon = style.icon

  return (
    <div
      className={`pointer-events-auto relative mb-4 overflow-hidden rounded-lg border px-3 py-2.5 pr-9 text-sm shadow-sm transition-all duration-300 ease-out ${style.wrap} ${
        entered ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
      }`}
    >
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${style.iconClass}`} />
        <span className="leading-snug">{banner.message}</span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-2 top-2 rounded p-0.5 text-current opacity-60 transition-opacity hover:opacity-100"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <div
        className={`absolute bottom-0 left-0 h-0.5 ${style.bar} transition-all ease-linear`}
        style={{ width: shrink ? '0%' : '100%', transitionDuration: '4000ms' }}
      />
    </div>
  )
}

function SortButton({ label, sortKey, activeKey, direction, onSort }) {
  const isActive = activeKey === sortKey
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className="group inline-flex items-center gap-1 text-left text-xs font-medium uppercase tracking-wide text-gray-500 transition-colors hover:text-gray-800"
    >
      {label}
      {isActive ? (
        direction === 'asc' ? (
          <ChevronUp className="h-3.5 w-3.5 text-teal-600" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-teal-600" />
        )
      ) : (
        <ArrowUpDown className="h-3.5 w-3.5 text-gray-300 transition-colors group-hover:text-gray-400" />
      )}
    </button>
  )
}

function SessionStatusBadge({ status, size = 'normal' }) {
  const ui = sessionStatusUi(status)
  const Icon = ui.icon
  const label =
    status === 'online' ? 'Online' :
    status === 'stale' ? 'Session expired' :
    status === 'never_logged_in' ? 'Never signed in' :
    'Offline'
  const padding = size === 'small' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${padding} ${ui.tone}`}
      title={ui.note}
    >
      <Icon className={`h-3 w-3 ${ui.pulse ? 'animate-pulse' : ''}`} />
      {label}
    </span>
  )
}

function SkeletonRows({ count = 5 }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i} className="animate-pulse">
          <td className="px-4 py-3">
            <div className="h-4 w-4 rounded bg-gray-200" />
          </td>
          <td className="px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full bg-gray-200" />
              <div className="h-3.5 w-28 rounded bg-gray-200" />
            </div>
          </td>
          <td className="px-4 py-3">
            <div className="h-3.5 w-36 rounded bg-gray-200" />
          </td>
          <td className="px-4 py-3">
            <div className="h-5 w-16 rounded-full bg-gray-200" />
          </td>
          <td className="px-4 py-3">
            <div className="h-5 w-20 rounded-full bg-gray-200" />
          </td>
          <td className="px-4 py-3">
            <div className="h-5 w-20 rounded-full bg-gray-200" />
          </td>
          <td className="px-4 py-3">
            <div className="h-3.5 w-20 rounded bg-gray-200" />
          </td>
          <td className="px-4 py-3 text-right">
            <div className="ml-auto h-4 w-16 rounded bg-gray-200" />
          </td>
        </tr>
      ))}
    </>
  )
}

// Memoized desktop row: only re-renders when this user's own data,
// selection state, or the (stable, useCallback-wrapped) action handlers
// change — an unrelated state update elsewhere on the page (search
// keystroke, banner toast animation, another row's checkbox) no longer
// forces every row on the page to reconcile.
const UserRow = React.memo(function UserRow({ user, selected, onToggleSelect, onEdit, onReset, onViewActivity, onToggleStatus, onCopyEmail }) {
  return (
    <tr className="group transition-colors hover:bg-gray-50">
      <td className="px-4 py-3">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
          checked={selected}
          onChange={() => onToggleSelect(user.id)}
          aria-label={`Select ${user.email}`}
        />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarStyleFor(
              user.full_name || user.email
            )}`}
          >
            {getInitials(user.full_name, user.email)}
          </div>
          <span className="font-medium text-gray-800">
            {user.full_name || <span className="text-gray-400">—</span>}
          </span>
        </div>
      </td>
      <td className="px-4 py-3 text-gray-600">
        <button
          type="button"
          onClick={() => onCopyEmail(user.email)}
          className="inline-flex items-center gap-1.5 rounded transition-colors hover:text-teal-700"
          title="Copy email"
        >
          {user.email}
          <Copy className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
        </button>
      </td>
      <td className="px-4 py-3">
        <Badge className={ROLE_BADGE_STYLE[user.role] || ''}>{user.role}</Badge>
      </td>
      <td className="px-4 py-3">
        {user.banned ? (
          <Badge className="bg-red-100 text-red-800">Deactivated</Badge>
        ) : (
          <Badge className="bg-green-100 text-green-800">Active</Badge>
        )}
      </td>
      <td className="px-4 py-3">
        <SessionStatusBadge status={user.session?.status || 'never_logged_in'} />
      </td>
      <td className="px-4 py-3">
        {user.session?.lastLogin ? (
          <>
            <span className="block text-gray-700">{formatAbsoluteTime(user.session.lastLogin)}</span>
            <span className="block text-xs text-gray-400">{formatRelativeTime(user.session.lastLogin)}</span>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-gray-400">
            <Clock className="h-3.5 w-3.5 text-gray-300" />
            Never
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" title="Edit" onClick={() => onEdit(user)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" title="Send password reset" onClick={() => onReset(user)}>
            <KeyRound className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" title="View activity" onClick={() => onViewActivity(user)}>
            <History className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" title={user.banned ? 'Reactivate' : 'Deactivate'} onClick={() => onToggleStatus(user)}>
            {user.banned ? <RotateCcw className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
          </Button>
        </div>
      </td>
    </tr>
  )
})

const UserCardMobile = React.memo(function UserCardMobile({ user, selected, onToggleSelect, onEdit, onReset, onViewActivity, onToggleStatus }) {
  return (
    <Card className="px-4 py-3 transition-shadow active:shadow-sm">
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 flex-shrink-0 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
          checked={selected}
          onChange={() => onToggleSelect(user.id)}
          aria-label={`Select ${user.email}`}
        />
        <div
          className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarStyleFor(
            user.full_name || user.email
          )}`}
        >
          {getInitials(user.full_name, user.email)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-800">
            {user.full_name || <span className="text-gray-400">—</span>}
          </p>
          <p className="truncate text-xs text-gray-500">{user.email}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge className={ROLE_BADGE_STYLE[user.role] || ''}>{user.role}</Badge>
            {user.banned ? (
              <Badge className="bg-red-100 text-red-800">Deactivated</Badge>
            ) : (
              <Badge className="bg-green-100 text-green-800">Active</Badge>
            )}
            <SessionStatusBadge status={user.session?.status || 'never_logged_in'} size="small" />
          </div>
          <p className="mt-1.5 text-[11px] text-gray-400">
            {user.session?.lastLogin ? `Last login: ${formatAbsoluteTime(user.session.lastLogin)}` : 'Never signed in'}
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5 border-t border-gray-100 pt-2.5">
        <Button variant="ghost" size="sm" onClick={() => onEdit(user)}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onReset(user)}>
          <KeyRound className="mr-1.5 h-3.5 w-3.5" />
          Reset
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onViewActivity(user)}>
          <History className="mr-1.5 h-3.5 w-3.5" />
          Activity
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onToggleStatus(user)}>
          {user.banned ? (
            <>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reactivate
            </>
          ) : (
            <>
              <Ban className="mr-1.5 h-3.5 w-3.5" />
              Deactivate
            </>
          )}
        </Button>
      </div>
    </Card>
  )
})

export default function AdminUsers() {
  const [users, setUsers] = useState(() => (isCacheFresh(usersCache) ? usersCache.data : []))
  const [sessions, setSessions] = useState(() => (isCacheFresh(sessionsCache) ? sessionsCache.data : []))
  // If we already have fresh cached data, skip the loading/skeleton state
  // entirely — the page renders real data on the very first paint instead
  // of waiting on the network again.
  const [loading, setLoading] = useState(() => !isCacheFresh(usersCache))
  const [loadError, setLoadError] = useState('')
  const fetchControllerRef = useRef(null)
  const sessionsControllerRef = useRef(null)

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 250)
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sessionFilter, setSessionFilter] = useState('all')
  const [sortKey, setSortKey] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(1)

  const [selectedIds, setSelectedIds] = useState(() => new Set())

  const [banner, setBanner] = useState(null) // { id, type, message }
  const bannerTimeoutRef = useRef(null)

  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState('create') // 'create' | 'edit'
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  // confirmTarget: { mode: 'single' | 'bulk', action: 'deactivate' | 'reactivate', users: [] }
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [ackChecked, setAckChecked] = useState(false)

  // Password reset confirmation
  const [resetTarget, setResetTarget] = useState(null)
  const [resetBusy, setResetBusy] = useState(false)

  // Bulk role change
  const [roleChangeOpen, setRoleChangeOpen] = useState(false)
  const [roleChangeValue, setRoleChangeValue] = useState('verifier')
  const [roleChangeBusy, setRoleChangeBusy] = useState(false)

  // Inline activity drawer — opened from the History/Activity buttons below.
  const [drawerUserId, setDrawerUserId] = useState(null)

  const showBanner = useCallback((type, message) => {
    if (bannerTimeoutRef.current) window.clearTimeout(bannerTimeoutRef.current)
    setBanner({ id: Date.now(), type, message })
    bannerTimeoutRef.current = window.setTimeout(() => setBanner(null), 4000)
  }, [])

  useEffect(() => () => {
    if (bannerTimeoutRef.current) window.clearTimeout(bannerTimeoutRef.current)
    fetchControllerRef.current?.abort()
    sessionsControllerRef.current?.abort()
  }, [])

  // `silent` skips the loading/skeleton flash — used when we already have
  // fresh cached data on screen and just want to quietly confirm/refresh it.
  const fetchUsers = useCallback(async (opts = {}) => {
    const controller = new AbortController()
    fetchControllerRef.current?.abort()
    fetchControllerRef.current = controller

    if (!opts.silent) {
      setLoading(true)
      setLoadError('')
    }
    try {
      // NOTE: capped at 100 users, filtered/sorted client-side below — same
      // pattern the audit trail had before it moved to server-side paging.
      // If your org can exceed 100 accounts, this needs the same treatment
      // (push search/role/status/sort into listUsers()).
      const { users: rows } = await listUsers({ page: 1, perPage: 100, signal: controller.signal })
      setUsers(rows)
      usersCache = { data: rows, ts: Date.now() }
      setLoadError('')
    } catch (err) {
      if (err.name !== 'AbortError') setLoadError(err.message || 'Could not load users')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  // Session data (accurate login/logout/online status) is fetched
  // separately from listUserSessions — same audit_log-backed source the
  // AdminAuditTrail "User sessions" tab uses. Failure here degrades
  // gracefully: users list still loads, sign-in columns just show "—"
  // rather than blocking the whole page.
  const fetchSessions = useCallback(async (opts = {}) => {
    const controller = new AbortController()
    sessionsControllerRef.current?.abort()
    sessionsControllerRef.current = controller

    try {
      const rows = await listUserSessions({ signal: controller.signal, forceRefresh: opts.forceRefresh })
      setSessions(rows)
      sessionsCache = { data: rows, ts: Date.now() }
    } catch (err) {
      if (!isAbortError(err)) {
        // Non-fatal — leave whatever session data we already have in place
        // rather than blanking it on a transient failure.
      }
    }
  }, [])

  useEffect(() => {
    // Both requests fire together (not awaited sequentially), so total wait
    // is bounded by whichever is slower, not their sum. When we already
    // have fresh cached users on screen, fetch quietly in the background
    // instead of flashing the skeleton again.
    fetchUsers({ silent: isCacheFresh(usersCache) })
    fetchSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchUsers, fetchSessions])

  // Keeps "Online now" trustworthy without requiring a manual refresh —
  // same 30s cadence as AdminAuditTrail's User Sessions tab.
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSessions({ forceRefresh: true })
    }, SESSIONS_REFRESH_MS)
    return () => clearInterval(interval)
  }, [fetchSessions])

  async function handleRefreshAll() {
    await Promise.all([fetchUsers(), fetchSessions({ forceRefresh: true })])
  }

  // Reset to page 1 whenever filters or sort change.
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, roleFilter, statusFilter, sessionFilter, sortKey, sortDir])

  // Merge session data into each user by id — profiles.id and auth user id
  // are the same value, so this is a direct key match. This merged array is
  // what every downstream computation (stats, filters, sort, export) reads
  // from, so "last login" and "online" never come from two different
  // places again.
  const usersWithSessions = useMemo(() => {
    const sessionById = new Map(sessions.map((s) => [s.id, s]))
    return users.map((u) => ({
      ...u,
      session: sessionById.get(u.id) || null,
    }))
  }, [users, sessions])

  const stats = useMemo(() => {
    const total = usersWithSessions.length
    const active = usersWithSessions.filter((u) => !u.banned).length
    const deactivated = total - active
    const verifiers = usersWithSessions.filter((u) => u.role === 'verifier').length
    const approvers = usersWithSessions.filter((u) => u.role === 'approver').length
    const online = usersWithSessions.filter((u) => u.session?.status === 'online').length
    return { total, active, deactivated, verifiers, approvers, online }
  }, [usersWithSessions])

  const searchTokens = useMemo(() => normalizeSearchTokens(debouncedSearch), [debouncedSearch])

  const filteredUsers = useMemo(() => {
    let rows = usersWithSessions
    if (searchTokens.length > 0) {
      rows = rows.filter((u) => rowMatchesTokens(userSearchHaystack(u), searchTokens))
    }
    if (roleFilter !== 'all') rows = rows.filter((u) => u.role === roleFilter)
    if (statusFilter !== 'all') {
      rows = rows.filter((u) => (statusFilter === 'active' ? !u.banned : u.banned))
    }
    if (sessionFilter !== 'all') {
      rows = rows.filter((u) => (u.session?.status || 'never_logged_in') === sessionFilter)
    }
    return rows
  }, [usersWithSessions, searchTokens, roleFilter, statusFilter, sessionFilter])

  // Drop any selections that no longer match the active filters, so a bulk
  // action can never silently apply to a user who's been filtered out of
  // view. Keyed on filteredUsers (search/role/status/session), not on sort
  // — reordering the same visible set shouldn't clear a selection.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const visibleIds = new Set(filteredUsers.map((u) => u.id))
      let changed = false
      const next = new Set()
      prev.forEach((id) => {
        if (visibleIds.has(id)) next.add(id)
        else changed = true
      })
      return changed ? next : prev
    })
  }, [filteredUsers])

  const sortedUsers = useMemo(() => {
    const getter = USER_SORT_GETTERS[sortKey] || USER_SORT_GETTERS.name
    return [...filteredUsers].sort(compareBy(getter, sortDir))
  }, [filteredUsers, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sortedUsers.length / PAGE_SIZE))
  const pagedUsers = useMemo(
    () => sortedUsers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sortedUsers, page]
  )

  const hasActiveFilters =
    Boolean(search.trim()) || roleFilter !== 'all' || statusFilter !== 'all' || sessionFilter !== 'all'

  function resetFilters() {
    setSearch('')
    setRoleFilter('all')
    setStatusFilter('all')
    setSessionFilter('all')
  }

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'lastLogin' ? 'desc' : 'asc')
    }
  }

  // ---- Selection ----
  const pageIds = useMemo(() => pagedUsers.map((u) => u.id), [pagedUsers])
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id))

  const toggleOne = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  function toggleAllOnPage() {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) {
        pageIds.forEach((id) => next.delete(id))
      } else {
        pageIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const selectedUsers = useMemo(
    () => usersWithSessions.filter((u) => selectedIds.has(u.id)),
    [usersWithSessions, selectedIds]
  )
  const selectedActive = selectedUsers.filter((u) => !u.banned)
  const selectedDeactivated = selectedUsers.filter((u) => u.banned)

  // ---- Create / edit dialog ----
  function openCreateDialog() {
    setFormMode('create')
    setForm(EMPTY_FORM)
    setFormError('')
    setShowPassword(false)
    setFormOpen(true)
  }

  const openEditDialog = useCallback((user) => {
    const { firstName, lastName } = splitName(user.full_name)
    setFormMode('edit')
    setForm({
      id: user.id,
      email: user.email || '',
      firstName,
      lastName,
      role: user.role,
      password: '',
    })
    setFormError('')
    setFormOpen(true)
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError('')

    if (!form.email.trim()) {
      setFormError('Email is required.')
      return
    }
    if (!form.firstName.trim()) {
      setFormError('First name is required.')
      return
    }
    if (formMode === 'create' && form.password && form.password.length < 8) {
      setFormError('Temporary password must be at least 8 characters.')
      return
    }

    setSaving(true)
    try {
      if (formMode === 'create') {
        await createUser({
          email: form.email.trim(),
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          role: form.role,
          password: form.password || undefined,
        })
        showBanner('success', `${form.email} was created.`)
      } else {
        await updateUser({
          id: form.id,
          email: form.email.trim(),
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          role: form.role,
        })
        showBanner('success', 'User updated.')
      }
      setFormOpen(false)
      await fetchUsers()
    } catch (err) {
      setFormError(err.message || 'Something went wrong.')
    } finally {
      setSaving(false)
    }
  }

  // ---- Deactivate / reactivate (single + bulk share one flow) ----
  const openSingleConfirm = useCallback((user) => {
    setConfirmTarget({
      mode: 'single',
      action: user.banned ? 'reactivate' : 'deactivate',
      users: [user],
    })
    setAckChecked(false)
  }, [])

  function openBulkConfirm(action) {
    const targets = action === 'deactivate' ? selectedActive : selectedDeactivated
    if (targets.length === 0) return
    setConfirmTarget({ mode: 'bulk', action, users: targets })
    setAckChecked(false)
  }

  async function handleConfirmToggle() {
    if (!confirmTarget) return
    setConfirmBusy(true)
    const { action, users: targets } = confirmTarget
    try {
      await Promise.all(
        targets.map((u) => (action === 'reactivate' ? reactivateUser(u.id) : deactivateUser(u.id)))
      )
      if (targets.length === 1) {
        showBanner(
          'success',
          action === 'reactivate' ? `${targets[0].email} reactivated.` : `${targets[0].email} deactivated.`
        )
      } else {
        showBanner(
          'success',
          action === 'reactivate'
            ? `${targets.length} accounts reactivated.`
            : `${targets.length} accounts deactivated.`
        )
      }
      setSelectedIds((prev) => {
        const next = new Set(prev)
        targets.forEach((u) => next.delete(u.id))
        return next
      })
      setConfirmTarget(null)
      await fetchUsers()
    } catch (err) {
      showBanner('error', err.message || 'Action failed.')
    } finally {
      setConfirmBusy(false)
    }
  }

  const openResetConfirm = useCallback((user) => {
    setResetTarget(user)
  }, [])

  async function handleConfirmReset() {
    if (!resetTarget) return
    setResetBusy(true)
    try {
      await sendPasswordReset(resetTarget.email)
      showBanner('success', `Password reset email sent to ${resetTarget.email}.`)
      setResetTarget(null)
    } catch (err) {
      showBanner('error', err.message || 'Could not send reset email.')
    } finally {
      setResetBusy(false)
    }
  }

  // ---- Bulk role change ----
  function openRoleChangeDialog() {
    // Default to the majority role among the current selection, so the
    // common case (everyone selected already shares a role, or you're
    // promoting a mixed group to one role) needs the fewest clicks.
    const counts = selectedUsers.reduce((acc, u) => {
      acc[u.role] = (acc[u.role] || 0) + 1
      return acc
    }, {})
    const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
    setRoleChangeValue(majority || 'verifier')
    setRoleChangeOpen(true)
  }

  async function handleConfirmRoleChange() {
    if (selectedUsers.length === 0) return
    setRoleChangeBusy(true)
    try {
      // Only touch accounts that don't already have the target role — an
      // audit trail full of "role_changed: verifier -> verifier" no-op
      // entries would be noise, not signal.
      const targets = selectedUsers.filter((u) => u.role !== roleChangeValue)
      if (targets.length === 0) {
        showBanner('success', `Already all set to ${roleChangeValue}.`)
        setRoleChangeOpen(false)
        return
      }

      await Promise.all(
        targets.map((u) =>
          updateUser({
            id: u.id,
            email: u.email,
            ...splitName(u.full_name),
            role: roleChangeValue,
          })
        )
      )

      // Best-effort audit trail entry — mirrors the fire-and-forget pattern
      // used for report_exported elsewhere in this codebase.
      logAuditEvent('role_changed', {
        new_role: roleChangeValue,
        user_ids: targets.map((u) => u.id),
        count: targets.length,
      }).catch(() => {})

      showBanner(
        'success',
        targets.length === 1
          ? `${targets[0].email} is now ${roleChangeValue}.`
          : `${targets.length} accounts changed to ${roleChangeValue}.`
      )
      setRoleChangeOpen(false)
      setSelectedIds(new Set())
      await fetchUsers()
    } catch (err) {
      showBanner('error', err.message || 'Could not change roles.')
    } finally {
      setRoleChangeBusy(false)
    }
  }

  const handleViewActivity = useCallback((user) => {
    setDrawerUserId(user.id)
  }, [])

  const handleCopyEmail = useCallback(async (email) => {
    try {
      await navigator.clipboard.writeText(email)
      showBanner('success', `Copied ${email} to clipboard.`)
    } catch {
      showBanner('error', 'Could not copy to clipboard.')
    }
  }, [showBanner])

  // A single toggle handler used by both the row and card components for
  // the deactivate/reactivate action — routes to the existing single
  // confirmation flow.
  const handleToggleStatus = openSingleConfirm

  // ---- Export ----
  // Exports the currently filtered set (sortedUsers), not just the visible
  // page — matches the "export everything the filters currently describe"
  // behavior of the audit trail's exports.
  function buildUsersExportRows() {
    const header = [
      'Name', 'Email', 'Role', 'Account status', 'Sign-in status',
      'Last login', 'Last logout', 'Session duration', 'Account created',
    ]
    const rows = sortedUsers.map((u) => [
      u.full_name || '',
      u.email || '',
      u.role || '',
      u.banned ? 'Deactivated' : 'Active',
      u.session?.status === 'online' ? 'Online' :
        u.session?.status === 'stale' ? 'Session expired' :
        u.session?.status === 'offline' ? 'Offline' : 'Never signed in',
      formatAbsoluteTime(u.session?.lastLogin),
      formatAbsoluteTime(u.session?.lastLogout),
      formatDuration(u.session?.sessionDurationMs),
      formatAbsoluteTime(u.created_at),
    ])
    return { header, rows }
  }

  function handleExportCsv() {
    const { header, rows } = buildUsersExportRows()
    downloadCsv(header, rows, `users-${new Date().toISOString().slice(0, 10)}.csv`)
    logAuditEvent('report_exported', { report: 'users', format: 'csv', row_count: rows.length }).catch(() => {})
  }

  async function handleExportXlsx() {
    const { header, rows } = buildUsersExportRows()
    await downloadXlsx(header, rows, 'Users', `users-${new Date().toISOString().slice(0, 10)}.xlsx`)
    logAuditEvent('report_exported', { report: 'users', format: 'xlsx', row_count: rows.length }).catch(() => {})
  }

  function handleExportPdf() {
    const { header, rows } = buildUsersExportRows()
    downloadPdf(header, rows, 'Users', `users-${new Date().toISOString().slice(0, 10)}.pdf`)
    logAuditEvent('report_exported', { report: 'users', format: 'pdf', row_count: rows.length }).catch(() => {})
  }

  const isDeactivateAction = confirmTarget?.action === 'deactivate'
  const confirmDisabled = confirmBusy || (isDeactivateAction && !ackChecked)

  return (
    <div>
      {/* Toast container */}
      <div className="pointer-events-none fixed inset-x-4 top-4 z-50 mx-auto max-w-sm sm:right-6 sm:left-auto">
        {banner && <BannerToast banner={banner} onDismiss={() => setBanner(null)} />}
      </div>

      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50">
            <ShieldCheck className="h-5 w-5 text-teal-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-800">Manage users</h1>
            <p className="text-xs text-gray-500">
              {loading ? 'Loading…' : `${stats.active} active of ${stats.total} accounts · ${stats.online} online now`}
            </p>
          </div>
        </div>
        <Button onClick={openCreateDialog} className="transition-transform active:scale-95">
          <Plus className="mr-1.5 h-4 w-4" />
          New user
        </Button>
      </div>

      {/* Stats */}
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:mb-6 sm:grid-cols-5 sm:gap-3">
        {[
          { label: 'Total accounts', value: stats.total, icon: UsersIcon, tone: 'text-gray-700 bg-gray-100' },
          { label: 'Active', value: stats.active, icon: CheckCircle2, tone: 'text-green-700 bg-green-50' },
          { label: 'Online now', value: stats.online, icon: Radio, tone: 'text-teal-700 bg-teal-50' },
          { label: 'Deactivated', value: stats.deactivated, icon: ShieldAlert, tone: 'text-red-700 bg-red-50' },
          { label: 'Verifiers · Approvers', value: `${stats.verifiers} · ${stats.approvers}`, icon: ShieldCheck, tone: 'text-blue-700 bg-blue-50' },
        ].map((s) => (
          <Card key={s.label} className="flex items-center gap-2.5 px-3 py-2.5 sm:px-4 sm:py-3">
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md ${s.tone}`}>
              <s.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[11px] uppercase tracking-wide text-gray-400">{s.label}</p>
              <p className="text-base font-semibold text-gray-800">{loading ? '—' : s.value}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Toolbar */}
      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative flex-1 sm:min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or role"
            className="pl-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-600"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="flex-1 sm:w-36">
            {ROLE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="flex-1 sm:w-36">
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <Select value={sessionFilter} onChange={(e) => setSessionFilter(e.target.value)} className="flex-1 sm:w-44">
            {SESSION_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        {hasActiveFilters && (
          <Button variant="ghost" onClick={resetFilters} className="justify-center text-gray-500 sm:w-auto">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reset
          </Button>
        )}
        <div className="flex gap-2 sm:ml-auto">
          <Button variant="ghost" onClick={handleRefreshAll} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <ExportMenu
            disabled={loading || sortedUsers.length === 0}
            onExportCsv={handleExportCsv}
            onExportXlsx={handleExportXlsx}
            onExportPdf={handleExportPdf}
          />
        </div>
      </div>

      {/* Bulk actions bar */}
      <div
        className={`mb-3 overflow-hidden transition-all duration-200 ease-out ${
          selectedIds.size > 0 ? 'max-h-24 opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-900">
          <span className="font-medium">{selectedIds.size} selected</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={openRoleChangeDialog}>
              <UserCog className="mr-1.5 h-3.5 w-3.5" />
              Change role
            </Button>
            {selectedActive.length > 0 && (
              <Button size="sm" variant="destructive" onClick={() => openBulkConfirm('deactivate')}>
                <Ban className="mr-1.5 h-3.5 w-3.5" />
                Deactivate {selectedActive.length}
              </Button>
            )}
            {selectedDeactivated.length > 0 && (
              <Button size="sm" onClick={() => openBulkConfirm('reactivate')}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Reactivate {selectedDeactivated.length}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      </div>

      {/* Desktop table */}
      <Card className="hidden overflow-hidden sm:block">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={pageIds.length === 0}
                    aria-label="Select all on page"
                  />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Name" sortKey="name" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Email" sortKey="email" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Role" sortKey="role" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Status" sortKey="status" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Sign-in" sortKey="session" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Last login" sortKey="lastLogin" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <SkeletonRows />
              ) : loadError ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-red-600">
                    {loadError}
                  </td>
                </tr>
              ) : pagedUsers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center">
                    <UsersIcon className="mx-auto mb-2 h-8 w-8 text-gray-300" />
                    <p className="text-sm font-medium text-gray-600">No users found</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {hasActiveFilters ? 'Try adjusting your search or filters.' : 'Create your first user to get started.'}
                    </p>
                    {hasActiveFilters && (
                      <Button variant="ghost" size="sm" onClick={resetFilters} className="mt-3">
                        Clear filters
                      </Button>
                    )}
                  </td>
                </tr>
              ) : (
                pagedUsers.map((user, idx) => (
                  <UserRow
                    key={user.id ?? `user-${idx}`}
                    user={user}
                    selected={selectedIds.has(user.id)}
                    onToggleSelect={toggleOne}
                    onEdit={openEditDialog}
                    onReset={openResetConfirm}
                    onViewActivity={handleViewActivity}
                    onToggleStatus={handleToggleStatus}
                    onCopyEmail={handleCopyEmail}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Mobile cards */}
      <div className="space-y-2.5 sm:hidden">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="animate-pulse px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-full bg-gray-200" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-2/3 rounded bg-gray-200" />
                  <div className="h-3 w-1/2 rounded bg-gray-200" />
                </div>
              </div>
            </Card>
          ))
        ) : loadError ? (
          <Card className="px-4 py-8 text-center text-sm text-red-600">{loadError}</Card>
        ) : pagedUsers.length === 0 ? (
          <Card className="px-4 py-10 text-center">
            <UsersIcon className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            <p className="text-sm font-medium text-gray-600">No users found</p>
            <p className="mt-0.5 text-xs text-gray-400">
              {hasActiveFilters ? 'Try adjusting your search or filters.' : 'Create your first user to get started.'}
            </p>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={resetFilters} className="mt-3">
                Clear filters
              </Button>
            )}
          </Card>
        ) : (
          pagedUsers.map((user, idx) => (
            <UserCardMobile
              key={user.id ?? `user-${idx}`}
              user={user}
              selected={selectedIds.has(user.id)}
              onToggleSelect={toggleOne}
              onEdit={openEditDialog}
              onReset={openResetConfirm}
              onViewActivity={handleViewActivity}
              onToggleStatus={handleToggleStatus}
            />
          ))
        )}
      </div>

      {/* Pagination */}
      {!loading && !loadError && sortedUsers.length > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sortedUsers.length)} of {sortedUsers.length}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[3rem] text-center text-xs">
              {page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={formMode === 'create' ? 'New user' : 'Edit user'}
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">First name</label>
              <Input
                value={form.firstName}
                onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                required
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Last name</label>
              <Input
                value={form.lastName}
                onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Email</label>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              required
            />
          </div>

          {formMode === 'edit' && (
            <div className="flex items-center gap-1.5 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
              <Clock className="h-3.5 w-3.5" />
              Last login:{' '}
              {formatAbsoluteTime(usersWithSessions.find((u) => u.id === form.id)?.session?.lastLogin)}
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Role</label>
            <Select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-gray-400">
              {form.role === 'verifier'
                ? 'Verifiers review and prepare checks before they move to approval.'
                : 'Approvers give final sign-off on checks submitted for approval.'}
            </p>
          </div>

          {formMode === 'create' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Temporary password <span className="text-gray-400">(optional — leave blank to send a reset link instead)</span>
              </label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  minLength={8}
                  autoComplete="new-password"
                  className="pr-9"
                />
                {form.password && (
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                )}
              </div>
              {form.password && (
                <p className={`mt-1 text-xs ${form.password.length >= 8 ? 'text-green-600' : 'text-amber-600'}`}>
                  {form.password.length >= 8 ? 'Looks good.' : `At least 8 characters (${form.password.length}/8).`}
                </p>
              )}
            </div>
          )}

          {formError && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              {formError}
            </div>
          )}

          <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {formMode === 'create' ? 'Create user' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Deactivate / reactivate confirmation (single + bulk) */}
      <Dialog
        open={Boolean(confirmTarget)}
        onClose={() => (confirmBusy ? null : setConfirmTarget(null))}
        title={isDeactivateAction ? 'Deactivate account' + (confirmTarget?.users.length > 1 ? 's' : '') : 'Reactivate account' + (confirmTarget?.users.length > 1 ? 's' : '')}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${
              isDeactivateAction ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'
            }`}
          >
            {isDeactivateAction ? <Ban className="h-4.5 w-4.5" /> : <RotateCcw className="h-4.5 w-4.5" />}
          </div>
          <div className="min-w-0 flex-1">
            {confirmTarget?.mode === 'single' ? (
              <p className="text-sm text-gray-600">
                {isDeactivateAction ? (
                  <>
                    <span className="font-medium text-gray-800">{confirmTarget.users[0].email}</span> will be signed
                    out and unable to log in. Their records are kept — this doesn't delete anything.
                  </>
                ) : (
                  <>
                    <span className="font-medium text-gray-800">{confirmTarget.users[0].email}</span> will regain
                    access immediately.
                  </>
                )}
              </p>
            ) : (
              <div className="text-sm text-gray-600">
                <p className="mb-2">
                  This will {isDeactivateAction ? 'sign out and block' : 'restore access for'}{' '}
                  <span className="font-medium text-gray-800">{confirmTarget?.users.length} accounts</span>:
                </p>
                <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-xs">
                  {confirmTarget?.users.map((u) => (
                    <li key={u.id} className="truncate text-gray-600">
                      {u.email}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isDeactivateAction && (
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={ackChecked}
                  onChange={(e) => setAckChecked(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                />
                I understand access will be revoked immediately.
              </label>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => setConfirmTarget(null)} disabled={confirmBusy}>
            Cancel
          </Button>
          <Button
            variant={isDeactivateAction ? 'destructive' : 'default'}
            onClick={handleConfirmToggle}
            disabled={confirmDisabled}
          >
            {confirmBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {isDeactivateAction ? 'Deactivate' : 'Reactivate'}
            {confirmTarget?.users.length > 1 ? ` ${confirmTarget.users.length}` : ''}
          </Button>
        </div>
      </Dialog>

      {/* Bulk role change */}
      <Dialog
        open={roleChangeOpen}
        onClose={() => (roleChangeBusy ? null : setRoleChangeOpen(false))}
        title={`Change role for ${selectedUsers.length} account${selectedUsers.length > 1 ? 's' : ''}`}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-purple-50 text-purple-600">
            <UserCog className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-sm text-gray-600">
              These accounts will all be set to the role below:
            </p>
            <ul className="mb-3 max-h-28 space-y-1 overflow-y-auto rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-xs">
              {selectedUsers.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 truncate text-gray-600">
                  <span className="truncate">{u.email}</span>
                  <Badge className={`${ROLE_BADGE_STYLE[u.role] || ''} flex-shrink-0`}>{u.role}</Badge>
                </li>
              ))}
            </ul>
            <label className="mb-1 block text-xs font-medium text-gray-600">New role</label>
            <Select value={roleChangeValue} onChange={(e) => setRoleChangeValue(e.target.value)}>
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => setRoleChangeOpen(false)} disabled={roleChangeBusy}>
            Cancel
          </Button>
          <Button onClick={handleConfirmRoleChange} disabled={roleChangeBusy}>
            {roleChangeBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Apply
          </Button>
        </div>
      </Dialog>

      {/* Password reset confirmation */}
      <Dialog
        open={Boolean(resetTarget)}
        onClose={() => (resetBusy ? null : setResetTarget(null))}
        title="Send password reset"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600">
            <KeyRound className="h-4.5 w-4.5" />
          </div>
          <p className="text-sm text-gray-600">
            A password reset link will be emailed to{' '}
            <span className="font-medium text-gray-800">{resetTarget?.email}</span>. Their current password stays
            valid until they complete the reset.
          </p>
        </div>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => setResetTarget(null)} disabled={resetBusy}>
            Cancel
          </Button>
          <Button onClick={handleConfirmReset} disabled={resetBusy}>
            {resetBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Send reset email
          </Button>
        </div>
      </Dialog>

      <UserDetailDrawer
        userId={drawerUserId}
        open={Boolean(drawerUserId)}
        onClose={() => setDrawerUserId(null)}
      />
    </div>
  )
}