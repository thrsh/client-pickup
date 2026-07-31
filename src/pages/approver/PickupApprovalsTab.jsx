// src/pages/approver/ApproverHome.jsx
//
// Approver-side half of the submit-for-approval flow started in
// AdminPickups.jsx. Admins submit per-check pickup data; those checks land
// here as 'pending_approval'. For each one an approver decides:
//   - Approve -> check is marked picked_up (released to the collector).
//   - Return  -> check goes back to the SAME reservation as 'reserved' so
//                the submitting admin can fix it and resubmit. It is never
//                released to the general pool.
//
// ID VERIFICATION OWNERSHIP CHANGE:
// Collector identity verification is now captured upstream by the verifier
// role at intake, and stored on `pickup_reservations` as collector_id_type,
// collector_id_type_other (free-text label when type = 'other'), and
// collector_id_number. This page no longer collects or edits that data —
// it only displays it, and gates Approve on a reservation having a type +
// number on file (there is no expiry or verified-by column in the schema,
// so "verified" here just means those two fields are populated).
//
// BRANCH SCOPING
// Approvers only see checks whose pickup_branch matches their own branch.
// profiles.branch stores a machine-readable code (csba_parqal / csba_bgc /
// all_branches); checks.pickup_branch stores the human-readable label
// collectors/verifiers/admins actually typed. BRANCH_CODE_TO_LABEL is the
// single translation point between the two. The restriction is applied at
// the query level and re-asserted client-side as defense in depth — the
// real access boundary is the Postgres RLS policy on `checks`, which must
// apply the same translation. Admins are branch-agnostic; the existing
// "Pickup branch" advanced filter still lets them narrow within what they
// see.
//
// CONCURRENT-APPROVER RACE CONDITION:
// Two approvers can open the same reservation at the same time. Before
// submitting a decision this page re-fetches the live status AND pickup
// branch of every targeted check (through a retrying, timeout-bound query)
// and drops any that another approver already decided or that fell outside
// this approver's branch scope in the meantime, rather than blindly
// re-applying a decision to a check that has moved on. This narrows the
// race window but cannot fully close it client-side — the authoritative
// fix is for `approver_decide` itself to be atomic per check, e.g.:
//   UPDATE checks SET status = ... WHERE id = ANY(...) AND status = 'pending_approval'
//   (checking ROW_COUNT / FOUND per check, the way approver_decide_staled_report does)
// so a check already claimed by another transaction is simply skipped
// server-side instead of double-processed. If you share the current
// `approver_decide` definition, it can be hardened the same way.
//
// Requires the approval-workflow migration (admin_submit_for_approval,
// admin_recall_submission, approver_decide, checks.status =
// 'pending_approval', profiles table) to have been run first.
//
// Route-level access is enforced by <ProtectedRoute roles={['approver','admin']}>;
// the in-component role check below is defense-in-depth only — the real
// authority is the Postgres RLS policy / approver_decide's own role check.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  RefreshCw,
  Search,
  X,
  Check,
  RotateCcw,
  Loader2,
  AlertTriangle,
  User,
  Hash,
  Layers,
  ChevronDown,
  ChevronUp,
  CheckSquare,
  Square,
  MinusSquare,
  Download,
  ArrowUpDown,
  CheckCircle2,
  ShieldCheck,
  ShieldAlert,
  Pause,
  Play,
  Stamp,
  Hourglass,
  SlidersHorizontal,
  TrendingUp,
  Users,
  Timer,
  Wallet,
  Landmark,
  Building2,
  Fingerprint,
  Lock,
  WifiOff,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import { useProfile, hasRole } from '../../context/ProfileContext'

const POLL_INTERVAL_MS = 20000
const SUCCESS_FLASH_MS = 900
const ALLOWED_ROLES = ['approver', 'admin']
// Keep in sync with AdminPickups.jsx so both pages agree on "taking too long."
const PENDING_WARN_MINUTES = 60
const PENDING_CRITICAL_MINUTES = 240
const REMARKS_MAX_LEN = 200
const MAX_PENDING_ROWS = 1000
const RETRY_DELAYS_MS = [400, 1200]
const FETCH_TIMEOUT_MS = 20000

const BRANCH_COLUMN = 'pickup_branch'

// profiles.branch (code) -> checks.pickup_branch (label). Single
// translation point — update here if either vocabulary changes.
const BRANCH_CODE_TO_LABEL = {
  csba_parqal: 'CSBA - Parqal',
  csba_bgc: 'CSBA - BGC',
}
const UNRESTRICTED_BRANCH_CODE = 'all_branches'

function resolveBranchLabel(code) {
  if (!code || code === UNRESTRICTED_BRANCH_CODE) return null
  return BRANCH_CODE_TO_LABEL[code] || null
}

// Any of these columns being non-empty on a `checks` row means it belongs
// to a Staled Check Report (see StaleWatchPanel.jsx / verifier_submit_stale_checks_for_approval),
// not a pickup reservation — that flow is reviewed in ApproverStaleReports.jsx.
// Kept as a list until the real column name is confirmed against the schema.
const STALE_REPORT_FIELD_CANDIDATES = ['stale_report_number', 'staled_report_number', 'report_number']

function isStaleReportCheck(row) {
  return STALE_REPORT_FIELD_CANDIDATES.some((key) => row?.[key] !== null && row?.[key] !== undefined && row?.[key] !== '')
}

// Known values for pickup_reservations.collector_id_type; anything else
// (including 'other', which pairs with collector_id_type_other for a
// free-text label) falls back to labelForIdType() below.
const ID_TYPE_LABELS = {
  passport: 'Passport',
  national_id: 'National ID (PhilSys)',
  postal_id: 'Postal ID',
  drivers_license: "Driver's License",
}

const ID_STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'Any ID status' },
  { value: 'verified', label: 'ID on file' },
  { value: 'missing', label: 'ID not on file' },
]

const SORT_OPTIONS = [
  { value: 'submitted_asc', label: 'Oldest submitted first' },
  { value: 'submitted_desc', label: 'Newest submitted first' },
  { value: 'amount_desc', label: 'Highest amount' },
  { value: 'amount_asc', label: 'Lowest amount' },
  { value: 'collector_asc', label: 'Collector A→Z' },
]

const AR_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'yes', label: 'Collected' },
  { value: 'no', label: 'Not collected' },
  { value: 'unset', label: 'Not recorded' },
]

const URGENCY_FILTER_OPTIONS = [
  { value: 'all', label: 'Any wait time' },
  { value: 'stale', label: `Waiting ${PENDING_WARN_MINUTES}m or more` },
  { value: 'critical', label: `Waiting ${Math.round(PENDING_CRITICAL_MINUTES / 60)}h or more` },
]

const UNKNOWN_BANK_LABEL = 'Unspecified'
const UNKNOWN_BRANCH_LABEL = 'Unspecified'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function normalizeBank(bank) {
  const trimmed = typeof bank === 'string' ? bank.trim() : ''
  return trimmed || UNKNOWN_BANK_LABEL
}

function normalizeBranch(branch) {
  const trimmed = typeof branch === 'string' ? branch.trim() : ''
  return trimmed || UNKNOWN_BRANCH_LABEL
}

function branchKey(branch) {
  return normalizeBranch(branch).trim().toLowerCase()
}

// collector_id_type is 'other' paired with a free-text collector_id_type_other,
// or one of the known ID_TYPE_LABELS values.
function labelForIdType(idType, idTypeOther) {
  if (!idType) return null
  if (idType === 'other') return idTypeOther?.trim() || 'Other ID'
  return ID_TYPE_LABELS[idType] || idType
}

// Reads the verifier-entered ID fields off an embedded reservation row.
// Returns null if nothing has been recorded yet. Centralized here so a
// schema rename only needs to change one place.
function getReservationIdInfo(reservation) {
  if (!reservation || !reservation.collector_id_type) return null
  return {
    idType: reservation.collector_id_type,
    idTypeOther: reservation.collector_id_type_other || null,
    idNumber: reservation.collector_id_number || '',
  }
}

// There's no expiry or verified-by tracking in the schema — "verified"
// here means the verifier recorded a type and number, nothing more.
function idInfoStatus(idInfo) {
  if (!idInfo || !idInfo.idType || !idInfo.idNumber) return 'missing'
  return 'verified'
}

function formatIdSummary(idInfo) {
  if (!idInfo) return 'No ID on file'
  const label = labelForIdType(idInfo.idType, idInfo.idTypeOther)
  return `${label} #${idInfo.idNumber}`
}

// Records which on-file ID a release was matched against, for the audit
// trail in the check's own remarks (approvals otherwise carry none).
function formatReleaseRemark(idInfo) {
  return `Released — ID on file: ${formatIdSummary(idInfo)}`
}

// One row per check pending approval, sourced from `checks` directly (the
// same table/column the dashboard's "Awaiting your decision" KPI reads)
// rather than from `pickup_reservations`, since a reservation's own status
// can lag behind the status of the checks inside it. The reservation is
// embedded only for display (collector name, ID on file) and for the id
// approver_decide needs.
function buildPendingRows(checks) {
  return (checks || [])
    .filter((c) => !isStaleReportCheck(c))
    .map((c) => {
      const reservation = c.pickup_reservations || {}
      return {
        id: c.id,
        checkId: c.id,
        reservationId: c.reservation_id ?? reservation.id ?? null,
        collectorName: reservation.collector_name || null,
        idInfo: getReservationIdInfo(reservation),
        row_number: c.row_number,
        payee: c.payee,
        payor: c.payor,
        check_no: c.check_no,
        check_date: c.check_date,
        amount: c.amount,
        or_no: c.or_no,
        ar_collected: c.ar_collected,
        attached_2307: c.attached_2307,
        remarks: c.remarks,
        submitted_by_name: c.submitted_by_name,
        submitted_at: c.submitted_at,
        bank: c.bank,
        pickupBranch: c.pickup_branch,
      }
    })
}

// Defense-in-depth: strips rows outside the active branch scope even
// though the query is already scoped server-side. requiredBranch === null
// means no restriction (admin, unscoped).
function enforceBranchScope(rows, requiredBranch) {
  if (!requiredBranch) return rows
  const required = branchKey(requiredBranch)
  return rows.filter((r) => branchKey(r.pickupBranch) === required)
}

function groupByReservation(rows) {
  const map = new Map()
  rows.forEach((row) => {
    if (!map.has(row.reservationId)) {
      map.set(row.reservationId, {
        reservationId: row.reservationId,
        collectorName: row.collectorName,
        idInfo: row.idInfo,
        items: [],
      })
    }
    map.get(row.reservationId).items.push(row)
  })
  return [...map.values()]
}

function matchesSearch(items, term) {
  if (!term) return true
  const needle = term.toLowerCase()
  return items.some((c) =>
    [c.payee, c.payor, c.check_no, c.collectorName, c.or_no, c.bank]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle))
  )
}

// Sums in integer cents to avoid floating-point drift on repeated addition,
// then converts back — keeps large-batch totals exact to the peso.
function orderTotal(items) {
  const cents = items.reduce((sum, c) => {
    const n = Number(c.amount)
    return sum + (Number.isFinite(n) ? Math.round(n * 100) : 0)
  }, 0)
  return cents / 100
}

function earliestSubmittedAt(items) {
  const times = items.map((c) => c.submitted_at).filter(Boolean).map((t) => new Date(t).getTime())
  if (times.length === 0) return null
  return Math.min(...times)
}

function formatMinutesDuration(mins) {
  if (mins === null || mins === undefined || Number.isNaN(mins)) return '—'
  const whole = Math.max(0, Math.round(mins))
  if (whole < 60) return `${whole}m`
  const hrs = Math.floor(whole / 60)
  const rem = whole % 60
  return `${hrs}h ${rem}m`
}

function safeCurrency(amount) {
  const n = Number(amount)
  return Number.isFinite(n) ? formatCurrency(n) : '—'
}

function classifyError(err) {
  const message = err?.message || String(err || 'Something went wrong')
  if (err?.name === 'AbortError') {
    return { type: 'network', message: 'That took too long to respond. Please try again.' }
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { type: 'network', message: "You're offline. Reconnect and try again." }
  }
  if (/failed to fetch|network|timeout|econnreset|502|503|504/i.test(message)) {
    return { type: 'network', message: 'Network error reaching the server. Please try again.' }
  }
  return { type: 'validation', message }
}

// Retries transient failures with backoff and enforces a hard timeout via
// the shared AbortSignal. `buildQuery` must construct a fresh query per
// call — Supabase builders execute on await, so re-awaiting one instance
// won't actually retry the request.
async function runSupabaseQuery(buildQuery, signal) {
  let lastError = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal?.aborted) {
      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      throw abortError
    }
    const result = await buildQuery()
    if (!result.error) return result
    lastError = result.error
    const isTransient = /failed to fetch|network|fetch failed|timeout|econnreset|502|503|504/i.test(result.error.message || '')
    if (!isTransient || attempt === RETRY_DELAYS_MS.length) break
    await sleep(RETRY_DELAYS_MS[attempt])
  }
  throw lastError
}

const BANK_BADGE_PALETTE = [
  'bg-teal-100 text-teal-700',
  'bg-blue-100 text-blue-700',
  'bg-purple-100 text-purple-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-indigo-100 text-indigo-700',
  'bg-cyan-100 text-cyan-700',
  'bg-lime-100 text-lime-700',
]

// Deterministic color per bank name (hashed) so the same bank always gets
// the same badge color without a hardcoded, easily-stale bank->color map.
function bankBadgeClass(bank) {
  if (bank === UNKNOWN_BANK_LABEL) return 'bg-ink-100 text-ink-500'
  let hash = 0
  for (let i = 0; i < bank.length; i += 1) hash = (hash * 31 + bank.charCodeAt(i)) >>> 0
  return BANK_BADGE_PALETTE[hash % BANK_BADGE_PALETTE.length]
}

function BankBadge({ bank, className }) {
  const label = normalizeBank(bank)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        bankBadgeClass(label),
        className
      )}
      title={label}
    >
      <Landmark className="h-3 w-3 shrink-0" />
      <span className="max-w-[110px] truncate">{label}</span>
    </span>
  )
}

function BranchBadge({ branch, className }) {
  const label = normalizeBranch(branch)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-ink-200 bg-white px-2 py-0.5 text-[11px] font-medium text-ink-600',
        className
      )}
      title={label}
    >
      <Building2 className="h-3 w-3 shrink-0" />
      <span className="max-w-[110px] truncate">{label}</span>
    </span>
  )
}

function BranchScopeBadge({ branch, locked }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium',
        locked ? 'border-teal-200 bg-teal-50 text-teal-700' : 'border-ink-200 bg-white text-ink-600'
      )}
      title={locked ? 'Your view is scoped to your assigned branch' : 'Viewing across all branches'}
    >
      {locked ? <Lock className="h-3 w-3" /> : <Building2 className="h-3 w-3" />}
      {branch || 'All branches'}
    </span>
  )
}

function IdStatusBadge({ idInfo, className }) {
  const status = idInfoStatus(idInfo)
  const config = {
    verified: { icon: ShieldCheck, cls: 'bg-teal-100 text-teal-700', label: 'ID on file' },
    missing: { icon: ShieldAlert, cls: 'bg-ink-100 text-ink-500', label: 'No ID on file' },
  }[status]
  const Icon = config.icon
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', config.cls, className)}
      title={formatIdSummary(idInfo)}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {config.label}
    </span>
  )
}

// Font sizes tried in order, largest first, until the text fits its
// container without overflowing. If even the smallest still overflows,
// the container's own `truncate` class takes over and ellipsizes it.
const FIT_TEXT_STEPS = ['text-sm', 'text-[13px]', 'text-xs', 'text-[11px]', 'text-[10px]']

// Shrink-to-fit label for cells with limited, variable width (payee names
// range from a few characters to entire company names). Tries each step in
// FIT_TEXT_STEPS until the text no longer overflows its container, then
// falls back to standard truncation with an ellipsis and a full-text
// tooltip so nothing is ever silently cut off without a way to read it.
function FitText({ text, className }) {
  const ref = useRef(null)
  const [stepIndex, setStepIndex] = useState(0)
  const display = text || '—'

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    function fit() {
      let step = 0
      el.style.fontSize = ''
      el.className = cn('block truncate', FIT_TEXT_STEPS[step], className)
      while (step < FIT_TEXT_STEPS.length - 1 && el.scrollWidth > el.clientWidth) {
        step += 1
        el.className = cn('block truncate', FIT_TEXT_STEPS[step], className)
      }
      setStepIndex(step)
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, className])

  return (
    <span ref={ref} className={cn('block truncate', FIT_TEXT_STEPS[stepIndex], className)} title={text || undefined}>
      {display}
    </span>
  )
}

export default function PickupApprovalsTab({ active = true, refreshToken = 0, onSynced }) {

  const { role, name, branch: myBranchCode, loading: profileLoading, error: profileError } = useProfile()
  const onSyncedRef = useRef(onSynced)
  useEffect(() => { onSyncedRef.current = onSynced }, [onSynced])

  const authorized = hasRole(role, ALLOWED_ROLES)
  const isAdmin = role === 'admin'

  const myBranchLabel = useMemo(() => resolveBranchLabel(myBranchCode), [myBranchCode])
  const myBranchUnmapped = Boolean(myBranchCode) && myBranchCode !== UNRESTRICTED_BRANCH_CODE && !myBranchLabel
  const branchLocked = !isAdmin && myBranchCode !== UNRESTRICTED_BRANCH_CODE
  const canQuery = isAdmin || (Boolean(myBranchCode) && (myBranchCode === UNRESTRICTED_BRANCH_CODE || Boolean(myBranchLabel)))
  const effectiveBranch = branchLocked ? myBranchLabel : null

  const [groups, setGroups] = useState([])
  const [totalPendingCount, setTotalPendingCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('submitted_asc')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const [selectedCheckIds, setSelectedCheckIds] = useState(() => new Set())
  const [confirmAction, setConfirmAction] = useState(null) // { group, checks } or { groups, bulk: true }
  const [actioning, setActioning] = useState(false)
  const [actionError, setActionError] = useState('')
  const [successFlash, setSuccessFlash] = useState(null)
  const [toast, setToast] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [now, setNow] = useState(Date.now())

  // Advanced filters — all optional, all compose (AND). Dropdown options
  // are derived live from the loaded queue so they never drift from reality.
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [collectorFilter, setCollectorFilter] = useState('all')
  const [submitterFilter, setSubmitterFilter] = useState('all')
  const [bankFilter, setBankFilter] = useState('all')
  const [branchFilter, setBranchFilter] = useState('all')
  const [urgencyFilter, setUrgencyFilter] = useState('all')
  const [arFilter, setArFilter] = useState('all')
  const [idStatusFilter, setIdStatusFilter] = useState('all')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')

  const isMountedRef = useRef(true)
  const inFlightRef = useRef(false)
  const requestIdRef = useRef(0)
  const loadAbortControllerRef = useRef(null)
  const toastTimerRef = useRef(null)
  const successTimerRef = useRef(null)
  const searchInputRef = useRef(null)
  const lastFocusedElRef = useRef(null)

  useEffect(() => {
    isMountedRef.current = true
    if (!profileLoading && authorized && canQuery) load(true)
    return () => {
      isMountedRef.current = false
      loadAbortControllerRef.current?.abort()
      clearTimeout(successTimerRef.current)
      clearTimeout(toastTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileLoading, authorized, canQuery, effectiveBranch])

  useEffect(() => {
    if (!authorized || !active || !canQuery) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => {
      if (autoRefresh) load(false)
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, authorized, active, canQuery, effectiveBranch])

  useEffect(() => {
    if (!authorized || !canQuery) return
    if (prevRefreshTokenRef.current === refreshToken) return
    prevRefreshTokenRef.current = refreshToken
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, authorized, canQuery])
  const prevRefreshTokenRef = useRef(refreshToken)

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === '/' && document.activeElement !== searchInputRef.current) {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  function showToast(message, variant = 'success') {
    clearTimeout(toastTimerRef.current)
    setToast({ message, variant })
    toastTimerRef.current = setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async (showFullLoading) => {
    if (!canQuery) return
    if (inFlightRef.current && !showFullLoading) return
    const requestId = ++requestIdRef.current
    inFlightRef.current = true

    loadAbortControllerRef.current?.abort()
    const controller = new AbortController()
    loadAbortControllerRef.current = controller
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    if (showFullLoading) setLoading(true)
    else setRefreshing(true)
    setLoadError('')

    try {
      const buildQuery = () => {
        let query = supabase
          .from('checks')
          .select(
            `id, status, row_number, payee, payor, check_no, check_date, amount, or_no,
             ar_collected, attached_2307, remarks, submitted_by_name, submitted_at,
             reservation_id, bank, report_number, pickup_branch,
             pickup_reservations(id, collector_name, status, collector_id_type, collector_id_type_other, collector_id_number)`,
            { count: 'exact' }
          )
          .eq('status', 'pending_approval')

        if (effectiveBranch) {

          query = query.ilike(BRANCH_COLUMN, effectiveBranch)
        }

        return query.order('submitted_at', { ascending: true }).limit(MAX_PENDING_ROWS).abortSignal(controller.signal)
      }

      const { data, count } = await runSupabaseQuery(buildQuery, controller.signal)

      if (!isMountedRef.current || requestId !== requestIdRef.current) return

      const rows = enforceBranchScope(buildPendingRows(data || []), effectiveBranch)
      setGroups(groupByReservation(rows))
      setTotalPendingCount(count ?? rows.length)
      setLastUpdated(Date.now())
      setSelectedCheckIds((prev) => {
        if (prev.size === 0) return prev
        const validIds = new Set(rows.map((r) => r.checkId))
        const next = new Set([...prev].filter((id) => validIds.has(id)))
        return next.size === prev.size ? prev : next
      })
      onSyncedRef.current?.({ count: count ?? rows.length, lastUpdated: Date.now() })
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) return
      if (!isMountedRef.current || requestId !== requestIdRef.current) return
      setLoadError(classifyError(err).message)
    } finally {
      clearTimeout(timeoutId)
      if (loadAbortControllerRef.current === controller) loadAbortControllerRef.current = null
      if (isMountedRef.current && requestId === requestIdRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
      inFlightRef.current = false
    }
  }, [canQuery, effectiveBranch])

  function minutesWaiting(submittedAtMs) {
    if (!submittedAtMs) return 0
    return Math.max(0, Math.round((now - submittedAtMs) / 60000))
  }

  function formatWaiting(submittedAtMs) {
    if (!submittedAtMs) return '—'
    return formatMinutesDuration(minutesWaiting(submittedAtMs))
  }

  function pendingUrgency(submittedAtMs) {
    const mins = minutesWaiting(submittedAtMs)
    if (mins >= PENDING_CRITICAL_MINUTES) return 'critical'
    if (mins >= PENDING_WARN_MINUTES) return 'warning'
    return 'normal'
  }

  const collectorOptions = useMemo(() => {
    const set = new Set(groups.map((g) => g.collectorName).filter(Boolean))
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [groups])

  const submitterOptions = useMemo(() => {
    const set = new Set(groups.flatMap((g) => g.items.map((c) => c.submitted_by_name)).filter(Boolean))
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [groups])

  const bankOptions = useMemo(() => {
    const set = new Set(groups.flatMap((g) => g.items.map((c) => normalizeBank(c.bank))))
    return [...set].sort((a, b) => {
      if (a === UNKNOWN_BANK_LABEL) return 1
      if (b === UNKNOWN_BANK_LABEL) return -1
      return a.localeCompare(b)
    })
  }, [groups])

  const branchOptions = useMemo(() => {
    const set = new Set(groups.flatMap((g) => g.items.map((c) => normalizeBranch(c.pickupBranch))))
    return [...set].sort((a, b) => {
      if (a === UNKNOWN_BRANCH_LABEL) return 1
      if (b === UNKNOWN_BRANCH_LABEL) return -1
      return a.localeCompare(b)
    })
  }, [groups])

  const activeFilterCount = useMemo(() => {
    return [
      collectorFilter !== 'all',
      submitterFilter !== 'all',
      bankFilter !== 'all',
      branchFilter !== 'all',
      arFilter !== 'all',
      urgencyFilter !== 'all',
      idStatusFilter !== 'all',
      amountMin !== '',
      amountMax !== '',
    ].filter(Boolean).length
  }, [collectorFilter, submitterFilter, bankFilter, branchFilter, arFilter, urgencyFilter, idStatusFilter, amountMin, amountMax])

  function clearAdvancedFilters() {
    setCollectorFilter('all')
    setSubmitterFilter('all')
    setBankFilter('all')
    setBranchFilter('all')
    setArFilter('all')
    setUrgencyFilter('all')
    setIdStatusFilter('all')
    setAmountMin('')
    setAmountMax('')
  }

  const visibleGroups = useMemo(() => {
    const term = search.trim()
    const min = amountMin.trim() !== '' && !Number.isNaN(Number(amountMin)) ? Number(amountMin) : null
    const max = amountMax.trim() !== '' && !Number.isNaN(Number(amountMax)) ? Number(amountMax) : null

    let list = groups
      .filter((g) => (collectorFilter === 'all' ? true : g.collectorName === collectorFilter))
      .filter((g) => (idStatusFilter === 'all' ? true : idInfoStatus(g.idInfo) === idStatusFilter))
      .map((g) => {
        const items = g.items.filter((c) => {
          if (submitterFilter !== 'all' && c.submitted_by_name !== submitterFilter) return false
          if (bankFilter !== 'all' && normalizeBank(c.bank) !== bankFilter) return false
          if (branchFilter !== 'all' && normalizeBranch(c.pickupBranch) !== branchFilter) return false
          if (arFilter === 'yes' && c.ar_collected !== true) return false
          if (arFilter === 'no' && c.ar_collected !== false) return false
          if (arFilter === 'unset' && !(c.ar_collected === null || c.ar_collected === undefined)) return false
          const amt = Number(c.amount) || 0
          if (min !== null && amt < min) return false
          if (max !== null && amt > max) return false
          return true
        })
        return { ...g, items }
      })
      .filter((g) => g.items.length > 0)
      .filter((g) => matchesSearch(g.items, term))

    list = list.map((g) => ({ ...g, total: orderTotal(g.items), submittedAtMs: earliestSubmittedAt(g.items) }))

    if (urgencyFilter === 'stale') {
      list = list.filter((g) => g.submittedAtMs && minutesWaiting(g.submittedAtMs) >= PENDING_WARN_MINUTES)
    } else if (urgencyFilter === 'critical') {
      list = list.filter((g) => g.submittedAtMs && minutesWaiting(g.submittedAtMs) >= PENDING_CRITICAL_MINUTES)
    }

    list.sort((a, b) => {
      switch (sortBy) {
        case 'submitted_desc':
          return (b.submittedAtMs || 0) - (a.submittedAtMs || 0)
        case 'amount_desc':
          return b.total - a.total
        case 'amount_asc':
          return a.total - b.total
        case 'collector_asc':
          return String(a.collectorName || '').localeCompare(String(b.collectorName || ''))
        case 'submitted_asc':
        default:
          return (a.submittedAtMs || 0) - (b.submittedAtMs || 0)
      }
    })

    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, search, sortBy, urgencyFilter, collectorFilter, submitterFilter, bankFilter, branchFilter, idStatusFilter, amountMin, amountMax, now])

  // Headline KPIs are deliberately computed off the full `groups` dataset
  // (not `visibleGroups`) so they stay accurate while an approver is
  // drilled into a filtered slice below.
  const summary = useMemo(() => {
    const allItems = groups.flatMap((g) => g.items)
    const waitMinutesList = groups
      .map((g) => earliestSubmittedAt(g.items))
      .filter(Boolean)
      .map((t) => Math.max(0, Math.round((now - t) / 60000)))

    const stale = waitMinutesList.filter((m) => m >= PENDING_WARN_MINUTES).length
    const critical = waitMinutesList.filter((m) => m >= PENDING_CRITICAL_MINUTES).length
    const avgWaitMinutes = waitMinutesList.length > 0 ? waitMinutesList.reduce((s, m) => s + m, 0) / waitMinutesList.length : 0
    const maxWaitMinutes = waitMinutesList.length > 0 ? Math.max(...waitMinutesList) : 0
    const uniqueCollectors = new Set(groups.map((g) => g.collectorName).filter(Boolean)).size
    const uniqueBanks = new Set(allItems.map((c) => normalizeBank(c.bank))).size
    const totalValue = orderTotal(allItems)
    const avgCheckAmount = allItems.length > 0 ? totalValue / allItems.length : 0
    const arNotCollected = allItems.filter((c) => c.ar_collected === false).length
    const idNotVerified = groups.filter((g) => idInfoStatus(g.idInfo) !== 'verified').length

    return {
      orders: groups.length,
      checks: allItems.length,
      totalValue,
      avgCheckAmount,
      stale,
      critical,
      avgWaitMinutes,
      maxWaitMinutes,
      uniqueCollectors,
      uniqueBanks,
      arNotCollected,
      idNotVerified,
    }
  }, [groups, now])

  const isTruncated = totalPendingCount >= MAX_PENDING_ROWS

  function toggleExpand(reservationId) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(reservationId)) next.delete(reservationId)
      else next.add(reservationId)
      return next
    })
  }

  function toggleSelectCheck(checkId) {
    setSelectedCheckIds((prev) => {
      const next = new Set(prev)
      if (next.has(checkId)) next.delete(checkId)
      else next.add(checkId)
      return next
    })
  }

  function toggleSelectAllInGroup(group) {
    setSelectedCheckIds((prev) => {
      const ids = group.items.map((c) => c.checkId)
      const allSelected = ids.every((id) => prev.has(id))
      const next = new Set(prev)
      if (allSelected) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })
  }

  const selectedCount = selectedCheckIds.size

  function openReviewForGroup(group) {
    lastFocusedElRef.current = document.activeElement
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ group, checks: group.items })
  }

  function openReviewForSelected() {
    if (selectedCount === 0) return
    const byReservation = new Map()
    groups.forEach((g) => {
      g.items.forEach((c) => {
        if (!selectedCheckIds.has(c.checkId)) return
        if (!byReservation.has(g.reservationId)) {
          byReservation.set(g.reservationId, { reservationId: g.reservationId, collectorName: g.collectorName, idInfo: g.idInfo, items: [] })
        }
        byReservation.get(g.reservationId).items.push(c)
      })
    })
    lastFocusedElRef.current = document.activeElement
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ groups: [...byReservation.values()], bulk: true })
  }

  const closeConfirm = useCallback(() => {
    clearTimeout(successTimerRef.current)
    setSuccessFlash(null)
    setConfirmAction(null)
    requestAnimationFrame(() => {
      lastFocusedElRef.current?.focus?.()
    })
  }, [])

  // Re-reads live status AND pickup branch for the given check ids right
  // before a decision is submitted, through a retrying, timeout-bound
  // query. Anything no longer 'pending_approval', or that moved outside
  // this approver's branch scope, was already claimed by another approver
  // (or recalled/reassigned) between load and confirm — those ids are
  // excluded from the RPC call instead of being resubmitted. This narrows
  // the race window; it does not close it — see the header comment.
  async function fetchLiveCheckState(checkIds, signal) {
    if (checkIds.length === 0) return new Map()
    const { data } = await runSupabaseQuery(
      () => supabase.from('checks').select('id, status, pickup_branch').in('id', checkIds).abortSignal(signal),
      signal
    )
    return new Map((data || []).map((r) => [r.id, r]))
  }

  function isCheckStillActionable(liveRow) {
    if (!liveRow || liveRow.status !== 'pending_approval') return false
    if (effectiveBranch && branchKey(liveRow.pickup_branch) !== branchKey(effectiveBranch)) return false
    return true
  }

  async function runDecision(decisionsByCheckId) {
    if (!confirmAction || actioning) return
    if (!authorized) {
      setActionError("You don't have permission to decide on checks.")
      return
    }
    if (branchLocked && !myBranchLabel) {
      setActionError('Your account has no assigned branch. Contact an admin before submitting decisions.')
      return
    }

    setActioning(true)
    setActionError('')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      const targets = confirmAction.bulk
        ? confirmAction.groups
        : [{ reservationId: confirmAction.group.reservationId, idInfo: confirmAction.group.idInfo, items: confirmAction.checks }]

      const allCheckIds = targets.flatMap((t) => t.items.map((c) => c.checkId))
      const liveState = await fetchLiveCheckState(allCheckIds, controller.signal)
      let staleCount = 0

      let approvedTotal = 0
      let returnedTotal = 0
      const results = []

      for (const t of targets) {
        const liveItems = t.items.filter((c) => isCheckStillActionable(liveState.get(c.checkId)))
        staleCount += t.items.length - liveItems.length
        if (liveItems.length === 0) continue

        const p_decisions = liveItems.map((c) => {
          const d = decisionsByCheckId[c.checkId]
          if (d.decision === 'approve') {
            approvedTotal += 1
            return { check_id: c.checkId, decision: 'approve', remarks: formatReleaseRemark(t.idInfo) }
          }
          returnedTotal += 1
          return { check_id: c.checkId, decision: 'return', remarks: d.remarks.trim() }
        })

        // approver_decide is SECURITY DEFINER and re-checks the caller's
        // role / auth.uid() server-side — the `authorized` check above is
        // UX only, never the real access boundary. It should also be the
        // layer that closes the race window entirely (atomic per-check
        // UPDATE ... WHERE status = 'pending_approval'); this client-side
        // revalidation only reduces its size.
        // eslint-disable-next-line no-await-in-loop
        const res = await supabase.rpc('approver_decide', { p_reservation_id: t.reservationId, p_decisions })
        results.push(res)
      }

      if (!isMountedRef.current) return

      if (results.length === 0 && staleCount > 0) {
        setActionError('These checks were already decided by another approver, or moved out of your branch. Refreshing the queue.')
        load(false)
        return
      }

      const failed = results.filter((r) => r.error).length
      if (failed > 0 && failed === results.length) {
        setActionError(results.find((r) => r.error)?.error?.message || 'Something went wrong. Please try again.')
        return
      }

      const parts = []
      if (approvedTotal > 0) parts.push(`${approvedTotal} approved`)
      if (returnedTotal > 0) parts.push(`${returnedTotal} returned for correction`)
      if (staleCount > 0) parts.push(`${staleCount} skipped (already handled, or out of your branch)`)
      const summaryMsg = parts.length > 0 ? parts.join(', ') : 'Decisions recorded'

      setSuccessFlash({ message: summaryMsg })
      clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => {
        if (!isMountedRef.current) return
        setSuccessFlash(null)
        setConfirmAction(null)
        setSelectedCheckIds(new Set())
        requestAnimationFrame(() => {
          lastFocusedElRef.current?.focus?.()
        })
      }, SUCCESS_FLASH_MS)

      load(false)
      showToast(
        failed > 0 ? `${summaryMsg}. ${failed} reservation(s) failed — check and retry.` : summaryMsg,
        failed > 0 || staleCount > 0 ? 'warning' : 'success'
      )
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(classifyError(err).message)
    } finally {
      clearTimeout(timeoutId)
      if (isMountedRef.current) setActioning(false)
    }
  }

  function exportCsv() {
    const headers = ['Collector', 'ID on file', 'Bank', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'Receipt', 'AR collected', '2307 Attached', 'Remarks', 'Submitted by', 'Submitted at']
    const rows = [headers]
    visibleGroups.forEach((g) => {
      g.items.forEach((c) => {
        rows.push([
          g.collectorName || '',
          formatIdSummary(g.idInfo),
          normalizeBank(c.bank),
          c.check_no || '',
          c.payee || '',
          c.payor || '',
          c.check_date || '',
          c.amount ?? '',
          c.or_no || '',
          c.ar_collected === null || c.ar_collected === undefined ? '' : c.ar_collected ? 'Yes' : 'No',
          c.attached_2307 === null || c.attached_2307 === undefined ? '' : c.attached_2307 ? 'Yes' : 'No',
          c.remarks || '',
          c.submitted_by_name || '',
          c.submitted_at || '',
        ])
      })
    })
    const csv = rows
      .map((row) =>
        row
          .map((cell) => {
            const str = String(cell ?? '')
            return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
          })
          .join(',')
      )
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pending-approval-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const activeSortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label || 'Sort'
  const hasActiveFilter =
    !!search.trim() ||
    urgencyFilter !== 'all' ||
    collectorFilter !== 'all' ||
    submitterFilter !== 'all' ||
    bankFilter !== 'all' ||
    branchFilter !== 'all' ||
    arFilter !== 'all' ||
    idStatusFilter !== 'all' ||
    amountMin !== '' ||
    amountMax !== ''

  if (profileLoading) {
    return <div className="flex min-h-[40vh] items-center justify-center text-sm text-ink-300">Loading…</div>
  }
  if (profileError) return <ProfileLoadError error={profileError} />
  if (!authorized) return <AccessDenied />
  if (!canQuery) return myBranchUnmapped ? <UnmappedBranch code={myBranchCode} /> : <NoBranchAssigned />

  return (
    <div className="pb-20 sm:pb-0">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-ledger-stamp/40 bg-ledger-stamp/10 text-ledger-stampDark">
            <Stamp className="h-4.5 w-4.5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ledger-stampDark/80">Verification queue</p>
              <BranchScopeBadge branch={effectiveBranch} locked={branchLocked} />
            </div>
            <h1 className="font-display text-2xl font-semibold text-ink-900">Pending approvals</h1>
            <p className="mt-1 text-sm text-ink-400">
              {name ? `Signed in as ${name}. ` : ''}Match each check against what was submitted, then approve for
              release or return it to the admin to fix a mistake. Identity is verified by the verifier at intake.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="hidden font-mono text-[11px] text-ink-300 sm:inline">
              Updated {Math.max(0, Math.round((now - lastUpdated) / 1000))}s ago
            </span>
          )}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-2.5 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50"
            title={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
          >
            {autoRefresh ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{autoRefresh ? 'Live' : 'Paused'}</span>
          </button>
          <button
            onClick={() => load(false)}
            disabled={refreshing || loading}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {isTruncated && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Showing the first {MAX_PENDING_ROWS} pickup checks awaiting approval. The queue has grown past what this
          page loads at once — ask engineering to raise the load limit or add pagination.
        </div>
      )}

      {!loading && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <LedgerStatCard icon={Layers} label="Orders" value={summary.orders} />
            <LedgerStatCard icon={Hash} label="Checks awaiting" value={summary.checks} />
            <LedgerStatCard icon={Wallet} label="Total value" value={formatCurrency(summary.totalValue)} />
            <LedgerStatCard
              icon={TrendingUp}
              label="Avg. check amount"
              value={summary.checks > 0 ? formatCurrency(summary.avgCheckAmount) : '—'}
            />
          </div>

          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            <button onClick={() => setUrgencyFilter((f) => (f === 'stale' ? 'all' : 'stale'))} className="text-left">
              <Card
                className={cn(
                  'relative overflow-hidden border-ink-100 p-4 transition',
                  summary.stale > 0 && 'border-orange-300 bg-orange-50',
                  urgencyFilter === 'stale' && 'ring-2 ring-orange-400'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600">
                    <Hourglass className="h-3.5 w-3.5" />
                  </span>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-ink-400">Waiting {PENDING_WARN_MINUTES}m+</p>
                </div>
                <p className={cn('mt-1.5 font-display text-2xl font-semibold', summary.stale > 0 ? 'text-orange-600' : 'text-ink-900')}>
                  {summary.stale}
                </p>
              </Card>
            </button>

            <button onClick={() => setUrgencyFilter((f) => (f === 'critical' ? 'all' : 'critical'))} className="text-left">
              <Card
                className={cn(
                  'relative overflow-hidden border-ink-100 p-4 transition',
                  summary.critical > 0 && 'border-red-300 bg-red-50',
                  urgencyFilter === 'critical' && 'ring-2 ring-red-400'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </span>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-ink-400">
                    Waiting {Math.round(PENDING_CRITICAL_MINUTES / 60)}h+
                  </p>
                </div>
                <p className={cn('mt-1.5 font-display text-2xl font-semibold', summary.critical > 0 ? 'text-red-600' : 'text-ink-900')}>
                  {summary.critical}
                </p>
              </Card>
            </button>

            <LedgerStatCard icon={Timer} label="Avg. wait" value={formatMinutesDuration(summary.avgWaitMinutes)} />
            <LedgerStatCard icon={Hourglass} label="Longest wait" value={formatMinutesDuration(summary.maxWaitMinutes)} />
            <LedgerStatCard icon={Users} label="Collectors" value={summary.uniqueCollectors} />
            <LedgerStatCard icon={Landmark} label="Banks" value={summary.uniqueBanks} />
            <button onClick={() => setIdStatusFilter((f) => (f === 'all' ? 'missing' : 'all'))} className="text-left">
              <LedgerStatCard
                icon={Fingerprint}
                label="Orders needing ID"
                value={summary.idNotVerified}
                accent={summary.idNotVerified > 0 ? 'warning' : undefined}
              />
            </button>
          </div>
        </>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
            <Input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search collector, bank, check #, payee, payor, or receipt... (press /)"
              className="border-ink-200 pl-9 pr-8 text-sm focus-visible:ring-teal-500"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600" aria-label="Clear search">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="relative shrink-0">
            <button
              onClick={() => setSortMenuOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 sm:w-auto"
            >
              <span className="flex items-center gap-1.5">
                <ArrowUpDown className="h-3.5 w-3.5" />
                {activeSortLabel}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-ink-400" />
            </button>
            {sortMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSortMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-ink-200 bg-white py-1 shadow-lg">
                  {SORT_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => { setSortBy(o.value); setSortMenuOpen(false) }}
                      className={cn('flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-ink-50', sortBy === o.value ? 'text-teal-700' : 'text-ink-600')}
                    >
                      {o.label}
                      {sortBy === o.value && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <button
            onClick={() => setShowAdvancedFilters((v) => !v)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-ink-50',
              activeFilterCount > 0 ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-ink-200 text-ink-600'
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">{activeFilterCount}</span>
            )}
            {showAdvancedFilters ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        <button
          onClick={exportCsv}
          disabled={visibleGroups.length === 0}
          className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      {showAdvancedFilters && (
        <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ink-100 bg-ink-50/50 p-3.5 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect label="Collector" value={collectorFilter} onChange={setCollectorFilter} options={[{ value: 'all', label: 'All collectors' }, ...collectorOptions.map((c) => ({ value: c, label: c }))]} />
          <FilterSelect label="Bank" value={bankFilter} onChange={setBankFilter} options={[{ value: 'all', label: 'All banks' }, ...bankOptions.map((b) => ({ value: b, label: b }))]} />
          {isAdmin && (
            <FilterSelect label="Pickup branch" value={branchFilter} onChange={setBranchFilter} options={[{ value: 'all', label: 'All branches' }, ...branchOptions.map((b) => ({ value: b, label: b }))]} />
          )}
          <FilterSelect label="Submitted by" value={submitterFilter} onChange={setSubmitterFilter} options={[{ value: 'all', label: 'Anyone' }, ...submitterOptions.map((s) => ({ value: s, label: s }))]} />
          <FilterSelect label="AR collected" value={arFilter} onChange={setArFilter} options={AR_FILTER_OPTIONS} />
          <FilterSelect label="Waiting time" value={urgencyFilter} onChange={setUrgencyFilter} options={URGENCY_FILTER_OPTIONS} />
          <FilterSelect label="ID on file" value={idStatusFilter} onChange={setIdStatusFilter} options={ID_STATUS_FILTER_OPTIONS} />

          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">Min amount</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amountMin}
              onChange={(e) => setAmountMin(e.target.value)}
              onBlur={() => {
                if (amountMin !== '' && amountMax !== '' && Number(amountMin) > Number(amountMax)) setAmountMax(amountMin)
              }}
              placeholder="0.00"
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>

          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">Max amount</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amountMax}
              onChange={(e) => setAmountMax(e.target.value)}
              onBlur={() => {
                if (amountMin !== '' && amountMax !== '' && Number(amountMax) < Number(amountMin)) setAmountMin(amountMax)
              }}
              placeholder="No limit"
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>

          <div className="flex items-end sm:col-span-2 lg:justify-end">
            <button
              onClick={clearAdvancedFilters}
              disabled={activeFilterCount === 0}
              className="rounded-md border border-ink-200 px-3.5 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear filters
            </button>
          </div>
        </div>
      )}

      {loadError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {loadError}
          </span>
          <button onClick={() => load(loading)} className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <ListSkeleton />
      ) : visibleGroups.length === 0 ? (
        <EmptyState hasFilter={hasActiveFilter} branchLabel={effectiveBranch || 'your branch'} />
      ) : (
        <div className="space-y-2.5">
          {visibleGroups.map((g) => (
            <ApprovalGroupRow
              key={g.reservationId}
              group={g}
              waitingLabel={formatWaiting(g.submittedAtMs)}
              urgencyLevel={pendingUrgency(g.submittedAtMs)}
              expanded={expandedIds.has(g.reservationId)}
              onToggleExpand={() => toggleExpand(g.reservationId)}
              selectedCheckIds={selectedCheckIds}
              onToggleSelectCheck={toggleSelectCheck}
              onToggleSelectAll={() => toggleSelectAllInGroup(g)}
              onReview={() => openReviewForGroup(g)}
            />
          ))}
        </div>
      )}

      {selectedCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-100 bg-white px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] sm:sticky sm:mt-4 sm:rounded-lg sm:border sm:shadow-sm">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <span className="text-sm font-medium text-ink-700">{selectedCount} check{selectedCount === 1 ? '' : 's'} selected</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setSelectedCheckIds(new Set())} className="rounded-md px-3 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50">
                Clear
              </button>
              <button onClick={openReviewForSelected} className="flex items-center gap-1.5 rounded-md bg-teal-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-700">
                <ShieldCheck className="h-3.5 w-3.5" />
                Review selected
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <ReviewModal action={confirmAction} onCancel={closeConfirm} onConfirm={runDecision} loading={actioning} error={actionError} successFlash={successFlash} />
      )}

      {toast && <Toast message={toast.message} variant={toast.variant} />}
    </div>
  )
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

function LedgerStatCard({ icon: Icon, label, value, accent }) {
  return (
    <Card className={cn('relative overflow-hidden border-ink-100 p-4', accent === 'warning' && 'border-orange-200 bg-orange-50/60')}>
      <div className="pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed border-ledger-stamp/30" aria-hidden="true" />
      <div className="relative flex items-center gap-2">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ledger-stamp/10 text-ledger-stampDark', accent === 'warning' && 'bg-orange-100 text-orange-600')}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-400">{label}</p>
      </div>
      <p className={cn('relative mt-1.5 font-display text-2xl font-semibold', accent === 'warning' ? 'text-orange-600' : 'text-ink-900')}>{value}</p>
    </Card>
  )
}

function ProfileLoadError({ error }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-orange-200 bg-orange-50/40 px-4 py-16 text-center">
      <AlertTriangle className="h-8 w-8 text-orange-300" />
      <p className="mt-3 text-lg font-semibold text-ink-700">Couldn't verify your account permissions</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">{error}</p>
    </div>
  )
}

function AccessDenied() {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-red-200 bg-red-50/40 px-4 py-16 text-center">
      <ShieldAlert className="h-8 w-8 text-red-300" />
      <p className="mt-3 text-lg font-semibold text-ink-700">You don't have access to this page</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        Approving checks for release requires the approver or admin role. If this seems wrong, ask an admin to check your account's role.
      </p>
    </div>
  )
}

function NoBranchAssigned() {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-amber-200 bg-amber-50/40 px-4 py-16 text-center">
      <Lock className="h-8 w-8 text-amber-300" />
      <p className="mt-3 text-lg font-semibold text-ink-700">Your account isn't linked to a branch yet</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        Pickup approvals are scoped per branch. Ask an admin to assign your account to a branch before reviewing checks here.
      </p>
    </div>
  )
}

function UnmappedBranch({ code }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-amber-200 bg-amber-50/40 px-4 py-16 text-center">
      <Lock className="h-8 w-8 text-amber-300" />
      <p className="mt-3 text-lg font-semibold text-ink-700">Your branch isn't recognized</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        Your account is assigned branch code "{code}", which isn't mapped to a pickup branch yet. Ask an admin to add it before reviewing checks here.
      </p>
    </div>
  )
}

function Toast({ message, variant }) {
  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 sm:bottom-6">
      <div className={cn('flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium text-white shadow-lg', variant === 'warning' ? 'bg-orange-600' : 'bg-ink-900')}>
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        {message}
      </div>
    </div>
  )
}

function ApprovalGroupRow({ group, waitingLabel, urgencyLevel, expanded, onToggleExpand, selectedCheckIds, onToggleSelectCheck, onToggleSelectAll, onReview }) {
  const items = group.items
  const total = orderTotal(items)
  const allSelected = items.every((c) => selectedCheckIds.has(c.checkId))
  const someSelected = items.some((c) => selectedCheckIds.has(c.checkId))
  const idStatus = idInfoStatus(group.idInfo)

  const distinctBanks = useMemo(() => [...new Set(items.map((c) => normalizeBank(c.bank)))], [items])
  const distinctBranches = useMemo(() => [...new Set(items.map((c) => normalizeBranch(c.pickupBranch)))], [items])

  const borderClass =
    urgencyLevel === 'critical' ? 'border-red-300' : urgencyLevel === 'warning' ? 'border-orange-300' : idStatus !== 'verified' ? 'border-amber-200' : 'border-ink-100'

  return (
    <Card className={cn('overflow-hidden p-0', borderClass)}>
      <div className="flex items-start gap-2.5 border-b border-dashed border-ink-100 bg-ink-50/40 px-3 py-3 sm:items-center sm:px-4">
        <button onClick={onToggleSelectAll} className="mt-0.5 shrink-0 text-ink-300 hover:text-teal-600 sm:mt-0" aria-label={allSelected ? 'Deselect all checks in this order' : 'Select all checks in this order'}>
          {allSelected ? <CheckSquare className="h-4.5 w-4.5 text-teal-600" /> : someSelected ? <MinusSquare className="h-4.5 w-4.5 text-teal-600" /> : <Square className="h-4.5 w-4.5" />}
        </button>

        <button onClick={onToggleExpand} className="flex min-w-0 flex-1 flex-col gap-1.5 text-left sm:flex-row sm:items-center sm:gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <User className="h-4 w-4 shrink-0 text-ink-400" />
            <div className="min-w-0">
              <span className="truncate font-display font-medium text-ink-900" title={group.collectorName || undefined}>
                {group.collectorName || 'Unknown collector'}
              </span>
              {items[0]?.submitted_by_name && (
                <p className="truncate font-mono text-xs text-ink-400" title={items[0].submitted_by_name}>
                  Submitted by {items[0].submitted_by_name}
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-ink-500 sm:pl-0">
            <span className="flex items-center gap-1 rounded-full bg-ledger-amber/15 px-2 py-0.5 font-medium text-ledger-amber">
              <Layers className="h-3 w-3" />
              {items.length} awaiting
            </span>
            <IdStatusBadge idInfo={group.idInfo} />
            {distinctBranches.length <= 2 ? (
              distinctBranches.map((b) => <BranchBadge key={b} branch={b} />)
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-ink-200 bg-white px-2 py-0.5 text-[11px] font-medium text-ink-600" title={distinctBranches.join(', ')}>
                <Building2 className="h-3 w-3 shrink-0" />
                {distinctBranches.length} branches
              </span>
            )}
            {distinctBanks.length <= 2 ? (
              distinctBanks.map((b) => <BankBadge key={b} bank={b} />)
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500" title={distinctBanks.join(', ')}>
                <Landmark className="h-3 w-3 shrink-0" />
                {distinctBanks.length} banks
              </span>
            )}
            <span className="font-mono font-semibold text-ink-800">{formatCurrency(total)}</span>
            <span className={cn('flex items-center gap-1 font-mono font-medium', urgencyLevel === 'critical' ? 'text-red-600' : urgencyLevel === 'warning' ? 'text-orange-600' : 'text-ink-500')}>
              <Hourglass className="h-3.5 w-3.5" />
              Waiting {waitingLabel}
            </span>
            {expanded ? <ChevronUp className="h-4 w-4 text-ink-300" /> : <ChevronDown className="h-4 w-4 text-ink-300" />}
          </div>
        </button>
      </div>

      {expanded && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-sm">
              <thead>
                <tr className="border-b border-dashed border-ink-100 text-left font-mono text-[11px] uppercase tracking-wide text-ink-400">
                  <th className="px-4 py-2 font-medium"></th>
                  <th className="px-2 py-2 font-medium">Check no.</th>
                  <th className="px-2 py-2 font-medium">Bank</th>
                  <th className="px-2 py-2 font-medium">Payee</th>
                  <th className="px-2 py-2 font-medium">Payor</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-2 py-2 font-medium">Receipt</th>
                  <th className="px-2 py-2 font-medium">AR collected</th>
                  <th className="px-2 py-2 font-medium">2307 Attached</th>
                  <th className="px-4 py-2 font-medium">Remarks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dashed divide-ink-50">
                {items.map((c, idx) => (
                  <tr key={c.checkId ?? idx}>
                    <td className="px-4 py-2.5">
                      <button onClick={() => onToggleSelectCheck(c.checkId)} className={selectedCheckIds.has(c.checkId) ? 'text-teal-600' : 'text-ink-300 hover:text-ink-500'} aria-label={selectedCheckIds.has(c.checkId) ? 'Deselect check' : 'Select check'}>
                        {selectedCheckIds.has(c.checkId) ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-700">
                      <span className="flex items-start gap-1">
                        <Hash className="mt-0.5 h-3 w-3 shrink-0 text-ink-300" />
                        <span className="break-all">{c.check_no ?? '—'}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5"><BankBadge bank={c.bank} /></td>
                    <td className="max-w-[140px] px-2 py-2.5 font-medium text-ink-900">
                      <FitText text={c.payee} />
                    </td>
                    <td className="max-w-[140px] truncate px-2 py-2.5 text-ink-600" title={c.payor || undefined}>{c.payor || '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-medium text-ink-700">{safeCurrency(c.amount)}</td>
                    <td className="px-2 py-2.5 font-mono text-xs text-ink-700" title={c.or_no || undefined}>{c.or_no || '—'}</td>
                    <td className="px-2 py-2.5">
                      {c.ar_collected === null || c.ar_collected === undefined ? '—' : c.ar_collected ? (
                        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
                      ) : (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      {c.attached_2307 === null || c.attached_2307 === undefined ? '—' : c.attached_2307 ? (
                        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
                      ) : (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
                      )}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-2.5 text-xs text-ink-500" title={c.remarks || undefined}>{c.remarks || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-ink-100 bg-ink-50/40 px-4 py-3">
            <span className="flex items-center gap-1.5 text-xs text-ink-500">
              <Fingerprint className="h-3.5 w-3.5 text-ink-400" />
              {formatIdSummary(group.idInfo)}
            </span>
            <button onClick={onReview} className="flex items-center gap-1.5 rounded-md bg-teal-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-700">
              <ShieldCheck className="h-3.5 w-3.5" />
              Review this order
            </button>
          </div>
        </>
      )}
    </Card>
  )
}

// Every check starts as "approve" — for a queue that's usually correct,
// this keeps the approver's job to "click through the good ones, stop and
// act on the bad ones." Remarks only matter for a return.
function buildInitialDecisions(checks) {
  const initial = {}
  checks.forEach((c) => { initial[c.checkId] = { decision: 'approve', remarks: '' } })
  return initial
}

function reservationGroupsFromAction(action) {
  if (action.bulk) return action.groups
  return [{ reservationId: action.group.reservationId, collectorName: action.group.collectorName, idInfo: action.group.idInfo, items: action.checks }]
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function ReviewModal({ action, onCancel, onConfirm, loading, error, successFlash }) {
  const allChecks = action.bulk ? action.groups.flatMap((g) => g.items) : action.checks
  const total = orderTotal(allChecks)
  const reservationGroups = useMemo(() => reservationGroupsFromAction(action), [action])
  const dialogRef = useRef(null)
  const cancelButtonRef = useRef(null)
  const remarksRefs = useRef({})

  const [decisions, setDecisions] = useState(() => buildInitialDecisions(allChecks))
  const [showValidation, setShowValidation] = useState(false)

  const updateDecision = useCallback((checkId, decision) => {
    setDecisions((prev) => ({ ...prev, [checkId]: { decision, remarks: decision === 'approve' ? '' : prev[checkId]?.remarks || '' } }))
  }, [])

  const updateRemarks = useCallback((checkId, value) => {
    setDecisions((prev) => ({ ...prev, [checkId]: { ...prev[checkId], remarks: value.slice(0, REMARKS_MAX_LEN) } }))
  }, [])

  const { approveCount, returnCount, decisionsComplete, firstIncompleteId } = useMemo(() => {
    let approve = 0
    let ret = 0
    let complete = true
    let firstIncomplete = null
    allChecks.forEach((c) => {
      const d = decisions[c.checkId]
      if (!d) {
        complete = false
        if (!firstIncomplete) firstIncomplete = c.checkId
        return
      }
      if (d.decision === 'approve') {
        approve += 1
        return
      }
      ret += 1
      if (!d.remarks?.trim()) {
        complete = false
        if (!firstIncomplete) firstIncomplete = c.checkId
      }
    })
    return { approveCount: approve, returnCount: ret, decisionsComplete: complete, firstIncompleteId: firstIncomplete }
  }, [decisions, allChecks])

  // Reservations with at least one check currently set to "approve" — a
  // release is about to happen, so each one must have a valid, unexpired
  // ID already on file from the verifier. Approving is blocked otherwise;
  // the approver cannot enter ID details here.
  const groupsNeedingId = useMemo(
    () => reservationGroups.filter((g) => g.items.some((c) => (decisions[c.checkId]?.decision || 'approve') === 'approve')),
    [reservationGroups, decisions]
  )
  const idBlockedGroups = useMemo(() => groupsNeedingId.filter((g) => idInfoStatus(g.idInfo) !== 'verified'), [groupsNeedingId])
  const idComplete = idBlockedGroups.length === 0
  const allComplete = decisionsComplete && idComplete

  useEffect(() => {
    cancelButtonRef.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prevOverflow }
  }, [])

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && !loading) { onCancel(); return }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [loading, onCancel])

  function handleConfirmClick() {
    if (!allComplete) {
      setShowValidation(true)
      if (firstIncompleteId != null) {
        remarksRefs.current[firstIncompleteId]?.focus()
        remarksRefs.current[firstIncompleteId]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      return
    }
    onConfirm(decisions)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-3 sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget && !loading && !successFlash) onCancel() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="review-modal-title" className="relative flex max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl xl:max-w-7xl">
        <div className="flex shrink-0 items-center justify-between border-b border-dashed border-ink-100 bg-ink-50/50 px-6 py-4">
          <div>
            <h2 id="review-modal-title" className="flex items-center gap-2 font-display text-xl font-semibold text-ink-900">
              <Stamp className="h-5 w-5 text-ledger-stampDark" />
              Verify and decide
            </h2>
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">
              {allChecks.length} check{allChecks.length === 1 ? '' : 's'} · {formatCurrency(total)}
            </p>
          </div>
          <button onClick={onCancel} disabled={loading} className="text-ink-300 hover:text-ink-600 disabled:opacity-40" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <p className="text-sm text-ink-600">
            Physically match each check against what was entered. <span className="font-medium text-ink-800">Approve</span> what
            checks out for release. <span className="font-medium text-ink-800">Return</span> anything with a fixable mistake back
            to the submitting admin — a return requires a short reason.
          </p>

          <div className="mt-3 mb-3 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-teal-100 px-2.5 py-1 text-xs font-medium text-teal-700">{approveCount} to approve</span>
            {returnCount > 0 && <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">{returnCount} to return</span>}
          </div>

          <div className="overflow-hidden rounded-lg border border-ink-100">
            <div className="max-h-[42vh] overflow-y-auto">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[12%]" />
                  <col className="w-[8%]" />
                  <col className="w-[9%]" />
                  <col className="w-[11%]" />
                  <col className="w-[7%]" />
                  <col className="w-[8%]" />
                  <col className="w-[7%]" />
                  <col className="w-[5%]" />
                  <col className="w-[5%]" />
                  <col className="w-[14%]" />
                  <col className="w-[14%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-ink-50 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                  <tr className="text-left font-mono text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="px-4 py-2.5 font-medium">Check no.</th>
                    <th className="px-4 py-2.5 font-medium">Branch</th>
                    <th className="px-4 py-2.5 font-medium">Bank</th>
                    <th className="px-4 py-2.5 font-medium">Payee</th>
                    <th className="px-4 py-2.5 font-medium">Payor</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Receipt</th>
                    <th className="px-4 py-2.5 font-medium">AR</th>
                    <th className="px-4 py-2.5 font-medium">2307</th>
                    <th className="px-4 py-2.5 font-medium">Decision</th>
                    <th className="px-4 py-2.5 font-medium">Reason (return only)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dashed divide-ink-50">
                  {allChecks.map((c, idx) => {
                    const d = decisions[c.checkId] || { decision: 'approve', remarks: '' }
                    const requiresReason = d.decision !== 'approve'
                    const missingReason = requiresReason && !d.remarks?.trim()
                    const flagRow = showValidation && missingReason
                    return (
                      <tr key={c.checkId ?? idx} className={cn('align-top transition-colors', d.decision === 'return' && 'bg-amber-50/50', flagRow && 'bg-orange-50 ring-1 ring-inset ring-orange-300')}>
                        <td className="px-4 py-3 font-mono text-xs text-ink-700">
                          <span className="flex items-start gap-1">
                            <Hash className="mt-0.5 h-3 w-3 shrink-0 text-ink-300" />
                            <span className="break-all">{c.check_no ?? '—'}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3"><BranchBadge branch={c.pickupBranch} /></td>
                        <td className="px-4 py-3"><BankBadge bank={c.bank} /></td>
                        <td className="px-4 py-3 font-medium text-ink-900">
                          <FitText text={c.payee} />
                        </td>
                        <td className="truncate px-4 py-3 text-ink-600" title={c.payor || undefined}>{c.payor ?? '—'}</td>
                        <td className="px-4 py-3 text-right font-mono text-ink-700">{safeCurrency(c.amount)}</td>
                        <td className="truncate px-4 py-3 font-mono text-xs text-ink-700" title={c.or_no || undefined}>{c.or_no ?? '—'}</td>
                        <td className="px-4 py-3">{c.ar_collected === null || c.ar_collected === undefined ? '—' : c.ar_collected ? 'Yes' : 'No'}</td>
                        <td className="px-4 py-3">{c.attached_2307 === null || c.attached_2307 === undefined ? '—' : c.attached_2307 ? 'Yes' : 'No'}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex gap-1.5" role="group" aria-label={`Decision for check ${c.check_no || idx + 1}`}>
                            <button
                              type="button"
                              onClick={() => updateDecision(c.checkId, 'approve')}
                              title="Approve for release"
                              aria-pressed={d.decision === 'approve'}
                              className={cn('flex items-center gap-1 rounded border px-2 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-teal-500', d.decision === 'approve' ? 'border-teal-600 bg-teal-600 text-white' : 'border-ink-200 text-ink-500 hover:bg-ink-50')}
                            >
                              <Check className="h-3.5 w-3.5" />
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => updateDecision(c.checkId, 'return')}
                              title="Send back to admin for correction"
                              aria-pressed={d.decision === 'return'}
                              className={cn('flex items-center gap-1 rounded border px-2 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-amber-500', d.decision === 'return' ? 'border-amber-600 bg-amber-600 text-white' : 'border-ink-200 text-ink-500 hover:bg-ink-50')}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Return
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          {requiresReason ? (
                            <div className="flex flex-col gap-1">
                              <input
                                ref={(el) => { if (el) remarksRefs.current[c.checkId] = el; else delete remarksRefs.current[c.checkId] }}
                                type="text"
                                value={d.remarks}
                                onChange={(e) => updateRemarks(c.checkId, e.target.value)}
                                onBlur={(e) => updateRemarks(c.checkId, e.target.value.trim())}
                                placeholder="What needs fixing?"
                                maxLength={REMARKS_MAX_LEN}
                                required
                                aria-required="true"
                                aria-invalid={missingReason}
                                className={cn('w-full rounded border px-2.5 py-1.5 text-sm text-ink-800 focus:outline-none focus:ring-1 focus:ring-teal-500', flagRow ? 'border-orange-400' : 'border-ink-200')}
                              />
                              <div className="flex items-center justify-between">
                                {flagRow ? (
                                  <span className="flex items-center gap-1 text-[11px] text-orange-600">
                                    <AlertTriangle className="h-3 w-3 shrink-0" />
                                    Reason required
                                  </span>
                                ) : <span />}
                                <span className="text-[11px] text-ink-300">{d.remarks.length}/{REMARKS_MAX_LEN}</span>
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-ink-300">No explanation needed</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-100 bg-ink-50/60">
                    <td colSpan={4} className="px-4 py-2.5 text-right font-medium text-ink-500">Total</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-ink-900">{formatCurrency(total)}</td>
                    <td colSpan={5} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {showValidation && !decisionsComplete && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-orange-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Enter a reason for every returned check before confirming.
            </p>
          )}

          {returnCount > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Returned checks go back to the submitting admin's Active list — the collector's reservation is
              unaffected and nobody else can claim it while it's corrected.
            </div>
          )}

          {/* Read-only ID summary per reservation being released to — data
              entered upstream by the verifier. Approving is blocked for any
              reservation without a valid, unexpired ID on file. */}
          {groupsNeedingId.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">
                <Fingerprint className="h-3.5 w-3.5" />
                Identity on file (recorded by verifier)
              </p>
              <div className="flex flex-col gap-2.5">
                {groupsNeedingId.map((g) => {
                  const status = idInfoStatus(g.idInfo)
                  const releasingCount = g.items.filter((c) => (decisions[c.checkId]?.decision || 'approve') === 'approve').length
                  const blocked = status !== 'verified'
                  return (
                    <div key={g.reservationId} className={cn('flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3.5', blocked ? 'border-orange-300 bg-orange-50/60' : 'border-ink-100 bg-ink-50/30')}>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="flex items-center gap-1.5 text-sm font-semibold text-ink-800">
                          <User className="h-3.5 w-3.5 text-ink-400" />
                          {g.collectorName || 'Unknown collector'}
                          <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">
                            Releasing {releasingCount} check{releasingCount === 1 ? '' : 's'}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5 text-xs text-ink-600">
                          <Fingerprint className="h-3 w-3 text-ink-400" />
                          {formatIdSummary(g.idInfo)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <IdStatusBadge idInfo={g.idInfo} />
                        {blocked && (
                          <span className="text-[11px] font-medium text-orange-600">
                            Cannot release — ask the verifier to confirm identity for this collector first.
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {error && (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-dashed border-ink-100 px-6 py-4">
          <button ref={cancelButtonRef} onClick={onCancel} disabled={loading} className="rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">
            Cancel
          </button>
          <button onClick={handleConfirmClick} disabled={loading} className="flex items-center gap-2 rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60">
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm decisions
          </button>
        </div>

        {successFlash && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 backdrop-blur-sm">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-teal-100">
              <Check className="h-7 w-7 text-teal-600" strokeWidth={3} />
            </div>
            <p className="text-sm font-semibold text-ink-800">{successFlash.message}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg border border-ink-100 bg-ink-50/60" />
      ))}
    </div>
  )
}

function EmptyState({ hasFilter, branchLabel }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-ink-200 px-4 py-16 text-center">
      <ShieldCheck className="h-8 w-8 text-ink-200" />
      <p className="mt-3 font-display text-lg font-semibold text-ink-700">{hasFilter ? 'No matching checks' : 'Nothing awaiting approval'}</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        {hasFilter ? 'Try a different search or filter combination, or clear your filters.' : `Checks submitted for ${branchLabel} will show up here for verification.`}
      </p>
    </div>
  )
}