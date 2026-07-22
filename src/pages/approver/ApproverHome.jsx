// src/pages/approver/ApproverHome.jsx
//
// This is the other half of the submit-for-approval flow started in
// AdminPickups.jsx. An admin submits per-check pickup data (OR no., AR
// collected, 2307 attached, remarks); those checks land here as
// 'pending_approval'. For each one, an approver makes one of two decisions
// exposed in this UI:
//   - Approve -> check is finally marked picked_up. Done.
//   - Return  -> check goes back to the SAME reservation as 'reserved',
//                landing back in the submitting admin's Active tab so they
//                can fix a mistake (e.g. a mistyped OR number) and
//                resubmit. It is NOT released to the pool, so nobody else
//                can grab it out from under the original collector while
//                the correction is made.
//
// NOTE: the underlying approver_decide RPC still accepts a 'reject'
// decision (check released straight back into the general available
// pool), but the Reject button has intentionally been removed from this
// page's UI — Return covers the "this needs to change" case, and pool
// release for a submitted check is no longer offered as a one-click
// approver action here.
//
// Requires the approval-workflow migration (admin_submit_for_approval,
// admin_recall_submission, approver_decide, checks.status =
// 'pending_approval', profiles table) to have been run first.
//
// Restyled to match the "ledger" visual identity used in AdminDashboard.jsx
// (font-display headings, font-mono uppercase labels, dashed hairlines,
// ledger-stamp / ledger-amber accents) and wired through <ApproverLayout>.
// Route-level access is enforced by <ProtectedRoute roles={['approver','admin']}>;
// this file also does an in-component role check as defense-in-depth, since
// the real authority is always the Postgres RLS policy on approver_decide.
//
// KPI + filtering notes:
//   - All KPI figures on this page are derived live from `groups` (the
//     current pending-approval dataset) via useMemo, recomputed on every
//     poll/refresh and every second (for wait-time figures). Nothing here
//     is hardcoded or sampled — if a number looks wrong, it's a data bug
//     upstream, not a stale display.
//   - The top KPI row always reflects the FULL pending-approval queue,
//     regardless of active filters, so approvers always have an accurate
//     top-level picture even while drilled into a filtered view.
//   - The advanced filter panel filters at the individual check level
//     (AR status, submitter, amount) and at the order/group level
//     (collector, waiting time), then drops any group left with zero
//     matching checks. Group totals and wait times shown in the list are
//     recomputed against the filtered items, so what's displayed is always
//     internally consistent.
//
// Data source note (fixed — read before touching load()):
//   - This page used to query `pickup_reservations` filtered by the
//     reservation's own `status = 'pending_approval'`, then pulled in that
//     reservation's checks. That's wrong: a reservation can still sit at
//     `status = 'reserved'` while individual checks inside it have already
//     moved to `pending_approval` (admin_submit_for_approval only needs to
//     touch the check rows, not the parent reservation row). Filtering
//     reservations-first silently dropped those checks from this page even
//     though ApproverDashboard.jsx — which queries `checks.status` directly
//     — showed them fine.
//   - The fix: query `checks` directly (same table + column the dashboard's
//     "Awaiting your decision" KPI reads) and embed the parent reservation
//     only for display (collector name) and for the id approver_decide
//     needs. See buildPendingRows() and load() below. Do not reintroduce a
//     `pickup_reservations`-first query here.
//
// ReviewModal notes (read before touching):
//   - The modal is deliberately wide (max-w-6xl / xl:max-w-7xl) with a
//     table-fixed layout and explicit column widths so it never needs
//     horizontal scrolling at normal viewport sizes — don't reintroduce
//     truncate-without-title cells or shrink the modal back down without
//     re-checking that long payee/payor/check-no values still fit or are
//     at least fully readable via the title tooltip.
//   - The modal has a real focus trap (Tab/Shift+Tab wrap within the
//     dialog) and restores focus to whatever triggered it on close, on
//     top of the existing "focus cancel button on open" and "Escape to
//     close" behavior. Keep all three if you touch this.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import { useProfile, hasRole } from '../../context/ProfileContext'

const POLL_INTERVAL_MS = 20000
const SUCCESS_FLASH_MS = 900
const ALLOWED_ROLES = ['approver', 'admin']
// Keep these in sync with the matching constants in AdminPickups.jsx so
// both pages agree on what counts as "taking too long."
const PENDING_WARN_MINUTES = 60
const PENDING_CRITICAL_MINUTES = 240
const REMARKS_MAX_LEN = 200

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

// Fallback label whenever a check's bank field is blank/null — upload
// batches created before the `bank` column existed, or rows where the
// uploader left it empty, will hit this. Keep it distinct from a real
// bank name so it's obviously a data gap rather than a bank called
// "Unspecified".
const UNKNOWN_BANK_LABEL = 'Unspecified'

// Normalizes a raw checks.bank value for display, grouping, and filtering
// so that '', null, undefined, and whitespace-only values are all treated
// as the same "unknown" bucket instead of silently creating near-duplicate
// filter options (e.g. '' vs null both showing up separately).
function normalizeBank(bank) {
  const trimmed = typeof bank === 'string' ? bank.trim() : ''
  return trimmed || UNKNOWN_BANK_LABEL
}

// One row per check pending approval. The query in load() below starts
// from `checks` — the same table and status column the dashboard's
// "Awaiting your decision" KPI reads — rather than starting from
// `pickup_reservations`. A reservation's own status can lag behind the
// status of the checks inside it, so filtering reservations-first can
// silently miss checks that are genuinely pending approval. The parent
// reservation is embedded only for display (collector name) and for the
// id approver_decide needs.
function buildPendingRows(checks) {
  return (checks || []).map((c) => {
    // Left-embedded on purpose (not `!inner`): if RLS ever blocks the
    // approver role from reading the parent reservation row, the check
    // still shows up here — just without a collector name — instead of
    // disappearing from the queue entirely.
    const reservation = c.pickup_reservations || {}
    return {
      id: c.id,
      checkId: c.id,
      reservationId: c.reservation_id ?? reservation.id ?? null,
      collectorName: reservation.collector_name || null,
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
      // checks.bank is NOT NULL DEFAULT '' at the schema level, so this is
      // usually a real (if possibly empty) string rather than null/undefined
      // — normalizeBank() below is what turns '' into a real display value.
      bank: c.bank,
    }
  })
}

function groupByReservation(rows) {
  const map = new Map()
  rows.forEach((row) => {
    if (!map.has(row.reservationId)) {
      map.set(row.reservationId, { reservationId: row.reservationId, collectorName: row.collectorName, items: [] })
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

function orderTotal(items) {
  return items.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
}

// Earliest submission across a group's checks — that's when the clock
// starts on "how long has this been waiting for review."
function earliestSubmittedAt(items) {
  const times = items.map((c) => c.submitted_at).filter(Boolean).map((t) => new Date(t).getTime())
  if (times.length === 0) return null
  return Math.min(...times)
}

// Pure formatter (no dependency on "now") for a raw minute count — used by
// KPI cards that already receive a computed duration.
function formatMinutesDuration(mins) {
  if (mins === null || mins === undefined || Number.isNaN(mins)) return '—'
  const whole = Math.max(0, Math.round(mins))
  if (whole < 60) return `${whole}m`
  const hrs = Math.floor(whole / 60)
  const rem = whole % 60
  return `${hrs}h ${rem}m`
}

// Small shared helper so every table cell in this file formats a currency
// amount the same defensive way — a bad/missing amount renders as '—'
// instead of throwing or showing '₱NaN'.
function safeCurrency(amount) {
  const n = Number(amount)
  return Number.isFinite(n) ? formatCurrency(n) : '—'
}

// Deterministic small color set for bank badges, keyed off the bank name
// itself (hashed) so the same bank always gets the same color across
// renders/sessions without needing a hardcoded bank->color map that would
// go stale the moment a new bank shows up in an upload.
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

function bankBadgeClass(bank) {
  if (bank === UNKNOWN_BANK_LABEL) return 'bg-ink-100 text-ink-500'
  let hash = 0
  for (let i = 0; i < bank.length; i += 1) {
    hash = (hash * 31 + bank.charCodeAt(i)) >>> 0
  }
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

export default function ApproverHome() {
  const { role, name, loading: profileLoading, error: profileError } = useProfile()

  const [groups, setGroups] = useState([])
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

  // Advanced filters — all optional, all compose together (AND). Options
  // for collector/submitter/bank are derived live from the loaded data,
  // never hardcoded, so they always match what's actually in the queue.
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [collectorFilter, setCollectorFilter] = useState('all')
  const [submitterFilter, setSubmitterFilter] = useState('all')
  const [bankFilter, setBankFilter] = useState('all')
  const [urgencyFilter, setUrgencyFilter] = useState('all') // 'all' | 'stale' | 'critical'
  const [arFilter, setArFilter] = useState('all') // 'all' | 'yes' | 'no' | 'unset'
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')

  const isMountedRef = useRef(true)
  const inFlightRef = useRef(false)
  const requestIdRef = useRef(0)
  const toastTimerRef = useRef(null)
  const successTimerRef = useRef(null)
  const searchInputRef = useRef(null)
  // Whatever had focus right before the review modal opened — restored on
  // close so keyboard/screen-reader users land back where they were
  // instead of at the top of the page.
  const lastFocusedElRef = useRef(null)

  const authorized = hasRole(role, ALLOWED_ROLES)

  useEffect(() => {
    isMountedRef.current = true
    if (!profileLoading && authorized) load(true)
    return () => {
      isMountedRef.current = false
      clearTimeout(successTimerRef.current)
      clearTimeout(toastTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileLoading, authorized])

  useEffect(() => {
    if (!authorized) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => {
      if (autoRefresh) load(false)
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, authorized])

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
    if (inFlightRef.current && !showFullLoading) return
    const requestId = ++requestIdRef.current
    inFlightRef.current = true

    if (showFullLoading) setLoading(true)
    else setRefreshing(true)
    setLoadError('')

    try {
      // Query `checks` directly — same table and status column the
      // dashboard's "Awaiting your decision" KPI reads — instead of
      // starting from `pickup_reservations`. This can't miss a pending
      // check regardless of what the reservation's own status column says.
      // The reservation is embedded only for display (collector name) and
      // for the id approver_decide needs; it is NOT used to filter.
      //
      // Assumes `checks.reservation_id` is the FK to pickup_reservations.id
      // (matches the `p_reservation_id` param name on approver_decide). If
      // your schema names that column differently, buildPendingRows()
      // already falls back to the embedded reservation's own id, so this
      // degrades gracefully rather than breaking. If Supabase reports an
      // ambiguous relationship when embedding, disambiguate with
      // `pickup_reservations!<fk_constraint_name>(...)`.
      const { data, error } = await supabase
        .from('checks')
        .select(
          'id, status, row_number, payee, payor, check_no, check_date, amount, or_no, ar_collected, attached_2307, remarks, submitted_by_name, submitted_at, reservation_id, bank, pickup_reservations(id, collector_name, status)'
        )
        .eq('status', 'pending_approval')
        .order('submitted_at', { ascending: true })
        .limit(150)

      if (!isMountedRef.current || requestId !== requestIdRef.current) return

      if (error) {
        // A 401/403 here almost always means the RLS policy on
        // pending_approval checks doesn't recognize this role — surface
        // that distinctly from a generic network failure.
        const isAuthError = error.code === 'PGRST301' || /permission|policy/i.test(error.message || '')
        setLoadError(
          isAuthError
            ? "You don't have permission to view pending approvals. Contact an admin if this seems wrong."
            : error.message || 'Failed to load pending approvals. Please try again.'
        )
        return
      }

      const rows = buildPendingRows(data || [])
      setGroups(groupByReservation(rows))
      setLastUpdated(Date.now())
      setSelectedCheckIds((prev) => {
        if (prev.size === 0) return prev
        const validIds = new Set(rows.map((r) => r.checkId))
        const next = new Set([...prev].filter((id) => validIds.has(id)))
        return next.size === prev.size ? prev : next
      })
    } catch (err) {
      if (!isMountedRef.current || requestId !== requestIdRef.current) return
      setLoadError(err?.message || 'Failed to load pending approvals. Please try again.')
    } finally {
      if (isMountedRef.current && requestId === requestIdRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
      inFlightRef.current = false
    }
  }, [])

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

  // Options for the collector / submitter / bank dropdowns — always
  // derived from whatever is actually in the current pending-approval
  // queue, so they never drift out of sync with real data and never show
  // a stale name that no longer has anything pending.
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
    // Keep "Unspecified" pinned last rather than sorted alphabetically in
    // with real bank names — it's a data-quality bucket, not a bank.
    return [...set].sort((a, b) => {
      if (a === UNKNOWN_BANK_LABEL) return 1
      if (b === UNKNOWN_BANK_LABEL) return -1
      return a.localeCompare(b)
    })
  }, [groups])

  const activeFilterCount = useMemo(() => {
    return [
      collectorFilter !== 'all',
      submitterFilter !== 'all',
      bankFilter !== 'all',
      arFilter !== 'all',
      urgencyFilter !== 'all',
      amountMin !== '',
      amountMax !== '',
    ].filter(Boolean).length
  }, [collectorFilter, submitterFilter, bankFilter, arFilter, urgencyFilter, amountMin, amountMax])

  function clearAdvancedFilters() {
    setCollectorFilter('all')
    setSubmitterFilter('all')
    setBankFilter('all')
    setArFilter('all')
    setUrgencyFilter('all')
    setAmountMin('')
    setAmountMax('')
  }

  const visibleGroups = useMemo(() => {
    const term = search.trim()
    const min = amountMin.trim() !== '' && !Number.isNaN(Number(amountMin)) ? Number(amountMin) : null
    const max = amountMax.trim() !== '' && !Number.isNaN(Number(amountMax)) ? Number(amountMax) : null

    let list = groups
      .filter((g) => (collectorFilter === 'all' ? true : g.collectorName === collectorFilter))
      .map((g) => {
        const items = g.items.filter((c) => {
          if (submitterFilter !== 'all' && c.submitted_by_name !== submitterFilter) return false
          if (bankFilter !== 'all' && normalizeBank(c.bank) !== bankFilter) return false
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
  }, [groups, search, sortBy, urgencyFilter, collectorFilter, submitterFilter, bankFilter, arFilter, amountMin, amountMax, now])

  // Top-of-page KPIs — deliberately computed off the FULL `groups` dataset
  // (not `visibleGroups`), so the headline numbers always describe the
  // whole pending-approval queue even while an approver is drilled into a
  // filtered slice of it below.
  const summary = useMemo(() => {
    const allItems = groups.flatMap((g) => g.items)

    const waitMinutesList = groups
      .map((g) => earliestSubmittedAt(g.items))
      .filter(Boolean)
      .map((t) => Math.max(0, Math.round((now - t) / 60000)))

    const stale = waitMinutesList.filter((m) => m >= PENDING_WARN_MINUTES).length
    const critical = waitMinutesList.filter((m) => m >= PENDING_CRITICAL_MINUTES).length
    const avgWaitMinutes =
      waitMinutesList.length > 0 ? waitMinutesList.reduce((s, m) => s + m, 0) / waitMinutesList.length : 0
    const maxWaitMinutes = waitMinutesList.length > 0 ? Math.max(...waitMinutesList) : 0

    const uniqueCollectors = new Set(groups.map((g) => g.collectorName).filter(Boolean)).size
    const uniqueBanks = new Set(allItems.map((c) => normalizeBank(c.bank))).size
    const totalValue = orderTotal(allItems)
    const avgCheckAmount = allItems.length > 0 ? totalValue / allItems.length : 0
    const arNotCollected = allItems.filter((c) => c.ar_collected === false).length
    const arUnrecorded = allItems.filter((c) => c.ar_collected === null || c.ar_collected === undefined).length

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
      arUnrecorded,
    }
  }, [groups, now])

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
          byReservation.set(g.reservationId, { reservationId: g.reservationId, collectorName: g.collectorName, items: [] })
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
    // Give React a tick to unmount the dialog before restoring focus.
    requestAnimationFrame(() => {
      lastFocusedElRef.current?.focus?.()
    })
  }, [])

  async function runDecision(decisionsByCheckId) {
    if (!confirmAction || actioning) return
    if (!authorized) {
      setActionError("You don't have permission to decide on checks.")
      return
    }
    setActioning(true)
    setActionError('')

    try {
      const targets = confirmAction.bulk ? confirmAction.groups : [{ reservationId: confirmAction.group.reservationId, items: confirmAction.checks }]

      let approvedTotal = 0
      let returnedTotal = 0
      const results = []

      for (const t of targets) {
        // Only 'approve' and 'return' are ever produced here — the Reject
        // button/decision was removed from this UI (see file header note).
        const p_decisions = t.items.map((c) => {
          const d = decisionsByCheckId[c.checkId]
          if (d.decision === 'approve') {
            approvedTotal += 1
            return { check_id: c.checkId, decision: 'approve' } // no remarks — nothing to explain on approval
          }
          returnedTotal += 1
          return { check_id: c.checkId, decision: 'return', remarks: d.remarks.trim() }
        })
        // The RPC is SECURITY DEFINER and re-checks the caller's role /
        // auth.uid() server-side — the client-side `authorized` check above
        // is purely UX, never the actual access boundary.
        // eslint-disable-next-line no-await-in-loop
        const res = await supabase.rpc('approver_decide', {
          p_reservation_id: t.reservationId,
          p_decisions,
        })
        results.push(res)
      }

      if (!isMountedRef.current) return

      const failed = results.filter((r) => r.error).length
      if (failed > 0 && failed === results.length) {
        setActionError(results.find((r) => r.error)?.error?.message || 'Something went wrong. Please try again.')
        return
      }

      const parts = []
      if (approvedTotal > 0) parts.push(`${approvedTotal} approved`)
      if (returnedTotal > 0) parts.push(`${returnedTotal} returned for correction`)
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
        failed > 0 ? 'warning' : 'success'
      )
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      if (isMountedRef.current) setActioning(false)
    }
  }

  function exportCsv() {
    const headers = ['Collector', 'Bank', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'Receipt', 'AR collected', '2307 Attached', 'Remarks', 'Submitted by', 'Submitted at']
    const rows = [headers]
    visibleGroups.forEach((g) => {
      g.items.forEach((c) => {
        rows.push([
          g.collectorName || '',
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
    arFilter !== 'all' ||
    amountMin !== '' ||
    amountMax !== ''

  if (profileLoading) {
    return <div className="flex min-h-[40vh] items-center justify-center text-sm text-ink-300">Loading…</div>
  }

  if (profileError) {
    return <ProfileLoadError error={profileError} />
  }

  if (!authorized) {
    return <AccessDenied />
  }

  return (
    <div className="pb-20 sm:pb-0">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-ledger-stamp/40 bg-ledger-stamp/10 text-ledger-stampDark">
            <Stamp className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ledger-stampDark/80">
              Verification queue
            </p>
            <h1 className="font-display text-2xl font-semibold text-ink-900">Pending approvals</h1>
            <p className="mt-1 text-sm text-ink-400">
              {name ? `Signed in as ${name}. ` : ''}Physically verify each check against what was
              submitted, then approve for release, or return it to the admin to fix a mistake.
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

      {!loading && (
        <>
          {/* Primary overview row */}
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

          {/* Timing & risk row — the two wait-time cards double as quick
              filters, same interaction pattern as before (click to toggle,
              click again to clear). */}
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
                  <p className="font-mono text-[10px] uppercase tracking-wide text-ink-400">
                    Waiting {PENDING_WARN_MINUTES}m+
                  </p>
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
            <LedgerStatCard
              icon={ShieldAlert}
              label="AR not collected"
              value={summary.arNotCollected}
              accent={summary.arNotCollected > 0 ? 'warning' : undefined}
            />
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
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600"
                aria-label="Clear search"
              >
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
                      onClick={() => {
                        setSortBy(o.value)
                        setSortMenuOpen(false)
                      }}
                      className={cn(
                        'flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-ink-50',
                        sortBy === o.value ? 'text-teal-700' : 'text-ink-600'
                      )}
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
              <span className="rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {activeFilterCount}
              </span>
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
          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">Collector</label>
            <select
              value={collectorFilter}
              onChange={(e) => setCollectorFilter(e.target.value)}
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="all">All collectors</option>
              {collectorOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">Bank</label>
            <select
              value={bankFilter}
              onChange={(e) => setBankFilter(e.target.value)}
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="all">All banks</option>
              {bankOptions.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">Submitted by</label>
            <select
              value={submitterFilter}
              onChange={(e) => setSubmitterFilter(e.target.value)}
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="all">Anyone</option>
              {submitterOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">AR collected</label>
            <select
              value={arFilter}
              onChange={(e) => setArFilter(e.target.value)}
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              {AR_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">Waiting time</label>
            <select
              value={urgencyFilter}
              onChange={(e) => setUrgencyFilter(e.target.value)}
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              {URGENCY_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

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
                if (amountMin !== '' && amountMax !== '' && Number(amountMin) > Number(amountMax)) {
                  setAmountMax(amountMin)
                }
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
                if (amountMin !== '' && amountMax !== '' && Number(amountMax) < Number(amountMin)) {
                  setAmountMin(amountMax)
                }
              }}
              placeholder="No limit"
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>

          <div className="flex items-end sm:col-span-2 lg:col-span-2 lg:justify-end">
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
          <button
            onClick={() => load(loading)}
            className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <ListSkeleton />
      ) : visibleGroups.length === 0 ? (
        <EmptyState hasFilter={hasActiveFilter} />
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
              <button
                onClick={() => setSelectedCheckIds(new Set())}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50"
              >
                Clear
              </button>
              <button
                onClick={openReviewForSelected}
                className="flex items-center gap-1.5 rounded-md bg-teal-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Review selected
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <ReviewModal
          action={confirmAction}
          onCancel={closeConfirm}
          onConfirm={runDecision}
          loading={actioning}
          error={actionError}
          successFlash={successFlash}
        />
      )}

      {toast && <Toast message={toast.message} variant={toast.variant} />}
    </div>
  )
}

function LedgerStatCard({ icon: Icon, label, value, accent }) {
  return (
    <Card
      className={cn(
        'relative overflow-hidden border-ink-100 p-4',
        accent === 'warning' && 'border-orange-200 bg-orange-50/60'
      )}
    >
      <div
        className="pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed border-ledger-stamp/30"
        aria-hidden="true"
      />
      <div className="relative flex items-center gap-2">
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ledger-stamp/10 text-ledger-stampDark',
            accent === 'warning' && 'bg-orange-100 text-orange-600'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-400">{label}</p>
      </div>
      <p
        className={cn(
          'relative mt-1.5 font-display text-2xl font-semibold',
          accent === 'warning' ? 'text-orange-600' : 'text-ink-900'
        )}
      >
        {value}
      </p>
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
        Approving checks for release requires the approver or admin role. If this seems wrong,
        ask an admin to check your account's role.
      </p>
    </div>
  )
}

function Toast({ message, variant }) {
  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 sm:bottom-6">
      <div
        className={cn(
          'flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium text-white shadow-lg',
          variant === 'warning' ? 'bg-orange-600' : 'bg-ink-900'
        )}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        {message}
      </div>
    </div>
  )
}

function ApprovalGroupRow({
  group,
  waitingLabel,
  urgencyLevel,
  expanded,
  onToggleExpand,
  selectedCheckIds,
  onToggleSelectCheck,
  onToggleSelectAll,
  onReview,
}) {
  const items = group.items
  const total = orderTotal(items)
  const allSelected = items.every((c) => selectedCheckIds.has(c.checkId))
  const someSelected = items.some((c) => selectedCheckIds.has(c.checkId))

  // The banks represented in this order, deduped, used for the small badge
  // row in the group header so an approver can tell at a glance whether an
  // order spans multiple banks without having to expand it first.
  const distinctBanks = useMemo(() => {
    const set = new Set(items.map((c) => normalizeBank(c.bank)))
    return [...set]
  }, [items])

  const borderClass =
    urgencyLevel === 'critical'
      ? 'border-red-300'
      : urgencyLevel === 'warning'
      ? 'border-orange-300'
      : 'border-ink-100'

  return (
    <Card className={cn('overflow-hidden p-0', borderClass)}>
      <div className="flex items-start gap-2.5 border-b border-dashed border-ink-100 bg-ink-50/40 px-3 py-3 sm:items-center sm:px-4">
        <button
          onClick={onToggleSelectAll}
          className="mt-0.5 shrink-0 text-ink-300 hover:text-teal-600 sm:mt-0"
          aria-label={allSelected ? 'Deselect all checks in this order' : 'Select all checks in this order'}
        >
          {allSelected ? (
            <CheckSquare className="h-4.5 w-4.5 text-teal-600" />
          ) : someSelected ? (
            <MinusSquare className="h-4.5 w-4.5 text-teal-600" />
          ) : (
            <Square className="h-4.5 w-4.5" />
          )}
        </button>

        <button
          onClick={onToggleExpand}
          className="flex min-w-0 flex-1 flex-col gap-1.5 text-left sm:flex-row sm:items-center sm:gap-3"
        >
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
            {distinctBanks.length <= 2 ? (
              distinctBanks.map((b) => <BankBadge key={b} bank={b} />)
            ) : (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500"
                title={distinctBanks.join(', ')}
              >
                <Landmark className="h-3 w-3 shrink-0" />
                {distinctBanks.length} banks
              </span>
            )}
            <span className="font-mono font-semibold text-ink-800">{formatCurrency(total)}</span>
            <span
              className={cn(
                'flex items-center gap-1 font-mono font-medium',
                urgencyLevel === 'critical'
                  ? 'text-red-600'
                  : urgencyLevel === 'warning'
                  ? 'text-orange-600'
                  : 'text-ink-500'
              )}
            >
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
                      <button
                        onClick={() => onToggleSelectCheck(c.checkId)}
                        className={selectedCheckIds.has(c.checkId) ? 'text-teal-600' : 'text-ink-300 hover:text-ink-500'}
                        aria-label={selectedCheckIds.has(c.checkId) ? 'Deselect check' : 'Select check'}
                      >
                        {selectedCheckIds.has(c.checkId) ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                      </button>
                    </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-700">
  <span className="flex items-start gap-1">
    <Hash className="mt-0.5 h-3 w-3 shrink-0 text-ink-300" />
    <span className="break-all">{c.check_no ?? '—'}</span>
  </span>
</td>
                    <td className="px-2 py-2.5">
                      <BankBadge bank={c.bank} />
                    </td>
                    <td className="max-w-[140px] truncate px-2 py-2.5 font-medium text-ink-900" title={c.payee || undefined}>
                      {c.payee || '—'}
                    </td>
                    <td className="max-w-[140px] truncate px-2 py-2.5 text-ink-600" title={c.payor || undefined}>
                      {c.payor || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono font-medium text-ink-700">{safeCurrency(c.amount)}</td>
                    <td className="px-2 py-2.5 font-mono text-xs text-ink-700" title={c.or_no || undefined}>
                      {c.or_no || '—'}
                    </td>
                    <td className="px-2 py-2.5">
                      {c.ar_collected === null || c.ar_collected === undefined ? (
                        '—'
                      ) : c.ar_collected ? (
                        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
                      ) : (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      {c.attached_2307 === null || c.attached_2307 === undefined ? (
                        '—'
                      ) : c.attached_2307 ? (
                        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
                      ) : (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
                      )}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-2.5 text-xs text-ink-500" title={c.remarks || undefined}>
                      {c.remarks || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-dashed border-ink-100 bg-ink-50/40 px-4 py-3">
            <button
              onClick={onReview}
              className="flex items-center gap-1.5 rounded-md bg-teal-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Review this order
            </button>
          </div>
        </>
      )}
    </Card>
  )
}

// Every check starts as "approve" by default — for a queue that's usually
// full of correctly-submitted checks, this keeps the approver's job to
// "click through the good ones, stop and act on the bad ones" rather than
// re-confirming every single row. Remarks only ever matter for a return;
// an approval never carries or requires an explanation.
function buildInitialDecisions(checks) {
  const initial = {}
  checks.forEach((c) => {
    initial[c.checkId] = { decision: 'approve', remarks: '' }
  })
  return initial
}

// Selector for anything a keyboard user could legitimately tab to inside
// the dialog — used to build/maintain the focus trap below.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function ReviewModal({ action, onCancel, onConfirm, loading, error, successFlash }) {
  const allChecks = action.bulk ? action.groups.flatMap((g) => g.items) : action.checks
  const total = orderTotal(allChecks)
  const dialogRef = useRef(null)
  const cancelButtonRef = useRef(null)
  const remarksRefs = useRef({})

  const [decisions, setDecisions] = useState(() => buildInitialDecisions(allChecks))
  // Only start nagging about a missing reason after the approver has
  // actually tried to confirm once — flagging every return row red the
  // instant it's picked is noisy, not helpful.
  const [showValidation, setShowValidation] = useState(false)

  const updateDecision = useCallback((checkId, decision) => {
    setDecisions((prev) => ({
      ...prev,
      // Switching to "approve" always clears remarks — nothing to explain
      // on an approval, so there's nothing left to carry over.
      [checkId]: { decision, remarks: decision === 'approve' ? '' : prev[checkId]?.remarks || '' },
    }))
  }, [])

  const updateRemarks = useCallback((checkId, value) => {
    setDecisions((prev) => ({ ...prev, [checkId]: { ...prev[checkId], remarks: value.slice(0, REMARKS_MAX_LEN) } }))
  }, [])

  const { approveCount, returnCount, allComplete, firstIncompleteId } = useMemo(() => {
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
        return // approvals never need a reason — nothing more to validate
      }
      ret += 1
      // Reasons must be real text, not just whitespace, and are only ever
      // required for a return.
      if (!d.remarks?.trim()) {
        complete = false
        if (!firstIncomplete) firstIncomplete = c.checkId
      }
    })
    return { approveCount: approve, returnCount: ret, allComplete: complete, firstIncompleteId: firstIncomplete }
  }, [decisions, allChecks])

  useEffect(() => {
    cancelButtonRef.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && !loading) {
        onCancel()
        return
      }
      // Basic focus trap: keep Tab / Shift+Tab cycling within the dialog
      // rather than escaping into the page behind it.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
          (el) => el.offsetParent !== null // skip hidden elements (e.g. inputs in collapsed rows)
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [loading, onCancel])

  function handleConfirmClick() {
    if (!allComplete) {
      setShowValidation(true)
      // Jump the approver straight to the first row that still needs a
      // reason instead of making them hunt through a long list.
      if (firstIncompleteId != null) {
        remarksRefs.current[firstIncompleteId]?.focus()
        remarksRefs.current[firstIncompleteId]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      return
    }
    onConfirm(decisions)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-3 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading && !successFlash) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-modal-title"
        className="relative flex max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl xl:max-w-7xl"
      >
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
            checks out for release — no explanation needed. <span className="font-medium text-ink-800">Return</span> anything with
            a fixable mistake back to the submitting admin for correction. A return requires a short reason.
          </p>

          <div className="mt-3 mb-3 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-teal-100 px-2.5 py-1 text-xs font-medium text-teal-700">{approveCount} to approve</span>
            {returnCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">{returnCount} to return</span>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-ink-100">
            <div className="max-h-[42vh] overflow-y-auto">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                <col className="w-[12%]" />  {/* check no. */}
<col className="w-[9%]" />  {/* bank */}
<col className="w-[13%]" />  {/* payee */}
<col className="w-[9%]" />  {/* payor */}
                  <col className="w-[9%]" />
                  <col className="w-[8%]" />
                  <col className="w-[5%]" />
                  <col className="w-[5%]" />
                  <col className="w-[15%]" />
                  <col className="w-[15%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-ink-50 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                  <tr className="text-left font-mono text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="px-4 py-2.5 font-medium">Check no.</th>
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
                      <tr
                        key={c.checkId ?? idx}
                        className={cn(
                          'align-top transition-colors',
                          d.decision === 'return' && 'bg-amber-50/50',
                          flagRow && 'bg-orange-50 ring-1 ring-inset ring-orange-300'
                        )}
                      >
                        <td className="truncate px-4 py-3 font-mono text-xs text-ink-700" title={c.check_no || undefined}>
                          <span className="flex items-center gap-1">
                            <Hash className="h-3 w-3 shrink-0 text-ink-300" />
                            <span className="truncate">{c.check_no ?? '—'}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <BankBadge bank={c.bank} />
                        </td>
                        <td className="truncate px-4 py-3 font-medium text-ink-900" title={c.payee || undefined}>
                          {c.payee ?? '—'}
                        </td>
                        <td className="truncate px-4 py-3 text-ink-600" title={c.payor || undefined}>
                          {c.payor ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-ink-700" title={c.amount != null ? String(c.amount) : undefined}>
                          {safeCurrency(c.amount)}
                        </td>
                        <td className="truncate px-4 py-3 font-mono text-xs text-ink-700" title={c.or_no || undefined}>
                          {c.or_no ?? '—'}
                        </td>
                        <td className="px-4 py-3">
                          {c.ar_collected === null || c.ar_collected === undefined ? '—' : c.ar_collected ? 'Yes' : 'No'}
                        </td>
                        <td className="px-4 py-3">
                          {c.attached_2307 === null || c.attached_2307 === undefined ? '—' : c.attached_2307 ? 'Yes' : 'No'}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex gap-1.5" role="group" aria-label={`Decision for check ${c.check_no || idx + 1}`}>
                            <button
                              type="button"
                              onClick={() => updateDecision(c.checkId, 'approve')}
                              title="Approve for release — no explanation needed"
                              aria-pressed={d.decision === 'approve'}
                              className={cn(
                                'flex items-center gap-1 rounded border px-2 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-teal-500',
                                d.decision === 'approve' ? 'border-teal-600 bg-teal-600 text-white' : 'border-ink-200 text-ink-500 hover:bg-ink-50'
                              )}
                            >
                              <Check className="h-3.5 w-3.5" />
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => updateDecision(c.checkId, 'return')}
                              title="Send back to admin for correction"
                              aria-pressed={d.decision === 'return'}
                              className={cn(
                                'flex items-center gap-1 rounded border px-2 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-amber-500',
                                d.decision === 'return' ? 'border-amber-600 bg-amber-600 text-white' : 'border-ink-200 text-ink-500 hover:bg-ink-50'
                              )}
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
                                ref={(el) => {
                                  if (el) remarksRefs.current[c.checkId] = el
                                  else delete remarksRefs.current[c.checkId]
                                }}
                                type="text"
                                value={d.remarks}
                                onChange={(e) => updateRemarks(c.checkId, e.target.value)}
                                onBlur={(e) => updateRemarks(c.checkId, e.target.value.trim())}
                                placeholder="What needs fixing?"
                                maxLength={REMARKS_MAX_LEN}
                                required
                                aria-required="true"
                                aria-invalid={missingReason}
                                className={cn(
                                  'w-full rounded border px-2.5 py-1.5 text-sm text-ink-800 focus:outline-none focus:ring-1 focus:ring-teal-500',
                                  flagRow ? 'border-orange-400' : 'border-ink-200'
                                )}
                              />
                              <div className="flex items-center justify-between">
                                {flagRow ? (
                                  <span className="flex items-center gap-1 text-[11px] text-orange-600">
                                    <AlertTriangle className="h-3 w-3 shrink-0" />
                                    Reason required
                                  </span>
                                ) : (
                                  <span />
                                )}
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

          {showValidation && !allComplete && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-orange-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Enter a reason for every returned check before confirming.
            </p>
          )}

          {returnCount > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Returned checks go back to the submitting admin's Active list — the collector's
              reservation is unaffected and nobody else can claim it while it's corrected.
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
          <button
            ref={cancelButtonRef}
            onClick={onCancel}
            disabled={loading}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmClick}
            disabled={loading}
            className="flex items-center gap-2 rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
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

function EmptyState({ hasFilter }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-ink-200 px-4 py-16 text-center">
      <ShieldCheck className="h-8 w-8 text-ink-200" />
      <p className="mt-3 font-display text-lg font-semibold text-ink-700">
        {hasFilter ? 'No matching checks' : 'Nothing awaiting approval'}
      </p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        {hasFilter
          ? 'Try a different search or filter combination, or clear your filters.'
          : 'Checks submitted by admins for pickup will show up here for verification.'}
      </p>
    </div>
  )
}