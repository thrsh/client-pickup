import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ScrollText,
  Search,
  RefreshCw,
  Download,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  X,
  Filter,
  Calendar,
  UserCircle2,
  Send,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Undo2,
  RefreshCcw as ResubmitIcon,
  Clock3,
  FileCheck2,
  Info,
  LogIn,
  LogOut,
  KeyRound,
  UserCheck,
  UserX,
  ShieldAlert,
  FileBarChart2,
  FileDown,
  AlertTriangle,
  UploadCloud,
  FileSpreadsheet,
  FileText,
  Users,
  Circle,
  Radio,
  AlertCircle,
  UserPlus,
  Landmark,
  Hash,
  UserSquare2,
  BadgeCheck,
  Receipt,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { Select } from '../../components/ui/select'
import {
  listCheckActivityLog,
  listCheckActivityActors,
  listAuditLog,
  listUserSessions,
  logAuditEvent,
  isAbortError,
  PAGE_SIZE,
} from '../../lib/adminAuditApi'
import { downloadCsv, downloadXlsx, downloadPdf, ExportMenu } from '../../lib/exportUtils'

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

function formatDateTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatRelativeTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000)
  const diffMin = Math.round(diffSec / 60)
  const diffHr = Math.round(diffMin / 60)
  const diffDay = Math.round(diffHr / 24)
  if (diffSec < 60) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 30) return `${diffDay}d ago`
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
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

function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '—'
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(amount)
}

function getInitials(name) {
  const source = (name || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

const AVATAR_PALETTE = [
  'bg-teal-100 text-teal-700',
  'bg-blue-100 text-blue-700',
  'bg-amber-100 text-amber-700',
  'bg-violet-100 text-violet-700',
  'bg-rose-100 text-rose-700',
  'bg-emerald-100 text-emerald-700',
]

function avatarStyleFor(key = '') {
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % AVATAR_PALETTE.length
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}
function normalizeActorOption(raw) {
  const id = raw?.id ?? raw?.actor_id ?? raw?.user_id ?? raw?.value
  const name = raw?.name ?? raw?.actor_name ?? raw?.full_name ?? raw?.label
  if (id === null || id === undefined) return null
  return { id: String(id), name: name || String(id) }
}

// A stable identity for "who did this" that works even when a row has no
// usable id field — which is what silently emptied the user filters: the
// Actor/Performed-by column always has a name (that's what the table
// renders), but the id field it was keyed on isn't always populated by the
// backend. Falling back to a name-derived key means the filter is always
// buildable from whatever is already on screen, instead of depending on a
// separate id field or a separate actor-list endpoint being complete.
function actorKeyOf(id, name) {
  if (id !== null && id !== undefined && String(id).trim() !== '') return String(id)
  if (name !== null && name !== undefined && String(name).trim() !== '') return `name:${name}`
  return null
}

function useDebouncedValue(value, delay) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

// Refetches whenever the tab/window regains focus or becomes visible again,
// and polls on an interval as a safety net — so admins never have to
// manually reload the page to see activity performed elsewhere (e.g. an
// approver approving a check in another tab).
function useLiveRefresh(refetchFn, { pollMs = 30000 } = {}) {
  const refetchRef = useRef(refetchFn)
  refetchRef.current = refetchFn

  useEffect(() => {
    function handleFocus() {
      refetchRef.current()
    }
    function handleVisibility() {
      if (document.visibilityState === 'visible') refetchRef.current()
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    const interval = pollMs ? setInterval(() => refetchRef.current(), pollMs) : null

    return () => {
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (interval) clearInterval(interval)
    }
  }, [pollMs])
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

function SkeletonRows({ count = 6, cols = 6 }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i} className="animate-pulse">
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-3.5 w-24 rounded bg-gray-200" />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

// Reusable truncated-with-tooltip cell. Caps the visible width so a long
// payee/company name can never blow out the row height or push other
// columns off-screen — the full value is still available on hover/focus
// via the native title tooltip, and to screen readers unchanged.
function TruncatedCell({ value, className = '', maxWidthClass = 'max-w-[10rem]' }) {
  const display = value && String(value).trim() ? value : '—'
  return (
    <span
      title={display !== '—' ? display : undefined}
      className={`block truncate ${maxWidthClass} ${className}`}
    >
      {display}
    </span>
  )
}

// ----------------------------------------------------------------------------
// Robust search matching — done client-side against whatever rows are
// currently loaded, independent of the backend's own `search` param. This
// is deliberate: it guarantees typing something the user can see on screen
// always narrows the list, even if the server-side search implementation is
// partial, or silently ignores fields like collector/verifier/remarks.
// ----------------------------------------------------------------------------

// Splits a query into lowercase tokens and requires every token to appear
// somewhere in the haystack — so "juan cruz bdo" matches a row containing
// all three words in any field, not just one exact substring.
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

function checkLogSearchHaystack(log) {
  const meta = getCheckActionMeta(log.action)
  return [
    log.actor_name,
    log.actor_role,
    meta.label,
    log.check?.check_no,
    log.check?.payee,
    log.check?.payor,
    log.check?.bank,
    log.collector_name,
    log.submitted_by_name,
    log.approved_by_name,
    log.or_no,
    log.remarks,
    log.check?.amount != null ? String(log.check.amount) : null,
    log.check?.amount != null ? formatCurrency(log.check.amount) : null,
    formatDateTime(log.performed_at),
  ]
}

function systemLogSearchHaystack(log) {
  const meta = getSystemActionMeta(log.action)
  const metaValues = log.metadata ? Object.values(log.metadata).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))) : []
  return [
    log.performed_by_name,
    log.performed_by_role,
    meta.label,
    log.target_type,
    log.target_id,
    formatDateTime(log.performed_at),
    ...metaValues,
  ]
}

function sessionSearchHaystack(session) {
  return [
    session.name,
    session.role,
    getSessionStatusMeta(session.status).label,
    formatDateTime(session.lastLogin),
    formatDateTime(session.lastLogout),
  ]
}

// Generic client-side comparator used for every sortable column across all
// three tabs. `getters` maps a sortKey to a function that pulls the
// comparable value off a row; numeric getters are compared numerically,
// everything else falls back to locale-aware string comparison so sorting
// never breaks just because a new column doesn't have a server-side
// equivalent.
function compareBy(getter, dir) {
  const mult = dir === 'asc' ? 1 : -1
  return (a, b) => {
    const va = getter(a)
    const vb = getter(b)
    if (va === null || va === undefined || va === '') return vb === null || vb === undefined || vb === '' ? 0 : 1
    if (vb === null || vb === undefined || vb === '') return -1
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult
    return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * mult
  }
}

// A dropdown "advanced filter" for picking one, several, or all users from a
// list — the "selected users" filter used across tabs. Includes its own
// search box so it stays usable with long user lists, a live count badge on
// the trigger button, and full keyboard/click-outside dismissal.
function MultiSelectFilter({ label, icon: Icon, options, selected, onChange, className = '' }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    function handleEscape(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [])

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  function toggleOption(id) {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id))
    else onChange([...selected, id])
  }

  const allSelected = selected.length === 0
  const summaryLabel = allSelected
    ? `All ${label.toLowerCase()}`
    : selected.length === 1
    ? options.find((o) => o.value === selected[0])?.label || '1 selected'
    : `${selected.length} selected`

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center gap-1.5 rounded-md border px-3 py-2 text-sm transition-colors ${
          allSelected ? 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50' : 'border-teal-300 bg-teal-50 text-teal-800 hover:bg-teal-100'
        }`}
      >
        {Icon && <Icon className="h-3.5 w-3.5 flex-shrink-0" />}
        <span className="flex-1 truncate text-left">{summaryLabel}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
          {options.length > 6 && (
            <div className="relative mb-1.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Find ${label.toLowerCase()}…`}
                className="w-full rounded border border-gray-200 py-1.5 pl-8 pr-2 text-xs focus:border-teal-400 focus:outline-none"
              />
            </div>
          )}
          <div className="flex items-center justify-between px-1 pb-1.5 text-[11px]">
            <button
              type="button"
              onClick={() => onChange(options.map((o) => o.value))}
              className="text-teal-700 hover:underline disabled:pointer-events-none disabled:opacity-40"
              disabled={!allSelected && selected.length === options.length}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-gray-400 hover:underline disabled:pointer-events-none disabled:opacity-40"
              disabled={allSelected}
            >
              Reset (show all)
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <p className="px-2 py-2 text-xs text-gray-400">No matches</p>
            ) : (
              filteredOptions.map((opt) => {
                const checked = allSelected || selected.includes(opt.value)
                return (
                  <label
                    key={opt.value}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={allSelected ? true : selected.includes(opt.value)}
                      onChange={() => (allSelected ? onChange(options.filter((o) => o.value !== opt.value).map((o) => o.value)) : toggleOption(opt.value))}
                      className="h-3.5 w-3.5 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                    />
                    <span className="truncate">{opt.label}</span>
                  </label>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const DATE_RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range…' },
]

// today, in the browser's local timezone, as 'YYYY-MM-DD' — the max
// selectable date for either end of a custom range, so nobody picks a
// future date and silently gets zero rows back.
function todayLocalDateString() {
  const d = new Date()
  const offset = d.getTimezoneOffset()
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10)
}

// Two native date inputs shown only when 'custom' is selected. Native
// <input type="date"> is used deliberately over a custom picker component —
// it's fully accessible and keyboard-operable out of the box, with zero
// added dependencies.
function CustomDateRangeInputs({ from, to, onFromChange, onToChange, error }) {
  const maxDate = todayLocalDateString()
  return (
    <div className="flex flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
      <div className="flex flex-1 items-center gap-1.5">
        <label htmlFor="date-from" className="text-xs font-medium text-gray-500 sm:sr-only">From</label>
        <Input
          id="date-from"
          type="date"
          value={from}
          max={to || maxDate}
          onChange={(e) => onFromChange(e.target.value)}
          aria-invalid={!!error}
          className="flex-1"
        />
      </div>
      <span className="hidden text-gray-400 sm:inline">–</span>
      <div className="flex flex-1 items-center gap-1.5">
        <label htmlFor="date-to" className="text-xs font-medium text-gray-500 sm:sr-only">To</label>
        <Input
          id="date-to"
          type="date"
          value={to}
          min={from}
          max={maxDate}
          onChange={(e) => onToChange(e.target.value)}
          aria-invalid={!!error}
          className="flex-1"
        />
      </div>
      {error && (
        <p className="flex items-center gap-1 text-xs text-red-600 sm:ml-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {error}
        </p>
      )}
    </div>
  )
}

function DiffList({ previous, next }) {
  if (!previous && !next) return null
  const keys = Array.from(new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]))
  const changed = keys.filter((k) => JSON.stringify(previous?.[k]) !== JSON.stringify(next?.[k]))
  if (changed.length === 0) return null
  return (
    <div className="sm:col-span-2 space-y-1 rounded bg-amber-50 px-2 py-1.5 text-amber-800">
      <p className="font-medium">What changed:</p>
      {changed.map((k) => (
        <p key={k}>
          <span className="font-medium">{k}:</span>{' '}
          <span className="line-through opacity-70">{String(previous?.[k] ?? '—')}</span>{' '}
          → <span className="font-semibold">{String(next?.[k] ?? '—')}</span>
        </p>
      ))}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Error boundary — isolates a render-time crash to one tab instead of
// blanking the whole page. Class component because React has no hook
// equivalent for getDerivedStateFromError.
// ----------------------------------------------------------------------------

class TabErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('AdminAuditTrail tab crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-10 text-center">
          <AlertTriangle className="h-6 w-6 text-red-500" />
          <p className="text-sm font-medium text-red-700">This tab hit an unexpected error.</p>
          <p className="max-w-sm text-xs text-red-500">{this.state.error?.message || 'Please try refreshing.'}</p>
          <Button variant="ghost" size="sm" onClick={() => this.setState({ error: null })} className="mt-1">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Try again
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}

// ----------------------------------------------------------------------------
// Tab 1: Check activity (submit / approve / reject / recall / resubmit /
// return / expire / pick up)
// ----------------------------------------------------------------------------

const CHECK_ACTION_META = {
  submitted_for_approval: { label: 'Submitted for approval', icon: Send, tone: 'text-amber-700 bg-amber-50' },
  approved: { label: 'Approved', icon: CheckCircle2, tone: 'text-green-700 bg-green-50' },
  rejected: { label: 'Rejected', icon: XCircle, tone: 'text-red-700 bg-red-50' },
  recalled: { label: 'Recalled by verifier', icon: Undo2, tone: 'text-orange-700 bg-orange-50' },
  resubmitted: { label: 'Resubmitted after correction', icon: ResubmitIcon, tone: 'text-blue-700 bg-blue-50' },
  returned: { label: 'Returned', icon: RotateCcw, tone: 'text-orange-700 bg-orange-50' },
  released: {
    label: 'Returned to pool',
    icon: RotateCcw,
    tone: 'text-gray-700 bg-gray-100',
    note: 'Stored as "released" in the database — this means returned to the pool, not released to a collector.',
  },
  expired: { label: 'Reservation expired', icon: Clock3, tone: 'text-gray-700 bg-gray-100' },
  picked_up: { label: 'Picked up', icon: FileCheck2, tone: 'text-teal-700 bg-teal-50' },
}

function getCheckActionMeta(action) {
  return CHECK_ACTION_META[action] || { label: action || 'Activity', icon: Info, tone: 'text-gray-600 bg-gray-100' }
}

const ROLE_FILTER_OPTIONS = [
  { value: 'all', label: 'All roles' },
  { value: 'admin', label: 'Admin' },
  { value: 'verifier', label: 'Verifier' },
  { value: 'approver', label: 'Approver' },
]

const ROLE_BADGE_STYLE = {
  admin: 'bg-purple-100 text-purple-800',
  verifier: 'bg-blue-100 text-blue-800',
  approver: 'bg-amber-100 text-amber-800',
}

const CHECK_ACTION_FILTER_OPTIONS = [
  { value: 'all', label: 'All actions' },
  ...Object.entries(CHECK_ACTION_META).map(([value, meta]) => ({ value, label: meta.label })),
]

function hasExpandableCheckDetails(log) {
  return Boolean(
    log.or_no ||
      log.remarks ||
      log.collector_name ||
      log.submitted_by_name ||
      log.approved_by_name ||
      log.check ||
      log.previous_data ||
      log.new_data
  )
}

// When an approver approves a check, the backend also writes a "picked_up"
// event for the same check as part of that same action — approval *is* the
// pickup confirmation in that flow, so showing both is the same event
// twice, not two distinct events. A "picked_up" entry is only hidden when
// it lands within a few seconds of an "approved" entry for the *same*
// check; a pickup logged well before or after any approval (e.g. a genuine
// separate pickup step) is left alone.
//
// Ideally this dedupe belongs server-side (stop writing two rows for one
// action), but this keeps the audit view correct without a backend change.
const AUTO_PICKUP_WINDOW_MS = 15000

function dedupeAutoPickupEvents(rows) {
  const approvalTimesByCheck = new Map()
  rows.forEach((r) => {
    if (r.action === 'approved' && r.check?.check_no) {
      const key = r.check.check_no
      const list = approvalTimesByCheck.get(key) || []
      list.push(new Date(r.performed_at).getTime())
      approvalTimesByCheck.set(key, list)
    }
  })

  return rows.filter((r) => {
    if (r.action !== 'picked_up' || !r.check?.check_no) return true
    const approvalTimes = approvalTimesByCheck.get(r.check.check_no)
    if (!approvalTimes) return true
    const pickedAt = new Date(r.performed_at).getTime()
    const isAutoFromApproval = approvalTimes.some((t) => Math.abs(pickedAt - t) <= AUTO_PICKUP_WINDOW_MS)
    return !isAutoFromApproval
  })
}

// Resolves a display-friendly "verifier" for a row. Verifiers are the ones
// who submit/resubmit checks for approval, so submitted_by_name is the
// closest first-class field to "which verifier handled this" for the
// majority of rows; recalled/rejected rows fall back to nothing rather than
// guessing.
function getVerifierName(log) {
  return log.submitted_by_name || null
}

// Memoized so an unrelated re-render of CheckActivityTab (a filter keystroke,
// a countdown-driven state change, etc.) doesn't force every row to
// re-reconcile — only rows whose own `log` reference or `isExpanded` flag
// actually changed re-render. `onToggle` is a stable callback from the
// parent (see toggleExpanded below), so it never breaks memoization.
const CheckLogRow = React.memo(function CheckLogRow({ log, isExpanded, onToggle }) {
  const meta = getCheckActionMeta(log.action)
  const Icon = meta.icon
  const expandable = hasExpandableCheckDetails(log)
  const verifierName = getVerifierName(log)

  return (
    <React.Fragment>
      <tr
        className={`group cursor-pointer transition-colors hover:bg-gray-50 ${isExpanded ? 'bg-gray-50' : ''}`}
        onClick={() => expandable && onToggle(log.id)}
      >
        <td className="whitespace-nowrap px-4 py-3 align-top">
          <span className="block text-gray-700">{formatDateTime(log.performed_at)}</span>
          <span className="block text-xs text-gray-400">{formatRelativeTime(log.performed_at)}</span>
        </td>
        <td className="px-4 py-3 align-top">
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarStyleFor(
                log.actor_name || ''
              )}`}
            >
              {getInitials(log.actor_name)}
            </div>
            <TruncatedCell value={log.actor_name || 'Unknown'} className="font-medium text-gray-800" maxWidthClass="max-w-[9rem]" />
          </div>
        </td>
        <td className="px-4 py-3 align-top">
          <Badge className={ROLE_BADGE_STYLE[log.actor_role] || 'bg-gray-100 text-gray-700'}>
            {log.actor_role || 'unknown'}
          </Badge>
        </td>
        <td className="px-4 py-3 align-top">
          <span
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium ${meta.tone}`}
            title={meta.note}
          >
            <Icon className="h-3.5 w-3.5" />
            {meta.label}
            {meta.note && <Info className="h-3 w-3 opacity-50" />}
          </span>
        </td>
        <td className="whitespace-nowrap px-4 py-3 align-top font-mono text-xs text-gray-600">
          {log.check?.check_no || '—'}
        </td>
        <td className="px-4 py-3 align-top text-gray-700">
          <TruncatedCell value={log.check?.payee} maxWidthClass="max-w-[11rem]" />
        </td>
        <td className="px-4 py-3 align-top text-gray-600">
          <TruncatedCell value={log.check?.bank} maxWidthClass="max-w-[8rem]" />
        </td>
        <td className="px-4 py-3 align-top text-gray-700">
          {verifierName ? (
            <TruncatedCell value={verifierName} maxWidthClass="max-w-[8rem]" />
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
        <td className="px-4 py-3 align-top text-gray-700">
          {log.collector_name ? (
            <TruncatedCell value={log.collector_name} maxWidthClass="max-w-[8rem]" />
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-3 align-top text-right tabular-nums font-medium text-gray-800">
          {log.check ? formatCurrency(log.check.amount) : '—'}
        </td>
        <td className="px-4 py-3 align-top text-right">
          {expandable && (
            <ChevronDown className={`ml-auto h-4 w-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
          )}
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-gray-50/60">
          <td colSpan={11} className="px-4 pb-4 pt-1">
            <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-md border border-gray-200 bg-white p-3 text-xs text-gray-600 sm:grid-cols-2">
              {log.check && (
                <>
                  <p><span className="font-medium text-gray-700">Payor:</span> {log.check.payor || '—'}</p>
                  <p><span className="font-medium text-gray-700">Amount:</span> {formatCurrency(log.check.amount)}</p>
                  <p><span className="font-medium text-gray-700">Bank:</span> {log.check.bank || '—'}</p>
                </>
              )}
              {log.or_no && <p><span className="font-medium text-gray-700">OR #:</span> {log.or_no}</p>}
              {log.ar_collected !== null && log.ar_collected !== undefined && (
                <p><span className="font-medium text-gray-700">AR collected:</span> {log.ar_collected ? 'Yes' : 'No'}</p>
              )}
              {log.attached_2307 !== null && log.attached_2307 !== undefined && (
                <p><span className="font-medium text-gray-700">2307 attached:</span> {log.attached_2307 ? 'Yes' : 'No'}</p>
              )}
              {log.collector_name && <p><span className="font-medium text-gray-700">Collector:</span> {log.collector_name}</p>}
              {verifierName && <p><span className="font-medium text-gray-700">Verifier (submitted by):</span> {verifierName}</p>}
              {log.approved_by_name && <p><span className="font-medium text-gray-700">Approved by:</span> {log.approved_by_name}</p>}
              {log.remarks && (
                <p className="sm:col-span-2">
                  <span className="font-medium text-gray-700">
                    {log.action === 'recalled' ? 'Recall reason:' : 'Remarks:'}
                  </span>{' '}
                  {log.remarks}
                </p>
              )}
              <DiffList previous={log.previous_data} next={log.new_data} />
              {meta.note && (
                <p className="sm:col-span-2 flex items-start gap-1.5 rounded bg-blue-50 px-2 py-1.5 text-blue-700">
                  <Info className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  {meta.note}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </React.Fragment>
  )
})

const CheckLogCardMobile = React.memo(function CheckLogCardMobile({ log, isExpanded, onToggle }) {
  const meta = getCheckActionMeta(log.action)
  const Icon = meta.icon
  const expandable = hasExpandableCheckDetails(log)
  const verifierName = getVerifierName(log)

  return (
    <Card className="px-4 py-3">
      <div className={expandable ? 'cursor-pointer' : ''} onClick={() => expandable && onToggle(log.id)}>
        <div className="flex items-start gap-2.5">
          <div
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarStyleFor(
              log.actor_name || ''
            )}`}
          >
            {getInitials(log.actor_name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium text-gray-800">{log.actor_name || 'Unknown'}</p>
              <span className="flex flex-shrink-0 flex-col items-end text-right">
                <span className="text-[11px] text-gray-500">{formatDateTime(log.performed_at)}</span>
                <span className="text-[10px] text-gray-400">{formatRelativeTime(log.performed_at)}</span>
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge className={ROLE_BADGE_STYLE[log.actor_role] || 'bg-gray-100 text-gray-700'}>
                {log.actor_role || 'unknown'}
              </Badge>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.tone}`}>
                <Icon className="h-3 w-3" />
                {meta.label}
              </span>
            </div>
            {log.check && (
              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                <p className="flex items-center gap-1 truncate">
                  <Hash className="h-3 w-3 flex-shrink-0 text-gray-400" />
                  <span className="truncate font-mono">{log.check.check_no}</span>
                </p>
                <p className="truncate text-right tabular-nums font-medium text-gray-700">{formatCurrency(log.check.amount)}</p>
                <p className="col-span-2 truncate" title={log.check.payee}>
                  <span className="text-gray-400">Payee:</span> {log.check.payee || '—'}
                </p>
                <p className="truncate"><span className="text-gray-400">Bank:</span> {log.check.bank || '—'}</p>
              </div>
            )}
            {(verifierName || log.collector_name) && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                {verifierName && <span className="truncate"><span className="text-gray-400">Verifier:</span> {verifierName}</span>}
                {log.collector_name && <span className="truncate"><span className="text-gray-400">Collector:</span> {log.collector_name}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
      {isExpanded && expandable && (
        <div className="mt-2.5 space-y-1 rounded-md border border-gray-200 bg-gray-50 p-2.5 text-[11px] text-gray-600">
          {log.or_no && <p><span className="font-medium text-gray-700">OR #:</span> {log.or_no}</p>}
          {log.approved_by_name && <p><span className="font-medium text-gray-700">Approved by:</span> {log.approved_by_name}</p>}
          {log.remarks && <p><span className="font-medium text-gray-700">Remarks:</span> {log.remarks}</p>}
          <DiffList previous={log.previous_data} next={log.new_data} />
          {meta.note && <p className="text-blue-700">{meta.note}</p>}
        </div>
      )}
    </Card>
  )
})

// Client-side getters for every sortable column in the Check Activity
// table. Sorting is done entirely client-side (see CheckActivityTab) so it
// works consistently across every column, including ones — Payee, Verifier,
// Collector — that the backend's own sort parameter was never taught about.
const CHECK_SORT_GETTERS = {
  time: (l) => new Date(l.performed_at).getTime(),
  actor: (l) => (l.actor_name || '').toLowerCase(),
  role: (l) => (l.actor_role || '').toLowerCase(),
  action: (l) => getCheckActionMeta(l.action).label,
  checkNo: (l) => l.check?.check_no || '',
  payee: (l) => (l.check?.payee || '').toLowerCase(),
  bank: (l) => (l.check?.bank || '').toLowerCase(),
  verifier: (l) => (getVerifierName(l) || '').toLowerCase(),
  collector: (l) => (l.collector_name || '').toLowerCase(),
  amount: (l) => (l.check?.amount != null ? Number(l.check.amount) : null),
}

// How many rows we pull from the server per fetch. Search, actor
// selection, and sorting are all resolved client-side against this batch —
// see the note above CheckActivityTab for why. Large enough to cover the
// vast majority of role/action/date-filtered windows in one request.
const FETCH_BATCH_SIZE = 1000

function CheckActivityTab() {
  const [searchParams, setSearchParams] = useSearchParams()

  const [logs, setLogs] = useState([])
  const [serverTotal, setServerTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // Actors fetched from the dedicated actor-list endpoint. This is kept
  // separate from the rendered `actorOptions` (below) because that
  // endpoint is a secondary/supplementary source — if it's slow, empty, or
  // returns an unexpected shape, the filter must still work from whatever
  // actors are already visible in the loaded rows.
  const [fetchedActorOptions, setFetchedActorOptions] = useState([])
  const fetchControllerRef = useRef(null)
  const actorControllerRef = useRef(null)

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 200)
  const [roleFilter, setRoleFilter] = useState('all')
  const [actionFilter, setActionFilter] = useState('all')
  const [dateRange, setDateRange] = useState('30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [dateRangeError, setDateRangeError] = useState('')
  // Advanced "selected users" filter — supports zero (= everyone), one, or
  // many actors at once. Seeded from a single ?actorId= deep link (e.g. a
  // "View activity" link from Manage Users) so those links keep working.
  const initialActorId = searchParams.get('actorId')
  const [actorFilters, setActorFilters] = useState(initialActorId ? [initialActorId] : [])

  const [sortKey, setSortKey] = useState('time')
  const [sortDir, setSortDir] = useState('desc')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState(null)

  // Fetches a large batch from the server filtered by role/action/date —
  // the filters the backend is known to apply correctly. Search text,
  // actor selection, sorting, and pagination are all then resolved
  // client-side below, so they work reliably regardless of what the
  // backend's own search/sort implementation does or doesn't support.
  const fetchLogs = useCallback(async () => {
    fetchControllerRef.current?.abort()
    const controller = new AbortController()
    fetchControllerRef.current = controller

    setLoadError('')
    try {
      if (dateRange === 'custom' && (!customFrom || !customTo)) {
        setDateRangeError('Pick both a start and end date.')
        return
      }
      setDateRangeError('')

      const { logs: rows, total: rowTotal } = await listCheckActivityLog({
        page: 1,
        perPage: FETCH_BATCH_SIZE,
        role: roleFilter,
        action: actionFilter,
        sinceDays: dateRange === 'all' || dateRange === 'custom' ? null : Number(dateRange),
        fromDate: dateRange === 'custom' ? customFrom : null,
        toDate: dateRange === 'custom' ? customTo : null,
        sortKey: 'time',
        sortDir: 'desc',
        signal: controller.signal,
      })
      setLogs(rows)
      setServerTotal(rowTotal)
    } catch (err) {
      if (!isAbortError(err)) setLoadError(err?.message || 'Could not load the activity log')
    }
  }, [roleFilter, actionFilter, dateRange, customFrom, customTo])

  useEffect(() => {
    setLoading(true)
    fetchLogs().finally(() => setLoading(false))
    return () => fetchControllerRef.current?.abort()
  }, [fetchLogs])

  // Keep data fresh without requiring a manual page reload: refetch on
  // focus/visibility change, plus a periodic poll as a safety net.
  useLiveRefresh(fetchLogs)

  // Actor list is cached in the API layer (5 min TTL), so this is cheap
  // even across tab-switch remounts — it only hits the network once per
  // cache window, and concurrent mounts share one in-flight request.
  useEffect(() => {
    actorControllerRef.current?.abort()
    const controller = new AbortController()
    actorControllerRef.current = controller

    listCheckActivityActors({ signal: controller.signal })
      .then((data) => {
        setFetchedActorOptions(Array.isArray(data) ? data.map(normalizeActorOption).filter(Boolean) : [])
      })
      .catch((err) => {
        if (!isAbortError(err)) setFetchedActorOptions([])
      })

    return () => controller.abort()
  }, [])

  async function handleRefresh() {
    setRefreshing(true)
    await fetchLogs()
    setRefreshing(false)
  }

  // Keep a single selected actor in the URL so a filtered link (e.g. "View
  // activity" from Manage Users) is shareable and survives a reload. With
  // multiple actors selected the URL is left alone — that combination isn't
  // meant to be a shareable deep link.
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (actorFilters.length === 1) next.set('actorId', actorFilters[0])
    else next.delete('actorId')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorFilters])

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, roleFilter, actionFilter, dateRange, customFrom, customTo, actorFilters, sortKey, sortDir])

  // Collapses "approved" + its auto-generated "picked_up" twin into a
  // single visible event. See dedupeAutoPickupEvents for details.
  const deduped = useMemo(() => dedupeAutoPickupEvents(logs), [logs])

  // Robust client-side search: tokenized, case-insensitive, matched against
  // every field visible in the row or its expanded detail. This runs
  // regardless of what the backend does with a `search` param, so typing
  // something always narrows what's on screen.
  const searchTokens = useMemo(() => normalizeSearchTokens(debouncedSearch), [debouncedSearch])
  const searched = useMemo(() => {
    if (searchTokens.length === 0) return deduped
    return deduped.filter((l) => rowMatchesTokens(checkLogSearchHaystack(l), searchTokens))
  }, [deduped, searchTokens])

  // Actors available to filter by. Primarily derived straight from the
  // loaded rows — this is what actually populates the dropdown, since
  // `logs` is guaranteed to have the same actor data the Actor column
  // renders. The dedicated actors endpoint is merged in on top so a user
  // with zero activity in the current role/action/date window can still be
  // selected (e.g. to confirm they have no matching events).
  const actorOptions = useMemo(() => {
    const byKey = new Map()
    logs.forEach((l) => {
      const key = actorKeyOf(l.actor_id, l.actor_name)
      if (key && !byKey.has(key)) byKey.set(key, l.actor_name || key)
    })
    fetchedActorOptions.forEach((a) => {
      const key = actorKeyOf(a.id, a.name)
      if (key && !byKey.has(key)) byKey.set(key, a.name || key)
    })
    return Array.from(byKey.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [logs, fetchedActorOptions])

  // Advanced multi-user filter — matched on the same resilient key used to
  // build the options above, so selecting a user always matches rows even
  // when their actor_id is missing/null.
  const actorFiltered = useMemo(() => {
    if (actorFilters.length === 0) return searched
    const selected = new Set(actorFilters)
    return searched.filter((l) => selected.has(actorKeyOf(l.actor_id, l.actor_name)))
  }, [searched, actorFilters])

  const sortedLogs = useMemo(() => {
    const getter = CHECK_SORT_GETTERS[sortKey] || CHECK_SORT_GETTERS.time
    return [...actorFiltered].sort(compareBy(getter, sortDir))
  }, [actorFiltered, sortKey, sortDir])

  const total = sortedLogs.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const displayLogs = useMemo(
    () => sortedLogs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sortedLogs, page]
  )

  // True when the server had more rows (for the current role/action/date
  // filters) than we pulled in one batch — search/sort/pagination above are
  // only as complete as what's in `logs`, so surface this rather than
  // silently under-counting.
  const batchTruncated = serverTotal > logs.length

  const stats = useMemo(() => {
    const startOfDay = new Date().setHours(0, 0, 0, 0)
    const today = actorFiltered.filter((l) => new Date(l.performed_at).getTime() >= startOfDay).length
    const uniqueActors = new Set(actorFiltered.map((l) => actorKeyOf(l.actor_id, l.actor_name)).filter(Boolean)).size
    const actionCounts = {}
    const bankCounts = {}
    actorFiltered.forEach((l) => {
      const label = getCheckActionMeta(l.action).label
      actionCounts[label] = (actionCounts[label] || 0) + 1
      if (l.check?.bank) bankCounts[l.check.bank] = (bankCounts[l.check.bank] || 0) + 1
    })
    const topAction = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0]
    const topBank = Object.entries(bankCounts).sort((a, b) => b[1] - a[1])[0]
    return {
      today,
      uniqueActors,
      topAction: topAction ? topAction[0] : '—',
      topBank: topBank ? topBank[0] : '—',
    }
  }, [actorFiltered])

  const hasActiveFilters =
    Boolean(search.trim()) || roleFilter !== 'all' || actionFilter !== 'all' || dateRange !== '30' ||
    actorFilters.length > 0 || Boolean(customFrom) || Boolean(customTo)

  function resetFilters() {
    setSearch('')
    setRoleFilter('all')
    setActionFilter('all')
    setDateRange('30')
    setActorFilters([])
    setCustomFrom('')
    setCustomTo('')
    setDateRangeError('')
  }

  function handleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(key === 'time' || key === 'amount' ? 'desc' : 'asc')
    }
  }

  // Stable identity so memoized rows don't re-render just because the
  // parent re-rendered — only the row(s) whose isExpanded value actually
  // flips will re-render.
  const toggleExpanded = useCallback((id) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  // Shared row-building for all three export formats, so CSV/Excel/PDF can
  // never drift apart in what data they contain — built from sortedLogs
  // (every row matching the current search/filters, not just the current
  // page) so an export always captures the full result set, not one page
  // of it.
  function buildCheckActivityExportRows() {
    const header = [
      'Time', 'Actor', 'Role', 'Action', 'Check #', 'Payee', 'Amount',
      'Bank', 'Verifier (submitted by)', 'Collector', 'OR #', 'AR collected', '2307 attached', 'Approved by', 'Remarks',
    ]
    const rows = sortedLogs.map((r) => {
      const meta = getCheckActionMeta(r.action)
      return [
        formatDateTime(r.performed_at),
        r.actor_name || 'Unknown',
        r.actor_role || '',
        meta.label,
        r.check?.check_no || '',
        r.check?.payee || '',
        r.check?.amount ?? '',
        r.check?.bank || '',
        getVerifierName(r) || '',
        r.collector_name || '',
        r.or_no || '',
        r.ar_collected === null || r.ar_collected === undefined ? '' : r.ar_collected ? 'Yes' : 'No',
        r.attached_2307 === null || r.attached_2307 === undefined ? '' : r.attached_2307 ? 'Yes' : 'No',
        r.approved_by_name || '',
        r.remarks || '',
      ]
    })
    return { header, rows }
  }

  function handleExportCsv() {
    const { header, rows } = buildCheckActivityExportRows()
    downloadCsv(header, rows, `check-activity-log-${new Date().toISOString().slice(0, 10)}.csv`)
    logAuditEvent('report_exported', { report: 'check-activity-log', format: 'csv', row_count: rows.length }).catch(() => {})
  }

  async function handleExportXlsx() {
    const { header, rows } = buildCheckActivityExportRows()
    await downloadXlsx(header, rows, 'Check Activity Log', `check-activity-log-${new Date().toISOString().slice(0, 10)}.xlsx`)
    logAuditEvent('report_exported', { report: 'check-activity-log', format: 'xlsx', row_count: rows.length }).catch(() => {})
  }

  function handleExportPdf() {
    const { header, rows } = buildCheckActivityExportRows()
    downloadPdf(header, rows, 'Check Activity Log', `check-activity-log-${new Date().toISOString().slice(0, 10)}.pdf`)
    logAuditEvent('report_exported', { report: 'check-activity-log', format: 'pdf', row_count: rows.length }).catch(() => {})
  }

const activeActorLabel = useMemo(() => {
  if (actorFilters.length === 0) return null
  if (actorFilters.length === 1) {
    const value = actorFilters[0]
    return actorOptions.find((a) => a.value === value)?.label || value
  }
  return `${actorFilters.length} selected users`
}, [actorFilters, actorOptions])

  return (
    <div>
      <div className="mb-5 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800 sm:mb-6">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>
          Check lifecycle events: submit, approve, reject, recall, resubmit, return, pick up, expire. For logins,
          exports, and account changes, see the Account &amp; System tab. When an approver approves a check, that
          approval already counts as pickup confirmation, so the automatic "Picked up" entry it generates is hidden
          here to avoid showing the same action twice.
        </span>
      </div>

      {batchTruncated && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:mb-6">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            Showing the {logs.length.toLocaleString()} most recent of {serverTotal.toLocaleString()} events that
            match your role/action/date filters. Narrow the date range for a complete search, sort, and export.
          </span>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:mb-6 sm:grid-cols-5 sm:gap-3">
        {[
          { label: 'Total events', value: total, icon: ScrollText, tone: 'text-gray-700 bg-gray-100' },
          { label: 'Today (this page)', value: stats.today, icon: Calendar, tone: 'text-teal-700 bg-teal-50' },
          { label: 'Unique actors (this page)', value: stats.uniqueActors, icon: UserCircle2, tone: 'text-blue-700 bg-blue-50' },
          { label: 'Most common (this page)', value: stats.topAction, icon: FileCheck2, tone: 'text-amber-700 bg-amber-50' },
          { label: 'Top bank (this page)', value: stats.topBank, icon: Landmark, tone: 'text-violet-700 bg-violet-50' },
        ].map((s) => (
          <Card key={s.label} className="flex items-center gap-2.5 px-3 py-2.5 sm:px-4 sm:py-3">
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md ${s.tone}`}>
              <s.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[11px] uppercase tracking-wide text-gray-400">{s.label}</p>
              <p className="truncate text-base font-semibold text-gray-800" title={typeof s.value === 'string' ? s.value : undefined}>
                {loading ? '—' : s.value}
              </p>
            </div>
          </Card>
        ))}
      </div>

      {activeActorLabel && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-900">
          <Filter className="h-3.5 w-3.5 flex-shrink-0" />
          Showing activity for <span className="font-medium">{activeActorLabel}</span>
        <button
  type="button"
  onClick={() => setActorFilters([])}
  className="ml-auto rounded p-0.5 transition-colors hover:bg-teal-100"
  aria-label="Clear actor filter"
>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative flex-1 sm:min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by actor, check #, payee, or remarks"
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
        <MultiSelectFilter
          label="Users"
          icon={UserCircle2}
          options={actorOptions}
          selected={actorFilters}
          onChange={setActorFilters}
          className="sm:w-48"
        />
        <div className="flex gap-2.5">
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="flex-1 sm:w-36">
            {ROLE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
          <Select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="flex-1 sm:w-56">
            {CHECK_ACTION_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
          <Select value={dateRange} onChange={(e) => { setDateRange(e.target.value); setDateRangeError('') }} className="flex-1 sm:w-40">
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
        </div>
        {dateRange === 'custom' && (
          <CustomDateRangeInputs
            from={customFrom}
            to={customTo}
            onFromChange={setCustomFrom}
            onToChange={setCustomTo}
            error={dateRangeError}
          />
        )}
        {hasActiveFilters && (
          <Button variant="ghost" onClick={resetFilters} className="justify-center text-gray-500 sm:w-auto">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reset
          </Button>
        )}
        <div className="flex gap-2 sm:ml-auto">
          <Button variant="ghost" onClick={handleRefresh} disabled={refreshing || loading}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <ExportMenu
            disabled={loading || displayLogs.length === 0}
            onExportCsv={handleExportCsv}
            onExportXlsx={handleExportXlsx}
            onExportPdf={handleExportPdf}
          />
        </div>
      </div>

      <Card className="hidden overflow-hidden sm:block">
        <div className="max-h-[65vh] overflow-x-auto overflow-y-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left shadow-sm">
              <tr>
                <th className="px-4 py-3">
                  <SortButton label="Time" sortKey="time" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Actor" sortKey="actor" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Role" sortKey="role" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Action" sortKey="action" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">
                  <span className="inline-flex items-center gap-1"><Hash className="h-3 w-3" />Check #</span>
                </th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">Payee</th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">Bank</th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">
                  <span className="inline-flex items-center gap-1"><UserSquare2 className="h-3 w-3" />Verifier</span>
                </th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">
                  <span className="inline-flex items-center gap-1"><Receipt className="h-3 w-3" />Collector</span>
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Amount</th>
                <th className="w-10 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <SkeletonRows cols={11} />
              ) : loadError ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-sm text-red-600">{loadError}</td>
                </tr>
              ) : displayLogs.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center">
                    <ScrollText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
                    <p className="text-sm font-medium text-gray-600">No activity found</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {hasActiveFilters ? 'Try adjusting your search or filters.' : 'Activity appears here as checks move through the workflow.'}
                    </p>
                    {hasActiveFilters && (
                      <Button variant="ghost" size="sm" onClick={resetFilters} className="mt-3">Clear filters</Button>
                    )}
                  </td>
                </tr>
              ) : (
                displayLogs.map((log, idx) => (
                  <CheckLogRow key={log.id ?? `check-log-${idx}`} log={log} isExpanded={expandedId === log.id} onToggle={toggleExpanded} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Mobile cards */}
      <div className="space-y-2.5 sm:hidden">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="animate-pulse px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-full bg-gray-200" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-2/3 rounded bg-gray-200" />
                  <div className="h-3 w-1/2 rounded bg-gray-200" />
                </div>
              </div>
            </Card>
          ))
        ) : loadError ? (
          <Card className="px-4 py-8 text-center text-sm text-red-600">{loadError}</Card>
        ) : displayLogs.length === 0 ? (
          <Card className="px-4 py-10 text-center">
            <ScrollText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            <p className="text-sm font-medium text-gray-600">No activity found</p>
          </Card>
        ) : (
          displayLogs.map((log, idx) => (
            <CheckLogCardMobile key={log.id ?? `check-log-${idx}`} log={log} isExpanded={expandedId === log.id} onToggle={toggleExpanded} />
          ))
        )}
      </div>

      {!loading && !loadError && total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[3rem] text-center text-xs">{page} / {totalPages}</span>
            <Button variant="ghost" size="icon" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Tab 2: Account & system activity (logins, exports, reports, account
// status changes) — reads from the audit_log table
// ----------------------------------------------------------------------------

const SYSTEM_ACTION_META = {
  login: { label: 'Signed in', icon: LogIn, tone: 'text-green-700 bg-green-50' },
  login_failed: { label: 'Failed sign-in attempt', icon: ShieldAlert, tone: 'text-red-700 bg-red-50' },
  logout: { label: 'Signed out', icon: LogOut, tone: 'text-gray-700 bg-gray-100' },
  account_created: { label: 'Account created', icon: UserPlus, tone: 'text-teal-700 bg-teal-50' },
  password_reset_requested: { label: 'Password reset requested', icon: KeyRound, tone: 'text-amber-700 bg-amber-50' },
  password_reset_completed: { label: 'Password reset completed', icon: KeyRound, tone: 'text-amber-700 bg-amber-50' },
  account_activated: { label: 'Account activated', icon: UserCheck, tone: 'text-green-700 bg-green-50' },
  account_deactivated: { label: 'Account deactivated', icon: UserX, tone: 'text-red-700 bg-red-50' },
  role_changed: { label: 'Role changed', icon: ShieldAlert, tone: 'text-purple-700 bg-purple-50' },
  report_generated: { label: 'Report generated', icon: FileBarChart2, tone: 'text-blue-700 bg-blue-50' },
  report_exported: { label: 'Report exported', icon: FileDown, tone: 'text-blue-700 bg-blue-50' },
  checks_uploaded: { label: 'Checks uploaded', icon: UploadCloud, tone: 'text-blue-700 bg-blue-50' },
}

function getSystemActionMeta(action) {
  return SYSTEM_ACTION_META[action] || { label: action || 'Event', icon: Info, tone: 'text-gray-600 bg-gray-100' }
}

const SYSTEM_ACTION_FILTER_OPTIONS = [
  { value: 'all', label: 'All events' },
  ...Object.entries(SYSTEM_ACTION_META).map(([value, meta]) => ({ value, label: meta.label })),
]

// A short, human-readable one-line summary of a system event's metadata, so
// the table doesn't have to be expanded just to see the one fact that
// actually matters (which report format, which target, which role change).
// Falls back to null when there's nothing worth summarizing inline —
// callers should still offer the full expandable detail in that case.
function summarizeSystemMetadata(log) {
  const meta = log.metadata || {}
  switch (log.action) {
    case 'report_exported':
    case 'report_generated': {
      const bits = [meta.report, meta.format ? meta.format.toUpperCase() : null, meta.row_count != null ? `${meta.row_count} rows` : null]
        .filter(Boolean)
      return bits.length ? bits.join(' · ') : null
    }
    case 'role_changed': {
      if (meta.from && meta.to) return `${meta.from} → ${meta.to}`
      return null
    }
    case 'checks_uploaded':
      return meta.count != null ? `${meta.count} check${meta.count === 1 ? '' : 's'}` : null
    case 'login_failed':
      return meta.reason || null
    default:
      return null
  }
}

const SystemLogRow = React.memo(function SystemLogRow({ log, isExpanded, onToggle }) {
  const meta = getSystemActionMeta(log.action)
  const Icon = meta.icon
  const summary = summarizeSystemMetadata(log)
  const expandable = Boolean(log.metadata && Object.keys(log.metadata).length) || log.target_type

  return (
    <React.Fragment>
      <tr
        className={`group cursor-pointer transition-colors hover:bg-gray-50 ${isExpanded ? 'bg-gray-50' : ''}`}
        onClick={() => expandable && onToggle(log.id)}
      >
        <td className="whitespace-nowrap px-4 py-3 align-top">
          <span className="block text-gray-700">{formatDateTime(log.performed_at)}</span>
          <span className="block text-xs text-gray-400">{formatRelativeTime(log.performed_at)}</span>
        </td>
        <td className="px-4 py-3 align-top">
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarStyleFor(
                log.performed_by_name || ''
              )}`}
            >
              {getInitials(log.performed_by_name)}
            </div>
            <TruncatedCell value={log.performed_by_name || 'Unknown'} className="font-medium text-gray-800" maxWidthClass="max-w-[9rem]" />
          </div>
        </td>
        <td className="px-4 py-3 align-top">
          <Badge className={ROLE_BADGE_STYLE[log.performed_by_role] || 'bg-gray-100 text-gray-700'}>
            {log.performed_by_role || 'unknown'}
          </Badge>
        </td>
        <td className="px-4 py-3 align-top">
          <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium ${meta.tone}`}>
            <Icon className="h-3.5 w-3.5" />
            {meta.label}
          </span>
        </td>
        <td className="px-4 py-3 align-top text-gray-500">
          {summary ? (
            <TruncatedCell value={summary} maxWidthClass="max-w-[16rem]" />
          ) : log.target_type ? (
            <TruncatedCell value={`${log.target_type}${log.target_id ? ` · ${log.target_id}` : ''}`} maxWidthClass="max-w-[16rem]" />
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
        <td className="px-4 py-3 align-top text-right">
          {expandable && (
            <ChevronDown className={`ml-auto h-4 w-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
          )}
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-gray-50/60">
          <td colSpan={6} className="px-4 pb-4 pt-1">
            <div className="rounded-md border border-gray-200 bg-white p-3 text-xs text-gray-600">
              {log.target_type && (
                <p className="mb-1">
                  <span className="font-medium text-gray-700">Target:</span> {log.target_type}
                  {log.target_id ? ` · ${log.target_id}` : ''}
                </p>
              )}
              {log.metadata && Object.keys(log.metadata).length > 0 && (
                <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
                  {Object.entries(log.metadata).map(([k, v]) => (
                    <p key={k}>
                      <span className="font-medium text-gray-700">{k.replace(/_/g, ' ')}:</span>{' '}
                      {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </React.Fragment>
  )
})

const SystemLogCardMobile = React.memo(function SystemLogCardMobile({ log, isExpanded, onToggle }) {
  const meta = getSystemActionMeta(log.action)
  const Icon = meta.icon
  const summary = summarizeSystemMetadata(log)
  const expandable = Boolean(log.metadata && Object.keys(log.metadata).length) || log.target_type

  return (
    <Card className="px-4 py-3">
      <div className={expandable ? 'cursor-pointer' : ''} onClick={() => expandable && onToggle(log.id)}>
        <div className="flex items-start gap-2.5">
          <div
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarStyleFor(
              log.performed_by_name || ''
            )}`}
          >
            {getInitials(log.performed_by_name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium text-gray-800">{log.performed_by_name || 'Unknown'}</p>
              <span className="flex flex-shrink-0 flex-col items-end text-right">
                <span className="text-[11px] text-gray-500">{formatDateTime(log.performed_at)}</span>
                <span className="text-[10px] text-gray-400">{formatRelativeTime(log.performed_at)}</span>
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge className={ROLE_BADGE_STYLE[log.performed_by_role] || 'bg-gray-100 text-gray-700'}>
                {log.performed_by_role || 'unknown'}
              </Badge>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.tone}`}>
                <Icon className="h-3 w-3" />
                {meta.label}
              </span>
            </div>
            {summary && <p className="mt-1 truncate text-[11px] text-gray-500">{summary}</p>}
          </div>
        </div>
      </div>
      {isExpanded && expandable && (
        <div className="mt-2.5 space-y-0.5 rounded-md border border-gray-200 bg-gray-50 p-2.5 text-[11px] text-gray-600">
          {log.target_type && (
            <p><span className="font-medium text-gray-700">Target:</span> {log.target_type}{log.target_id ? ` · ${log.target_id}` : ''}</p>
          )}
          {log.metadata && Object.entries(log.metadata).map(([k, v]) => (
            <p key={k}>
              <span className="font-medium text-gray-700">{k.replace(/_/g, ' ')}:</span>{' '}
              {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
            </p>
          ))}
        </div>
      )}
    </Card>
  )
})

function SystemActivityTab() {
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const fetchControllerRef = useRef(null)

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 250)
  const [actionFilter, setActionFilter] = useState('all')
  const [dateRange, setDateRange] = useState('30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [dateRangeError, setDateRangeError] = useState('')
  const [sortDir, setSortDir] = useState('desc')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState(null)
  // Advanced "selected users" filter, same pattern as the Check Activity
  // tab. Options are derived from whichever logs are currently loaded
  // (below) rather than a separate endpoint, since this tab has no
  // dedicated actor-list API.
  const [actorFilters, setActorFilters] = useState([])

  const fetchLogs = useCallback(async () => {
    fetchControllerRef.current?.abort()
    const controller = new AbortController()
    fetchControllerRef.current = controller

    setLoadError('')
    try {
      if (dateRange === 'custom' && (!customFrom || !customTo)) {
        setDateRangeError('Pick both a start and end date.')
        return
      }
      setDateRangeError('')

      const { logs: rows, total: rowTotal } = await listAuditLog({
        page,
        perPage: PAGE_SIZE,
        search: debouncedSearch,
        action: actionFilter,
        sinceDays: dateRange === 'all' || dateRange === 'custom' ? null : Number(dateRange),
        fromDate: dateRange === 'custom' ? customFrom : null,
        toDate: dateRange === 'custom' ? customTo : null,
        sortKey: 'time',
        sortDir,
        signal: controller.signal,
      })
      setLogs(rows)
      setTotal(rowTotal)
    } catch (err) {
      if (!isAbortError(err)) setLoadError(err?.message || 'Could not load account activity')
    }
  }, [page, debouncedSearch, actionFilter, dateRange, customFrom, customTo, sortDir])

  useEffect(() => {
    setLoading(true)
    fetchLogs().finally(() => setLoading(false))
    return () => fetchControllerRef.current?.abort()
  }, [fetchLogs])

  // Keep data fresh without requiring a manual page reload.
  useLiveRefresh(fetchLogs)

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, actionFilter, dateRange, customFrom, customTo, sortDir, actorFilters])

  // Derived from the currently-loaded page of logs — the best available
  // "who's shown up in this view" list without a dedicated actor endpoint.
  // As the admin pages through or changes filters, new names are added, so
  // the picker keeps growing to reflect everyone seen so far.
  const [seenActors, setSeenActors] = useState(new Map())
  useEffect(() => {
    setSeenActors((prev) => {
      const next = new Map(prev)
      logs.forEach((l) => {
        const key = actorKeyOf(l.performed_by_id, l.performed_by_name)
        if (key) next.set(key, l.performed_by_name || key)
      })
      return next
    })
  }, [logs])
  const actorOptions = useMemo(
    () => Array.from(seenActors.entries()).map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    [seenActors]
  )

  // Client-side actor filter — applied on top of whatever the server
  // returned for the current page, same as the search box below it being
  // resolved server-side. Narrowing to one/few users is most reliable when
  // combined with a specific date range, since only the current page's
  // rows are filtered here.
  const actorFilteredLogs = useMemo(() => {
    if (actorFilters.length === 0) return logs
    const selected = new Set(actorFilters)
    return logs.filter((l) => selected.has(actorKeyOf(l.performed_by_id, l.performed_by_name)))
  }, [logs, actorFilters])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasActiveFilters = Boolean(search.trim()) || actionFilter !== 'all' || dateRange !== '30' ||
    Boolean(customFrom) || Boolean(customTo) || actorFilters.length > 0

  const stats = useMemo(() => {
    const startOfDay = new Date().setHours(0, 0, 0, 0)
    const today = actorFilteredLogs.filter((l) => new Date(l.performed_at).getTime() >= startOfDay).length
    const failedLogins = actorFilteredLogs.filter((l) => l.action === 'login_failed').length
    const exports = actorFilteredLogs.filter((l) => l.action === 'report_exported').length
    const uniqueActors = new Set(actorFilteredLogs.map((l) => actorKeyOf(l.performed_by_id, l.performed_by_name)).filter(Boolean)).size
    return { today, failedLogins, exports, uniqueActors }
  }, [actorFilteredLogs])

  function resetFilters() {
    setSearch('')
    setActionFilter('all')
    setDateRange('30')
    setCustomFrom('')
    setCustomTo('')
    setDateRangeError('')
    setActorFilters([])
  }

  async function handleRefresh() {
    setRefreshing(true)
    await fetchLogs()
    setRefreshing(false)
  }

  const toggleExpanded = useCallback((id) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  // Shared row-building so CSV/Excel/PDF exports can never drift apart in
  // what data they contain — same pattern as the Check Activity tab.
  function buildSystemActivityExportRows() {
    const header = ['Time', 'Actor', 'Role', 'Event', 'Summary', 'Target type', 'Target ID', 'Details']
    const rows = actorFilteredLogs.map((r) => {
      const meta = getSystemActionMeta(r.action)
      return [
        formatDateTime(r.performed_at),
        r.performed_by_name || 'Unknown',
        r.performed_by_role || '',
        meta.label,
        summarizeSystemMetadata(r) || '',
        r.target_type || '',
        r.target_id || '',
        r.metadata ? JSON.stringify(r.metadata) : '',
      ]
    })
    return { header, rows }
  }

  function handleExportCsv() {
    const { header, rows } = buildSystemActivityExportRows()
    downloadCsv(header, rows, `account-system-activity-${new Date().toISOString().slice(0, 10)}.csv`)
    logAuditEvent('report_exported', { report: 'account-system-activity', format: 'csv', row_count: rows.length }).catch(() => {})
  }

  async function handleExportXlsx() {
    const { header, rows } = buildSystemActivityExportRows()
    await downloadXlsx(header, rows, 'Account & System Activity', `account-system-activity-${new Date().toISOString().slice(0, 10)}.xlsx`)
    logAuditEvent('report_exported', { report: 'account-system-activity', format: 'xlsx', row_count: rows.length }).catch(() => {})
  }

  function handleExportPdf() {
    const { header, rows } = buildSystemActivityExportRows()
    downloadPdf(header, rows, 'Account & System Activity', `account-system-activity-${new Date().toISOString().slice(0, 10)}.pdf`)
    logAuditEvent('report_exported', { report: 'account-system-activity', format: 'pdf', row_count: rows.length }).catch(() => {})
  }

  return (
    <div>
      <div className="mb-5 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800 sm:mb-6">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>Logins, password resets, account status changes, and report/export activity. Check lifecycle events live in the Check Activity tab.</span>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:mb-6 sm:grid-cols-4 sm:gap-3">
        {[
          { label: 'Total events', value: total, icon: ScrollText, tone: 'text-gray-700 bg-gray-100' },
          { label: 'Today (this page)', value: stats.today, icon: Calendar, tone: 'text-teal-700 bg-teal-50' },
          { label: 'Failed sign-ins (this page)', value: stats.failedLogins, icon: ShieldAlert, tone: 'text-red-700 bg-red-50' },
          { label: 'Exports (this page)', value: stats.exports, icon: FileDown, tone: 'text-blue-700 bg-blue-50' },
        ].map((s) => (
          <Card key={s.label} className="flex items-center gap-2.5 px-3 py-2.5 sm:px-4 sm:py-3">
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md ${s.tone}`}>
              <s.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[11px] uppercase tracking-wide text-gray-400">{s.label}</p>
              <p className="truncate text-base font-semibold text-gray-800">{loading ? '—' : s.value}</p>
            </div>
          </Card>
        ))}
      </div>

      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative flex-1 sm:min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by actor or event"
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
        <MultiSelectFilter
          label="Users"
          icon={UserCircle2}
          options={actorOptions}
          selected={actorFilters}
          onChange={setActorFilters}
          className="sm:w-48"
        />
        <div className="flex gap-2.5">
          <Select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="flex-1 sm:w-56">
            {SYSTEM_ACTION_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
          <Select value={dateRange} onChange={(e) => { setDateRange(e.target.value); setDateRangeError('') }} className="flex-1 sm:w-40">
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
        </div>
        {dateRange === 'custom' && (
          <CustomDateRangeInputs
            from={customFrom}
            to={customTo}
            onFromChange={setCustomFrom}
            onToChange={setCustomTo}
            error={dateRangeError}
          />
        )}
        {hasActiveFilters && (
          <Button variant="ghost" onClick={resetFilters} className="justify-center text-gray-500 sm:w-auto">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reset
          </Button>
        )}
        <div className="flex gap-2 sm:ml-auto">
          <Button variant="ghost" onClick={handleRefresh} disabled={refreshing || loading}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <ExportMenu
            disabled={loading || actorFilteredLogs.length === 0}
            onExportCsv={handleExportCsv}
            onExportXlsx={handleExportXlsx}
            onExportPdf={handleExportPdf}
          />
        </div>
      </div>

      <Card className="hidden overflow-hidden sm:block">
        <div className="max-h-[65vh] overflow-x-auto overflow-y-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left shadow-sm">
              <tr>
                <th className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                    className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500 hover:text-gray-800"
                  >
                    Time
                    {sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5 text-teal-600" /> : <ChevronDown className="h-3.5 w-3.5 text-teal-600" />}
                  </button>
                </th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">Actor</th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">Role</th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">Event</th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">Summary</th>
                <th className="w-10 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <SkeletonRows cols={6} />
              ) : loadError ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-red-600">{loadError}</td>
                </tr>
              ) : actorFilteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <ScrollText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
                    <p className="text-sm font-medium text-gray-600">No account or system activity found</p>
                    {hasActiveFilters && (
                      <Button variant="ghost" size="sm" onClick={resetFilters} className="mt-3">Clear filters</Button>
                    )}
                  </td>
                </tr>
              ) : (
                actorFilteredLogs.map((log, idx) => (
                  <SystemLogRow key={log.id ?? `system-log-${idx}`} log={log} isExpanded={expandedId === log.id} onToggle={toggleExpanded} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Mobile cards */}
      <div className="space-y-2.5 sm:hidden">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="animate-pulse px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-full bg-gray-200" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-2/3 rounded bg-gray-200" />
                  <div className="h-3 w-1/2 rounded bg-gray-200" />
                </div>
              </div>
            </Card>
          ))
        ) : loadError ? (
          <Card className="px-4 py-8 text-center text-sm text-red-600">{loadError}</Card>
        ) : actorFilteredLogs.length === 0 ? (
          <Card className="px-4 py-10 text-center">
            <ScrollText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            <p className="text-sm font-medium text-gray-600">No account or system activity found</p>
          </Card>
        ) : (
          actorFilteredLogs.map((log, idx) => (
            <SystemLogCardMobile key={log.id ?? `system-log-${idx}`} log={log} isExpanded={expandedId === log.id} onToggle={toggleExpanded} />
          ))
        )}
      </div>

      {!loading && !loadError && total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[3rem] text-center text-xs">{page} / {totalPages}</span>
            <Button variant="ghost" size="icon" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Tab 3: User sessions — who's logged in right now, and when everyone last
// signed in / out. Derived client-side from the same audit_log 'login' /
// 'logout' events the Account & System tab already shows individually; this
// tab reduces them to one current-status row per user.
// ----------------------------------------------------------------------------

const SESSION_STATUS_META = {
  online: { label: 'Online', dot: 'bg-green-500', tone: 'text-green-700 bg-green-50', icon: Radio },
  offline: { label: 'Offline', dot: 'bg-gray-300', tone: 'text-gray-600 bg-gray-100', icon: Circle },
  stale: {
    label: 'Session expired',
    dot: 'bg-amber-500',
    tone: 'text-amber-700 bg-amber-50',
    icon: AlertCircle,
    note: 'Logged in a while ago with no logout on record — likely a closed browser rather than an active session.',
  },
  never_logged_in: { label: 'Never signed in', dot: 'bg-gray-200', tone: 'text-gray-500 bg-gray-50', icon: Circle },
}

function getSessionStatusMeta(status) {
  return SESSION_STATUS_META[status] || SESSION_STATUS_META.offline
}

// A user who's currently online hasn't logged out of *this* session, so any
// lastLogout on record necessarily predates their current login — showing
// it next to "Online" made it look like they'd just logged in and out at
// the same moment. We only surface a logout time once it's confirmed to be
// a real logout that happened after their most recent login.
function getDisplayLogout(session) {
  if (!session?.lastLogout) return null
  if (session.status === 'online') return null
  if (session.lastLogin && new Date(session.lastLogout).getTime() <= new Date(session.lastLogin).getTime()) {
    return null
  }
  return session.lastLogout
}

const SESSION_STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'stale', label: 'Session expired' },
  { value: 'never_logged_in', label: 'Never signed in' },
]

const UserSessionRow = React.memo(function UserSessionRow({ session }) {
  const meta = getSessionStatusMeta(session.status)
  const StatusIcon = meta.icon
  const displayLogout = getDisplayLogout(session)

  return (
    <tr className="transition-colors hover:bg-gray-50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarStyleFor(
              session.name || ''
            )}`}
          >
            {getInitials(session.name)}
          </div>
          <TruncatedCell value={session.name || 'Unknown'} className="font-medium text-gray-800" maxWidthClass="max-w-[10rem]" />
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge className={ROLE_BADGE_STYLE[session.role] || 'bg-gray-100 text-gray-700'}>
          {session.role || 'unknown'}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${meta.tone}`}
          title={meta.note}
        >
          <StatusIcon className={`h-3 w-3 ${session.status === 'online' ? 'animate-pulse' : ''}`} />
          {meta.label}
          {meta.note && <Info className="h-3 w-3 opacity-50" />}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        {session.lastLogin ? (
          <>
            <span className="block text-gray-700">{formatDateTime(session.lastLogin)}</span>
            <span className="block text-xs text-gray-400">{formatRelativeTime(session.lastLogin)}</span>
          </>
        ) : session.createdAt ? (
          <span className="text-gray-400">Created {formatDateTime(session.createdAt)}</span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        {session.status === 'online' ? (
          <span className="text-xs italic text-gray-400">Still online</span>
        ) : displayLogout ? (
          <>
            <span className="block text-gray-700">{formatDateTime(displayLogout)}</span>
            <span className="block text-xs text-gray-400">{formatRelativeTime(displayLogout)}</span>
          </>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-gray-600">
        {session.status === 'online' ? (
          <span className="text-green-700">{formatDuration(session.sessionDurationMs)} so far</span>
        ) : (
          formatDuration(session.sessionDurationMs)
        )}
      </td>
    </tr>
  )
})

const UserSessionCardMobile = React.memo(function UserSessionCardMobile({ session }) {
  const meta = getSessionStatusMeta(session.status)
  const StatusIcon = meta.icon
  const displayLogout = getDisplayLogout(session)

  return (
    <Card className="px-4 py-3">
      <div className="flex items-start gap-2.5">
        <div
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarStyleFor(
            session.name || ''
          )}`}
        >
          {getInitials(session.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium text-gray-800">{session.name || 'Unknown'}</p>
            <Badge className={ROLE_BADGE_STYLE[session.role] || 'bg-gray-100 text-gray-700'}>
              {session.role || 'unknown'}
            </Badge>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.tone}`}>
              <StatusIcon className={`h-3 w-3 ${session.status === 'online' ? 'animate-pulse' : ''}`} />
              {meta.label}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-500">
            <p>
              <span className="font-medium text-gray-600">Last login:</span>{' '}
              {session.lastLogin
                ? formatDateTime(session.lastLogin)
                : session.createdAt
                ? `Created ${formatDateTime(session.createdAt)}`
                : '—'}
            </p>
            <p>
              <span className="font-medium text-gray-600">Last logout:</span>{' '}
              {session.status === 'online' ? 'Still online' : displayLogout ? formatDateTime(displayLogout) : '—'}
            </p>
          </div>
        </div>
      </div>
    </Card>
  )
})

// Client-side getters for every sortable column in the User Sessions table,
// following the same pattern as CHECK_SORT_GETTERS so sorting behaves
// consistently across all three tabs.
const SESSION_SORT_GETTERS = {
  name: (s) => (s.name || '').toLowerCase(),
  role: (s) => (s.role || '').toLowerCase(),
  status: (s) => getSessionStatusMeta(s.status).label,
  lastLogin: (s) => (s.lastLogin ? new Date(s.lastLogin).getTime() : null),
  lastLogout: (s) => {
    const displayLogout = getDisplayLogout(s)
    return displayLogout ? new Date(displayLogout).getTime() : null
  },
  duration: (s) => (s.sessionDurationMs != null ? Number(s.sessionDurationMs) : null),
}

function UserSessionsTab() {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const fetchControllerRef = useRef(null)

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 250)
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  // Advanced "selected users" filter, consistent with the other two tabs —
  // options are simply every user currently in `sessions`.
  const [userFilters, setUserFilters] = useState([])
  const [sortKey, setSortKey] = useState('status')
  const [sortDir, setSortDir] = useState('asc')

  const fetchSessions = useCallback(async (opts = {}) => {
    fetchControllerRef.current?.abort()
    const controller = new AbortController()
    fetchControllerRef.current = controller

    setLoadError('')
    try {
      const rows = await listUserSessions({ signal: controller.signal, forceRefresh: opts.forceRefresh })
      // Defensive: guarantee every session row has the shape the rest of
      // this tab assumes, even if the API omits a field for a given user —
      // this is what previously let a missing/blank `name` crash the
      // client-side search filter below.
      const normalized = Array.isArray(rows)
        ? rows.map((s) => ({
            id: s?.id ?? s?.userId ?? s?.user_id ?? s?.email ?? crypto.randomUUID(),
            name: s?.name || 'Unknown user',
            role: s?.role || null,
            status: s?.status || 'offline',
            lastLogin: s?.lastLogin ?? null,
            lastLogout: s?.lastLogout ?? null,
            createdAt: s?.createdAt ?? null,
            sessionDurationMs: s?.sessionDurationMs ?? null,
          }))
        : []
      setSessions(normalized)
    } catch (err) {
      if (!isAbortError(err)) setLoadError(err?.message || 'Could not load user sessions')
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchSessions().finally(() => setLoading(false))
    return () => fetchControllerRef.current?.abort()
  }, [fetchSessions])

  // Auto-refresh on focus/visibility change, plus a 30s poll as a safety
  // net, so "Online" status stays trustworthy without a manual reload.
  useLiveRefresh(() => fetchSessions({ forceRefresh: true }), { pollMs: 30000 })

  async function handleRefresh() {
    setRefreshing(true)
    await fetchSessions({ forceRefresh: true })
    setRefreshing(false)
  }

  // Every user currently loaded, for the "selected users" picker — kept in
  // sync with whatever `sessions` holds so a user who signs in for the
  // first time shows up in the filter without a page reload.
  const userOptions = useMemo(
    () => sessions.map((s) => ({ value: s.id, label: s.name })).sort((a, b) => a.label.localeCompare(b.label)),
    [sessions]
  )

  // Robust client-side search: tokenized, case-insensitive, matched against
  // name, role, status label, and both timestamps — guarded so a session
  // with a missing/null name (or any other missing field) can never throw
  // instead of just not matching. This is what previously crashed the tab.
  const searchTokens = useMemo(() => normalizeSearchTokens(debouncedSearch), [debouncedSearch])

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      if (roleFilter !== 'all' && s.role !== roleFilter) return false
      if (statusFilter !== 'all' && s.status !== statusFilter) return false
      if (userFilters.length > 0 && !userFilters.includes(s.id)) return false
      if (searchTokens.length > 0 && !rowMatchesTokens(sessionSearchHaystack(s), searchTokens)) return false
      return true
    })
  }, [sessions, roleFilter, statusFilter, userFilters, searchTokens])

  const sortedFiltered = useMemo(() => {
    const getter = SESSION_SORT_GETTERS[sortKey] || SESSION_SORT_GETTERS.name
    return [...filtered].sort(compareBy(getter, sortDir))
  }, [filtered, sortKey, sortDir])

  const stats = useMemo(() => {
    const online = sessions.filter((s) => s.status === 'online').length
    const offline = sessions.filter((s) => s.status === 'offline' || s.status === 'stale').length
    const neverLoggedIn = sessions.filter((s) => s.status === 'never_logged_in').length
    return { total: sessions.length, online, offline, neverLoggedIn }
  }, [sessions])

  const hasActiveFilters = Boolean(search.trim()) || roleFilter !== 'all' || statusFilter !== 'all' || userFilters.length > 0

  function resetFilters() {
    setSearch('')
    setRoleFilter('all')
    setStatusFilter('all')
    setUserFilters([])
  }

  function handleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(key === 'lastLogin' || key === 'lastLogout' || key === 'duration' ? 'desc' : 'asc')
    }
  }

  function buildSessionsExportRows() {
    const header = ['Name', 'Role', 'Status', 'Account created', 'Last login', 'Last logout', 'Session duration']
    const rows = sortedFiltered.map((s) => {
      const displayLogout = getDisplayLogout(s)
      return [
        s.name,
        s.role || '',
        getSessionStatusMeta(s.status).label,
        formatDateTime(s.createdAt),
        formatDateTime(s.lastLogin),
        s.status === 'online' ? 'Still online' : formatDateTime(displayLogout),
        formatDuration(s.sessionDurationMs),
      ]
    })
    return { header, rows }
  }

  function handleExportCsv() {
    const { header, rows } = buildSessionsExportRows()
    downloadCsv(header, rows, `user-sessions-${new Date().toISOString().slice(0, 10)}.csv`)
    logAuditEvent('report_exported', { report: 'user-sessions', format: 'csv', row_count: rows.length }).catch(() => {})
  }

  async function handleExportXlsx() {
    const { header, rows } = buildSessionsExportRows()
    await downloadXlsx(header, rows, 'User Sessions', `user-sessions-${new Date().toISOString().slice(0, 10)}.xlsx`)
    logAuditEvent('report_exported', { report: 'user-sessions', format: 'xlsx', row_count: rows.length }).catch(() => {})
  }

  function handleExportPdf() {
    const { header, rows } = buildSessionsExportRows()
    downloadPdf(header, rows, 'User Sessions', `user-sessions-${new Date().toISOString().slice(0, 10)}.pdf`)
    logAuditEvent('report_exported', { report: 'user-sessions', format: 'pdf', row_count: rows.length }).catch(() => {})
  }

  return (
    <div>
      <div className="mb-5 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800 sm:mb-6">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>
          Current sign-in status for every user, with their most recent login and logout time. Refreshes
          automatically when this tab regains focus and every 30 seconds while open.
        </span>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:mb-6 sm:grid-cols-4 sm:gap-3">
        {[
          { label: 'Total users', value: stats.total, icon: Users, tone: 'text-gray-700 bg-gray-100' },
          { label: 'Online now', value: stats.online, icon: Radio, tone: 'text-green-700 bg-green-50' },
          { label: 'Offline', value: stats.offline, icon: Circle, tone: 'text-gray-700 bg-gray-100' },
          { label: 'Never signed in', value: stats.neverLoggedIn, icon: AlertCircle, tone: 'text-amber-700 bg-amber-50' },
        ].map((s) => (
          <Card key={s.label} className="flex items-center gap-2.5 px-3 py-2.5 sm:px-4 sm:py-3">
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md ${s.tone}`}>
              <s.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[11px] uppercase tracking-wide text-gray-400">{s.label}</p>
              <p className="truncate text-base font-semibold text-gray-800">{loading ? '—' : s.value}</p>
            </div>
          </Card>
        ))}
      </div>

      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative flex-1 sm:min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name"
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
        <MultiSelectFilter
          label="Users"
          icon={UserCircle2}
          options={userOptions}
          selected={userFilters}
          onChange={setUserFilters}
          className="sm:w-48"
        />
        <div className="flex gap-2.5">
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="flex-1 sm:w-36">
            {ROLE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="flex-1 sm:w-48">
            {SESSION_STATUS_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
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
          <Button variant="ghost" onClick={handleRefresh} disabled={refreshing || loading}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <ExportMenu
            disabled={loading || sortedFiltered.length === 0}
            onExportCsv={handleExportCsv}
            onExportXlsx={handleExportXlsx}
            onExportPdf={handleExportPdf}
          />
        </div>
      </div>

      <Card className="hidden overflow-hidden sm:block">
        <div className="max-h-[65vh] overflow-x-auto overflow-y-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left shadow-sm">
              <tr>
                <th className="px-4 py-3">
                  <SortButton label="User" sortKey="name" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Role" sortKey="role" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Status" sortKey="status" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Last login" sortKey="lastLogin" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Last logout" sortKey="lastLogout" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Session length" sortKey="duration" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <SkeletonRows cols={6} />
              ) : loadError ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-red-600">{loadError}</td>
                </tr>
              ) : sortedFiltered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Users className="mx-auto mb-2 h-8 w-8 text-gray-300" />
                    <p className="text-sm font-medium text-gray-600">No users found</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {hasActiveFilters ? 'Try adjusting your search or filters.' : 'Users appear here once accounts exist.'}
                    </p>
                    {hasActiveFilters && (
                      <Button variant="ghost" size="sm" onClick={resetFilters} className="mt-3">Clear filters</Button>
                    )}
                  </td>
                </tr>
              ) : (
                sortedFiltered.map((session, idx) => <UserSessionRow key={session.id ?? `session-${idx}`} session={session} />)
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Mobile cards */}
      <div className="space-y-2.5 sm:hidden">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="animate-pulse px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-full bg-gray-200" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-2/3 rounded bg-gray-200" />
                  <div className="h-3 w-1/2 rounded bg-gray-200" />
                </div>
              </div>
            </Card>
          ))
        ) : loadError ? (
          <Card className="px-4 py-8 text-center text-sm text-red-600">{loadError}</Card>
        ) : sortedFiltered.length === 0 ? (
          <Card className="px-4 py-10 text-center">
            <Users className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            <p className="text-sm font-medium text-gray-600">No users found</p>
          </Card>
        ) : (
          sortedFiltered.map((session, idx) => <UserSessionCardMobile key={session.id ?? `session-${idx}`} session={session} />)
        )}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Shell: header + tab switcher
// ----------------------------------------------------------------------------

const TABS = [
  { value: 'checks', label: 'Check activity' },
  { value: 'system', label: 'Account & system activity' },
  { value: 'sessions', label: 'User sessions' },
]

export default function AdminAuditTrail() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialTab = TABS.some((t) => t.value === searchParams.get('tab')) ? searchParams.get('tab') : 'checks'
  const [tab, setTab] = useState(initialTab)

  function switchTab(next) {
    setTab(next)
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  return (
    <div>
      <div className="mb-5 flex items-center gap-2.5 sm:mb-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50">
          <ScrollText className="h-5 w-5 text-teal-600" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-800">Audit trail</h1>
          <p className="text-xs text-gray-500">Every check action, account/system event, and user session, with who did it and when.</p>
        </div>
      </div>

      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-gray-200 sm:mb-6">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => switchTab(t.value)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.value ? 'border-teal-600 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <TabErrorBoundary key={tab}>
        {tab === 'checks' ? <CheckActivityTab /> : tab === 'system' ? <SystemActivityTab /> : <UserSessionsTab />}
      </TabErrorBoundary>
    </div>
  )
}