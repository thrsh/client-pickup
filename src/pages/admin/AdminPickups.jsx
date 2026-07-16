// AdminPickups.jsx
//
// FLOW CHANGE: admins no longer confirm a pickup directly. Instead, an
// admin enters the per-check pickup data (OR no., whether AR was
// collected, remarks) and SUBMITS IT FOR APPROVAL. An approver
// (see ApproverHome.jsx) then physically verifies each check and makes
// one of three decisions:
//   - Approve   -> check is finally marked picked_up.
//   - Reject    -> check is released straight back into the general
//                  available pool for any collector to reserve.
//   - Return    -> check goes back to THIS reservation's Active tab as
//                  'reserved' so the admin can fix a mistake (e.g. a
//                  mistyped OR number) and resubmit — it is NOT released
//                  to the pool.
// Checks the admin marks as "not being picked up today" at submission
// time skip approval entirely and are released immediately, same as
// before — there's nothing for an approver to verify on a check nobody
// is claiming.
//
// Requires migration_approval_workflow.sql to have been run first. That
// migration must provide, at minimum:
//   - checks.status extended with 'pending_approval'
//   - checks.or_no / ar_collected / remarks / submitted_by / submitted_by_name / submitted_at
//   - pickup_reservations.status extended with 'pending_approval'
//   - admin_submit_for_approval(p_reservation_id uuid, p_check_outcomes jsonb)
//   - admin_recall_submission(p_reservation_id uuid, p_check_ids uuid[])
//   - approver_decide(p_reservation_id uuid, p_decisions jsonb) where each
//     decision is { check_id, decision: 'approve' | 'reject' | 'return', remarks }
//   - check_activity_log.action extended with 'rejected' | 'returned'
// Deploying this component without that migration will break both this
// file and ApproverHome.jsx.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  RefreshCw,
  Search,
  X,
  Check,
  Undo2,
  RotateCcw,
  Send,
  Loader2,
  AlertTriangle,
  User,
  Hash,
  CalendarDays,
  Layers,
  ChevronDown,
  ChevronUp,
  CheckSquare,
  Square,
  MinusSquare,
  Download,
  Pause,
  Play,
  ArrowUpDown,
  Filter,
  CheckCircle2,
  ShieldCheck,
  XCircle,
  Hourglass,
  Wallet,
  Timer,
  Flame,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'

const POLL_INTERVAL_MS = 20000
const EXPIRING_SOON_MINUTES = 15
const CRITICAL_MINUTES = 5
// How long the success checkmark stays on screen before the modal closes.
const SUCCESS_FLASH_MS = 900
// Thresholds for flagging a submission that's been sitting in the approval
// queue too long. Keep these in sync with the matching constants in
// ApproverHome.jsx so the two pages agree on what "stale" means.
const PENDING_WARN_MINUTES = 60
const PENDING_CRITICAL_MINUTES = 240

const SORT_OPTIONS = [
  { value: 'expires_asc', label: 'Expiring soonest', tabs: ['active'] },
  { value: 'submitted_asc', label: 'Oldest submitted', tabs: ['pending_approval'] },
  { value: 'submitted_desc', label: 'Newest submitted', tabs: ['pending_approval'] },
  { value: 'reserved_desc', label: 'Newest reserved', tabs: ['active', 'history'] },
  { value: 'reserved_asc', label: 'Oldest reserved', tabs: ['active', 'history'] },
  { value: 'amount_desc', label: 'Highest amount', tabs: ['active', 'pending_approval', 'history'] },
  { value: 'amount_asc', label: 'Lowest amount', tabs: ['active', 'pending_approval', 'history'] },
  { value: 'collector_asc', label: 'Collector A→Z', tabs: ['active', 'pending_approval', 'history'] },
]

// ----------------------------------------------------------------------------
// Line-item normalization
//
// - 'active' reads checks live off the reservation — nothing's been decided
//   or submitted yet, so the live table is the whole truth.
// - 'pending_approval' also reads checks live off the reservation, but the
//   embedded checks additionally carry the OR no. / AR collected / remarks
//   / submitted_at data the admin entered at submission time.
// - 'history' reads from check_activity_log instead, because a
//   released/rejected check goes back to 'available' and can be re-reserved
//   by someone else — at which point its live row no longer points back to
//   this reservation. The activity log is what still does.
// ----------------------------------------------------------------------------
function lineItems(reservation, tab) {
  if (tab === 'history') {
    const activity = Array.isArray(reservation.activity) ? reservation.activity : []
    return activity
      .map((a) => {
        const c = a.checks
        if (!c) return null
        return {
          id: a.id,
          checkId: c.id,
          row_number: c.row_number,
          payee: c.payee,
          payor: c.payor,
          check_no: c.check_no,
          check_date: c.check_date,
          amount: c.amount,
          outcome: a.action, // 'picked_up' | 'released' | 'rejected' | 'returned' | 'expired'
          or_no: a.or_no,
          ar_collected: a.ar_collected,
          remarks: a.remarks,
        }
      })
      .filter(Boolean)
  }

  const checks = Array.isArray(reservation.checks) ? reservation.checks : []
  return checks.map((c) => ({
    id: c.id,
    checkId: c.id,
    row_number: c.row_number,
    payee: c.payee,
    payor: c.payor,
    check_no: c.check_no,
    check_date: c.check_date,
    amount: c.amount,
    outcome: null,
    or_no: tab === 'pending_approval' ? c.or_no ?? null : null,
    ar_collected: tab === 'pending_approval' ? c.ar_collected ?? null : null,
    remarks: tab === 'pending_approval' ? c.remarks ?? null : null,
    submittedAt: tab === 'pending_approval' ? c.submitted_at ?? null : null,
    submittedByName: tab === 'pending_approval' ? c.submitted_by_name ?? null : null,
  }))
}

function sortedLineItems(reservation, tab) {
  return [...lineItems(reservation, tab)].sort((a, b) => {
    const an = Number(a.row_number)
    const bn = Number(b.row_number)
    if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn
    return String(a.check_no ?? '').localeCompare(String(b.check_no ?? ''))
  })
}

function orderTotal(items) {
  return items.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
}

function matchesCheckSearch(items, term) {
  if (!term) return true
  const needle = term.toLowerCase()
  return items.some((c) =>
    [c.payee, c.payor, c.check_no, c.or_no]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle))
  )
}

function payeePreview(items) {
  if (items.length === 0) return null
  const names = items.map((c) => c.payee).filter(Boolean)
  if (names.length === 0) return null
  if (names.length === 1) return names[0]
  return `${names[0]} +${names.length - 1} more`
}

// Earliest submitted_at across a pending-approval order's checks — that's
// the moment the clock starts ticking on "how long has this been waiting."
function earliestSubmittedAt(items) {
  const times = items.map((c) => c.submittedAt).filter(Boolean).map((t) => new Date(t).getTime())
  if (times.length === 0) return null
  return Math.min(...times)
}

export default function AdminPickups() {
  const [tab, setTab] = useState('active') // 'active' | 'pending_approval' | 'history'
  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [collectorFilter, setCollectorFilter] = useState('')
  const [checkSearch, setCheckSearch] = useState('')
  const [quickFilter, setQuickFilter] = useState('all') // 'all' | 'expiring' | 'stale'
  const [sortBy, setSortBy] = useState('expires_asc')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [lastUpdated, setLastUpdated] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  // confirmAction.type: 'submit' | 'release' | 'bulk-release' | 'recall' | 'bulk-recall'
  const [confirmAction, setConfirmAction] = useState(null)
  const [actioning, setActioning] = useState(false)
  const [actionError, setActionError] = useState('')
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [toast, setToast] = useState(null)
  // Brief "success" state shown inside the modal right after an action
  // completes, before the modal itself closes. Null when not showing.
  const [successFlash, setSuccessFlash] = useState(null)

  const debounceRef = useRef(null)
  const toastTimerRef = useRef(null)
  const searchInputRef = useRef(null)
  const isMountedRef = useRef(true)
  const successTimerRef = useRef(null)
  // Guards against overlapping fetches (e.g. a poll firing while a manual
  // refresh is still in flight) and against a stale response landing after
  // a newer request has already resolved.
  const requestIdRef = useRef(0)
  const inFlightRef = useRef(false)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      clearTimeout(successTimerRef.current)
    }
  }, [])

  useEffect(() => {
    load(true)
    setSelectedIds(new Set())
    setQuickFilter('all')
    setSortBy(
      tab === 'active' ? 'expires_asc' : tab === 'pending_approval' ? 'submitted_asc' : 'reserved_desc'
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Debounced re-fetch when the collector filter changes
  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load(false), 250)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectorFilter])

  // Keep countdowns/wait-timers live and periodically pull fresh data
  // (also catches reservations that expired naturally, or got decided by
  // an approver, without anyone touching this page).
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => {
      if ((tab === 'active' || tab === 'pending_approval') && autoRefresh) load(false)
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, autoRefresh])

  // "/" focuses the search box, Escape clears it — quick keyboard access
  // for admins triaging a long list.
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

  const load = useCallback(
    async (showFullLoading) => {
      // Don't let a background poll pile up behind a slow request; the
      // next scheduled tick will just try again.
      if (inFlightRef.current && !showFullLoading) return

      const requestId = ++requestIdRef.current
      inFlightRef.current = true

      if (showFullLoading) setLoading(true)
      else setRefreshing(true)
      setLoadError('')

      try {
        if (tab === 'active') {
          // Release anything that expired since we last looked, so the
          // active list never shows stale holds. Non-fatal if it fails —
          // the list below still reflects whatever is currently 'reserved'.
          const { error: reclaimError } = await supabase.rpc('reclaim_expired_reservations')
          if (reclaimError) {
            console.error('reclaim_expired_reservations failed:', reclaimError)
          }
        }

        const statusFilter =
          tab === 'active'
            ? ['reserved']
            : tab === 'pending_approval'
            ? ['pending_approval']
            : ['picked_up', 'partial', 'expired', 'cancelled']

        // Active and Pending Approval both embed checks directly (nothing's
        // been logged to history yet). Pending Approval additionally pulls
        // the OR no. / AR collected / remarks / submitted_at the admin
        // entered when submitting. History fetches the audit log
        // separately below — see the comment on lineItems() above for why.
        const selectClause =
          tab === 'active'
            ? 'id, collector_name, status, reserved_at, expires_at, picked_up_at, checks(id, row_number, payee, payor, check_no, check_date, amount)'
            : tab === 'pending_approval'
            ? 'id, collector_name, status, reserved_at, expires_at, checks(id, row_number, payee, payor, check_no, check_date, amount, or_no, ar_collected, remarks, submitted_at, submitted_by_name)'
            : 'id, collector_name, status, reserved_at, expires_at, picked_up_at'

        let req = supabase
          .from('pickup_reservations')
          .select(selectClause)
          .in('status', statusFilter)
          .order('reserved_at', { ascending: false })
          .limit(150)

        const trimmedFilter = collectorFilter.trim()
        if (trimmedFilter) {
          req = req.ilike('collector_name', `%${trimmedFilter}%`)
        }

        const { data, error } = await req

        // If a newer request has since started, or we've unmounted, drop
        // this result on the floor.
        if (!isMountedRef.current || requestId !== requestIdRef.current) return

        if (error) {
          setLoadError(error.message || 'Failed to load reservations. Please try again.')
          return
        }

        let rows = Array.isArray(data) ? data : []

        if (tab === 'history' && rows.length > 0) {
          const ids = rows.map((r) => r.id)
          const { data: activity, error: activityError } = await supabase
            .from('check_activity_log')
            .select(
              'id, reservation_id, action, or_no, ar_collected, remarks, performed_at, checks(id, row_number, payee, payor, check_no, check_date, amount)'
            )
            .in('reservation_id', ids)
            .order('performed_at', { ascending: true })

          if (!isMountedRef.current || requestId !== requestIdRef.current) return

          if (activityError) {
            // Non-fatal: reservations still render, just without their
            // check breakdown until the next successful refresh.
            console.error('check_activity_log fetch failed:', activityError)
          } else {
            const byReservation = new Map()
            ;(activity || []).forEach((a) => {
              if (!byReservation.has(a.reservation_id)) byReservation.set(a.reservation_id, [])
              byReservation.get(a.reservation_id).push(a)
            })
            rows = rows.map((r) => ({ ...r, activity: byReservation.get(r.id) || [] }))
          }
        }

        setReservations(rows)
        setLastUpdated(Date.now())
        // Drop selections that no longer exist in the fresh data (e.g.
        // something else picked them up, or an approver decided them,
        // between polls).
        setSelectedIds((prev) => {
          if (prev.size === 0) return prev
          const validIds = new Set(rows.map((r) => r.id))
          const next = new Set([...prev].filter((id) => validIds.has(id)))
          return next.size === prev.size ? prev : next
        })
      } catch (err) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) return
        setLoadError(err?.message || 'Failed to load reservations. Please try again.')
      } finally {
        if (isMountedRef.current && requestId === requestIdRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
        inFlightRef.current = false
      }
    },
    [tab, collectorFilter]
  )

  function minutesLeft(expiresAt) {
    if (!expiresAt) return 0
    return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 60000))
  }

  function secondsLeft(expiresAt) {
    if (!expiresAt) return 0
    return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000))
  }

  function formatCountdown(expiresAt) {
    if (!expiresAt) return '—'
    const ms = new Date(expiresAt).getTime() - now
    if (ms <= 0) return 'Expiring…'
    const mins = Math.floor(ms / 60000)
    const secs = Math.floor((ms % 60000) / 1000)
    return `${mins}m ${secs.toString().padStart(2, '0')}s left`
  }

  function urgency(expiresAt) {
    const secs = secondsLeft(expiresAt)
    if (secs <= CRITICAL_MINUTES * 60) return 'critical'
    if (secs <= EXPIRING_SOON_MINUTES * 60) return 'warning'
    return 'normal'
  }

  function minutesWaiting(submittedAtMs) {
    if (!submittedAtMs) return 0
    return Math.max(0, Math.round((now - submittedAtMs) / 60000))
  }

  function formatWaiting(submittedAtMs) {
    if (!submittedAtMs) return '—'
    const mins = minutesWaiting(submittedAtMs)
    if (mins < 60) return `Waiting ${mins}m`
    const hrs = Math.floor(mins / 60)
    const rem = mins % 60
    return `Waiting ${hrs}h ${rem}m`
  }

  function pendingUrgency(submittedAtMs) {
    const mins = minutesWaiting(submittedAtMs)
    if (mins >= PENDING_CRITICAL_MINUTES) return 'critical'
    if (mins >= PENDING_WARN_MINUTES) return 'warning'
    return 'normal'
  }

  // Combines the (already server-filtered-by-collector) list with the
  // client-side check search, the quick filter (expiring / stale
  // depending on tab), and sort.
  const visibleReservations = useMemo(() => {
    const term = checkSearch.trim()
    let list = reservations.filter((r) => matchesCheckSearch(sortedLineItems(r, tab), term))

    if (tab === 'active' && quickFilter === 'expiring') {
      list = list.filter((r) => minutesLeft(r.expires_at) <= EXPIRING_SOON_MINUTES)
    }
    if (tab === 'pending_approval' && quickFilter === 'stale') {
      list = list.filter((r) => {
        const submittedAtMs = earliestSubmittedAt(sortedLineItems(r, 'pending_approval'))
        return submittedAtMs && minutesWaiting(submittedAtMs) >= PENDING_WARN_MINUTES
      })
    }

    const withMeta = list.map((r) => ({
      r,
      total: orderTotal(sortedLineItems(r, tab)),
      submittedAtMs: tab === 'pending_approval' ? earliestSubmittedAt(sortedLineItems(r, tab)) : null,
    }))

    withMeta.sort((a, b) => {
      switch (sortBy) {
        case 'expires_asc':
          return new Date(a.r.expires_at || 0) - new Date(b.r.expires_at || 0)
        case 'submitted_asc':
          return (a.submittedAtMs || 0) - (b.submittedAtMs || 0)
        case 'submitted_desc':
          return (b.submittedAtMs || 0) - (a.submittedAtMs || 0)
        case 'reserved_asc':
          return new Date(a.r.reserved_at || 0) - new Date(b.r.reserved_at || 0)
        case 'amount_desc':
          return b.total - a.total
        case 'amount_asc':
          return a.total - b.total
        case 'collector_asc':
          return String(a.r.collector_name || '').localeCompare(String(b.r.collector_name || ''))
        case 'reserved_desc':
        default:
          return new Date(b.r.reserved_at || 0) - new Date(a.r.reserved_at || 0)
      }
    })

    return withMeta.map((x) => x.r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, checkSearch, quickFilter, sortBy, tab, now])

 const activeSummary = useMemo(() => {
    if (tab !== 'active') return null
    const minutesLeftAll = reservations.map((r) => minutesLeft(r.expires_at))
    const expiringSoon = minutesLeftAll.filter((m) => m <= EXPIRING_SOON_MINUTES).length
    const critical = minutesLeftAll.filter((m) => m <= CRITICAL_MINUTES).length
    const totalChecks = reservations.reduce(
      (sum, r) => sum + (Array.isArray(r.checks) ? r.checks.length : 0),
      0
    )
    const totalValue = reservations.reduce((sum, r) => sum + orderTotal(lineItems(r, 'active')), 0)
    const avgChecksPerOrder = reservations.length ? (totalChecks / reservations.length).toFixed(1) : '0'
    return { total: reservations.length, expiringSoon, critical, totalChecks, totalValue, avgChecksPerOrder }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, tab, now])

  const pendingSummary = useMemo(() => {
    if (tab !== 'pending_approval') return null
    let totalChecks = 0
    let stale = 0
    let critical = 0
    let totalValue = 0
    let earliestMs = null
    reservations.forEach((r) => {
      const items = sortedLineItems(r, 'pending_approval')
      totalChecks += items.length
      totalValue += orderTotal(items)
      const submittedAtMs = earliestSubmittedAt(items)
      if (submittedAtMs) {
        const waited = minutesWaiting(submittedAtMs)
        if (waited >= PENDING_WARN_MINUTES) stale += 1
        if (waited >= PENDING_CRITICAL_MINUTES) critical += 1
        if (earliestMs === null || submittedAtMs < earliestMs) earliestMs = submittedAtMs
      }
    })
    return {
      total: reservations.length,
      totalChecks,
      totalValue,
      stale,
      critical,
      oldestWaitingLabel: earliestMs ? formatWaiting(earliestMs) : null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, tab, now])
  function toggleExpand(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      const visibleIds = visibleReservations.map((r) => r.id)
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id))
      if (allSelected) {
        const next = new Set(prev)
        visibleIds.forEach((id) => next.delete(id))
        return next
      }
      return new Set([...prev, ...visibleIds])
    })
  }

  const selectedReservations = useMemo(
    () => reservations.filter((r) => selectedIds.has(r.id)),
    [reservations, selectedIds]
  )

  function openConfirm(type, reservation) {
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ type, reservation })
  }

  function openBulkReleaseConfirm() {
    if (selectedReservations.length === 0) return
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ type: 'bulk-release', reservations: selectedReservations })
  }

  function openBulkRecallConfirm() {
    if (selectedReservations.length === 0) return
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ type: 'bulk-recall', reservations: selectedReservations })
  }

  // Stable close handler for the modal. This used to be an inline arrow
  // function passed at the JSX call site (`onCancel={() => setConfirmAction(null)}`),
  // which gets a brand-new identity every time this component re-renders —
  // including every second, since the live countdown/wait-timer ticks `now`
  // here. ActionModal's keyboard-trap effect depended on `onCancel`, so
  // that constant identity churn was re-running its "focus something"
  // logic once a second, yanking focus back to the close button while an
  // admin was mid-keystroke elsewhere in the modal. Keeping this identity
  // stable fixes that.
  const closeConfirm = useCallback(() => {
    clearTimeout(successTimerRef.current)
    setSuccessFlash(null)
    setConfirmAction(null)
  }, [])

  // Recomputed only when the confirm target actually changes, instead of
  // on every render of this component (e.g. every countdown tick).
  const confirmChecks = useMemo(() => {
    if (!confirmAction?.reservation) return []
    const sourceTab = confirmAction.type === 'recall' ? 'pending_approval' : 'active'
    return sortedLineItems(confirmAction.reservation, sourceTab)
  }, [confirmAction])
  const confirmTotal = useMemo(() => orderTotal(confirmChecks), [confirmChecks])

  // Validates that every check in the order has an explicit outcome: either
  // "picking up" with a non-empty, unique OR number and a collected answer
  // (plus a reason if AR wasn't collected), or "not picking up" with a
  // reason. Used both to gate the submit button in the UI and as a server-
  // call guard so a race between state updates can never slip an incomplete
  // payload through.
  function findIncompleteEntry(checks, orData) {
    const seenOrNos = new Map() // normalized OR no. -> check id, to catch duplicates
    for (const c of checks) {
      const entry = orData?.[c.checkId]
      if (!entry) return { reason: 'incomplete', checkId: c.checkId }

      if (entry.include) {
        const orNo = entry.orNo?.trim() ?? ''
        if (!orNo || entry.collected === null || entry.collected === undefined) {
          return { reason: 'incomplete', checkId: c.checkId }
        }
        if (entry.collected === false && !entry.remarks?.trim()) {
          return { reason: 'missing-reason', checkId: c.checkId }
        }
        const normalized = orNo.toLowerCase()
        if (seenOrNos.has(normalized)) {
          return { reason: 'duplicate', checkId: c.checkId }
        }
        seenOrNos.set(normalized, c.checkId)
      } else if (!entry.remarks?.trim()) {
        return { reason: 'missing-reason', checkId: c.checkId }
      }
    }
    return null
  }

  async function runAction(orData) {
    if (!confirmAction || actioning) return
    setActioning(true)
    setActionError('')

    try {
      if (confirmAction.type === 'bulk-release' || confirmAction.type === 'bulk-recall') {
        const isRecall = confirmAction.type === 'bulk-recall'
        const results = await Promise.allSettled(
          confirmAction.reservations.map((r) =>
            isRecall
              ? supabase.rpc('admin_recall_submission', {
                  p_reservation_id: r.id,
                  p_check_ids: sortedLineItems(r, 'pending_approval').map((c) => c.checkId),
                })
              : supabase.rpc('admin_release_reservation', { p_reservation_id: r.id })
          )
        )
        const failed = results.filter(
          (res) => res.status === 'rejected' || res.value?.error
        ).length
        const succeeded = results.length - failed

        if (!isMountedRef.current) return

        if (failed > 0 && succeeded === 0) {
          setActionError(
            `Could not ${isRecall ? 'recall' : 'release'} the selected reservations. Please try again.`
          )
          return
        }

        setConfirmAction(null)
        setSelectedIds(new Set())
        load(false)
        showToast(
          failed > 0
            ? `${isRecall ? 'Recalled' : 'Released'} ${succeeded} of ${results.length}. ${failed} failed — try again.`
            : `${isRecall ? 'Recalled' : 'Released'} ${succeeded} reservation${succeeded === 1 ? '' : 's'}.`,
          failed > 0 ? 'warning' : 'success'
        )
        return
      }

      const isSubmit = confirmAction.type === 'submit'
      const isRecall = confirmAction.type === 'recall'
      const fn = isSubmit
        ? 'admin_submit_for_approval'
        : isRecall
        ? 'admin_recall_submission'
        : 'admin_release_reservation'
      const rpcParams = { p_reservation_id: confirmAction.reservation.id }

      let pickedCount = 0
      let releasedCount = 0

      if (isSubmit) {
        // Defense in depth: the modal already disables the submit button
        // until every row has a complete outcome, but never trust the
        // client alone before writing to the database.
        const problem = findIncompleteEntry(confirmChecks, orData)
        if (problem) {
          setActionError(
            problem.reason === 'duplicate'
              ? 'Each check being picked up needs its own OR number — duplicates were found.'
              : problem.reason === 'missing-reason'
              ? 'Enter a reason for every check marked "AR not collected" or left off the pickup.'
              : 'Enter an OR number and collection status for every check being picked up.'
          )
          return
        }

        // Pass a plain array/object here — supabase-js already serializes
        // this to JSON for the `jsonb` RPC param. Do NOT JSON.stringify()
        // it yourself, or Postgres receives a jsonb *string* instead of a
        // jsonb *array*, and jsonb_array_elements() blows up with
        // "cannot extract elements from a scalar".
        rpcParams.p_check_outcomes = confirmChecks.map((c) => {
          const entry = orData[c.checkId]
          if (entry.include) {
            pickedCount += 1
            return {
              check_id: c.checkId,
              picked_up: true,
              or_no: entry.orNo.trim(),
              ar_collected: entry.collected,
              remarks: entry.collected === false ? entry.remarks.trim() : null,
            }
          }
          releasedCount += 1
          return {
            check_id: c.checkId,
            picked_up: false,
            remarks: entry.remarks.trim(),
          }
        })
      } else if (isRecall) {
        rpcParams.p_check_ids = confirmChecks.map((c) => c.checkId)
      }

      const { error } = await supabase.rpc(fn, rpcParams)

      if (!isMountedRef.current) return

      if (error) {
        setActionError(error.message || 'Something went wrong. Please try again.')
        return
      }

      const collectorName = confirmAction.reservation.collector_name || 'Order'

      if (isSubmit) {
        const summary =
          releasedCount > 0
            ? `${pickedCount} of ${pickedCount + releasedCount} submitted for approval`
            : `${collectorName} submitted for approval`
        // Show a brief success checkmark inside the modal, then close it.
        // The toast still fires immediately so there's a persistent
        // confirmation even after the modal is gone.
        setSuccessFlash({ message: summary })
        clearTimeout(successTimerRef.current)
        successTimerRef.current = setTimeout(() => {
          if (!isMountedRef.current) return
          setSuccessFlash(null)
          setConfirmAction(null)
        }, SUCCESS_FLASH_MS)
      } else {
        setConfirmAction(null)
      }

      load(false)
      showToast(
        isSubmit
          ? releasedCount > 0
            ? `Sent ${pickedCount} of ${pickedCount + releasedCount} checks to approval for ${collectorName}; ${releasedCount} released.`
            : `Sent ${collectorName}'s pickup to approval.`
          : isRecall
          ? `Recalled ${collectorName}'s submission for edits.`
          : `Released ${collectorName}'s reservation.`
      )
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      if (isMountedRef.current) setActioning(false)
    }
  }

  function exportCsv() {
    const isHistory = tab === 'history'
    const isPending = tab === 'pending_approval'
    const headers = isHistory
      ? ['Collector', 'Status', 'Reserved at', 'Resolved at', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'Outcome', 'OR no.', 'AR collected', 'Remarks']
      : isPending
      ? ['Collector', 'Status', 'Reserved at', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'OR no.', 'AR collected', 'Remarks', 'Submitted by', 'Submitted at']
      : ['Collector', 'Status', 'Reserved at', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount']

    const rows = [headers]
    visibleReservations.forEach((r) => {
      const items = sortedLineItems(r, tab)
      if (items.length === 0) {
        rows.push(
          isHistory
            ? [r.collector_name || '', r.status || '', r.reserved_at || '', r.picked_up_at || '', '', '', '', '', '', '', '', '', '']
            : isPending
            ? [r.collector_name || '', r.status || '', r.reserved_at || '', '', '', '', '', '', '', '', '', '', '']
            : [r.collector_name || '', r.status || '', r.reserved_at || '', '', '', '', '', '']
        )
        return
      }
      items.forEach((c) => {
        rows.push(
          isHistory
            ? [
                r.collector_name || '',
                r.status || '',
                r.reserved_at || '',
                r.picked_up_at || '',
                c.check_no || '',
                c.payee || '',
                c.payor || '',
                c.check_date || '',
                c.amount ?? '',
                c.outcome || '',
                c.or_no || '',
                c.ar_collected === null || c.ar_collected === undefined ? '' : c.ar_collected ? 'Yes' : 'No',
                c.remarks || '',
              ]
            : isPending
            ? [
                r.collector_name || '',
                r.status || '',
                r.reserved_at || '',
                c.check_no || '',
                c.payee || '',
                c.payor || '',
                c.check_date || '',
                c.amount ?? '',
                c.or_no || '',
                c.ar_collected === null || c.ar_collected === undefined ? '' : c.ar_collected ? 'Yes' : 'No',
                c.remarks || '',
                c.submittedByName || '',
                c.submittedAt || '',
              ]
            : [
                r.collector_name || '',
                r.status || '',
                r.reserved_at || '',
                c.check_no || '',
                c.payee || '',
                c.payor || '',
                c.check_date || '',
                c.amount ?? '',
              ]
        )
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
    a.download = `pickup-${tab}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const allVisibleSelected =
    visibleReservations.length > 0 && visibleReservations.every((r) => selectedIds.has(r.id))
  const someVisibleSelected = visibleReservations.some((r) => selectedIds.has(r.id))

  const activeSortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label || 'Sort'
  const selectable = tab === 'active' || tab === 'pending_approval'

  return (
    <div className="pb-20 sm:pb-0">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Pending pickups</h1>
          <p className="mt-1 text-sm text-ink-500">
            Checks collectors have reserved and their remaining pickup window. Submitting a pickup
            sends it to an approver for verification before it's final — nothing leaves the
            building without a second set of eyes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="hidden text-xs text-ink-400 sm:inline">
              Updated <LiveRelativeTime timestamp={lastUpdated} now={now} />
            </span>
          )}
          {(tab === 'active' || tab === 'pending_approval') && (
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className="flex items-center gap-1.5 rounded-md border border-ink-200 px-2.5 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50"
              title={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
              aria-pressed={autoRefresh}
            >
              {autoRefresh ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{autoRefresh ? 'Live' : 'Paused'}</span>
            </button>
          )}
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

   {tab === 'active' && activeSummary && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <KpiCard
            icon={User}
            label="Active orders"
            value={loading ? null : activeSummary.total}
            secondary={loading ? null : `${activeSummary.avgChecksPerOrder} checks/order avg`}
            accent="ink"
          />
          <KpiCard
            icon={Layers}
            label="Checks on hold"
            value={loading ? null : activeSummary.totalChecks}
            secondary={loading ? null : formatCurrency(activeSummary.totalValue)}
            accent="ink"
          />
          <KpiCard
            icon={Wallet}
            label="Total value"
            value={loading ? null : formatCurrency(activeSummary.totalValue)}
            secondary={
              loading
                ? null
                : `${formatCurrency(activeSummary.totalValue / (activeSummary.total || 1))} avg/order`
            }
            accent="ink"
          />
          <KpiCard
            icon={Timer}
            label={`Expiring ≤ ${EXPIRING_SOON_MINUTES}m`}
            value={loading ? null : activeSummary.expiringSoon}
            secondary={loading ? null : `${activeSummary.critical} of these ≤ ${CRITICAL_MINUTES}m`}
            accent={!loading && activeSummary.expiringSoon > 0 ? 'amber' : 'ink'}
            active={quickFilter === 'expiring'}
            onClick={() => setQuickFilter((f) => (f === 'expiring' ? 'all' : 'expiring'))}
          />
          <KpiCard
            icon={Flame}
            label={`Critical ≤ ${CRITICAL_MINUTES}m`}
            value={loading ? null : activeSummary.critical}
            secondary={!loading && activeSummary.critical > 0 ? 'Needs immediate attention' : null}
            accent={!loading && activeSummary.critical > 0 ? 'red' : 'ink'}
          />
        </div>
      )}   
{tab === 'pending_approval' && pendingSummary && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <KpiCard
            icon={ShieldCheck}
            label="Awaiting approval"
            value={loading ? null : pendingSummary.total}
            secondary={loading ? null : pendingSummary.oldestWaitingLabel ? `Oldest: ${pendingSummary.oldestWaitingLabel}` : null}
            accent="ink"
          />
          <KpiCard
            icon={Hash}
            label="Checks submitted"
            value={loading ? null : pendingSummary.totalChecks}
            secondary={loading ? null : formatCurrency(pendingSummary.totalValue)}
            accent="ink"
          />
          <KpiCard
            icon={Wallet}
            label="Total value"
            value={loading ? null : formatCurrency(pendingSummary.totalValue)}
            secondary={
              loading
                ? null
                : `${formatCurrency(pendingSummary.totalValue / (pendingSummary.total || 1))} avg/submission`
            }
            accent="ink"
          />
          <KpiCard
            icon={Hourglass}
            label={`Waiting ${PENDING_WARN_MINUTES}m+`}
            value={loading ? null : pendingSummary.stale}
            secondary={loading ? null : `${pendingSummary.critical} of these ${PENDING_CRITICAL_MINUTES}m+`}
            accent={!loading && pendingSummary.stale > 0 ? 'amber' : 'ink'}
            active={quickFilter === 'stale'}
            onClick={() => setQuickFilter((f) => (f === 'stale' ? 'all' : 'stale'))}
          />
          <KpiCard
            icon={Flame}
            label={`Critical ${PENDING_CRITICAL_MINUTES}m+`}
            value={loading ? null : pendingSummary.critical}
            secondary={!loading && pendingSummary.critical > 0 ? 'Escalate to an approver' : null}
            accent={!loading && pendingSummary.critical > 0 ? 'red' : 'ink'}
          />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md border border-ink-200 p-1">
          <TabButton active={tab === 'active'} onClick={() => setTab('active')}>
            Active
          </TabButton>
          <TabButton active={tab === 'pending_approval'} onClick={() => setTab('pending_approval')}>
            Pending Approval
          </TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
            History
          </TabButton>
        </div>

        <button
          onClick={exportCsv}
          disabled={visibleReservations.length === 0}
          className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input
            value={collectorFilter}
            onChange={(e) => setCollectorFilter(e.target.value)}
            placeholder="Filter by collector name..."
            className="border-ink-200 pl-9 pr-8 text-sm focus-visible:ring-teal-500"
            aria-label="Filter by collector name"
          />
          {collectorFilter && (
            <button
              onClick={() => setCollectorFilter('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600"
              aria-label="Clear collector filter"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="relative flex-1">
          <Filter className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input
            ref={searchInputRef}
            value={checkSearch}
            onChange={(e) => setCheckSearch(e.target.value)}
            placeholder="Search check #, payee, payor, or OR no... (press /)"
            className="border-ink-200 pl-9 pr-8 text-sm focus-visible:ring-teal-500"
            aria-label="Search checks by number, payee, payor, or OR no."
          />
          {checkSearch && (
            <button
              onClick={() => setCheckSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600"
              aria-label="Clear check search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="relative shrink-0">
          <button
            onClick={() => setSortMenuOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 sm:w-auto"
            aria-haspopup="listbox"
            aria-expanded={sortMenuOpen}
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
              <div
                role="listbox"
                className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-ink-200 bg-white py-1 shadow-lg"
              >
                {SORT_OPTIONS.filter((o) => o.tabs.includes(tab)).map((o) => (
                  <button
                    key={o.value}
                    role="option"
                    aria-selected={sortBy === o.value}
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
      </div>

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

      {selectable && visibleReservations.length > 0 && !loading && (
        <div className="mb-2 flex items-center gap-2 px-1">
          <button
            onClick={toggleSelectAllVisible}
            className="flex items-center gap-1.5 text-xs font-medium text-ink-500 hover:text-ink-700"
          >
            {allVisibleSelected ? (
              <CheckSquare className="h-4 w-4 text-teal-600" />
            ) : someVisibleSelected ? (
              <MinusSquare className="h-4 w-4 text-teal-600" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            {allVisibleSelected ? 'Deselect all' : 'Select all'}
          </button>
          {selectedIds.size > 0 && (
            <span className="text-xs text-ink-400">{selectedIds.size} selected</span>
          )}
        </div>
      )}

      {loading ? (
        <ListSkeleton />
      ) : visibleReservations.length === 0 ? (
        <EmptyState
          tab={tab}
          hasFilter={!!collectorFilter.trim() || !!checkSearch.trim() || quickFilter !== 'all'}
        />
      ) : (
        <div className="space-y-2.5">
          {visibleReservations.map((r) => {
            const items = sortedLineItems(r, tab)
            const submittedAtMs = tab === 'pending_approval' ? earliestSubmittedAt(items) : null
            return (
              <ReservationRow
                key={r.id}
                reservation={r}
                items={items}
                total={orderTotal(items)}
                tab={tab}
                minutesLeft={tab === 'active' ? minutesLeft(r.expires_at) : null}
                countdownLabel={tab === 'active' ? formatCountdown(r.expires_at) : null}
                urgencyLevel={
                  tab === 'active'
                    ? urgency(r.expires_at)
                    : tab === 'pending_approval'
                    ? pendingUrgency(submittedAtMs)
                    : 'normal'
                }
                waitingLabel={tab === 'pending_approval' ? formatWaiting(submittedAtMs) : null}
                expanded={expandedIds.has(r.id)}
                onToggleExpand={() => toggleExpand(r.id)}
                selectable={selectable}
                selected={selectedIds.has(r.id)}
                onToggleSelect={() => toggleSelect(r.id)}
                onConfirmPickup={() => openConfirm('submit', r)}
                onRelease={() => openConfirm('release', r)}
                onRecall={() => openConfirm('recall', r)}
              />
            )
          })}
        </div>
      )}

      {selectable && selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-100 bg-white px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] sm:sticky sm:mt-4 sm:rounded-lg sm:border sm:shadow-sm">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <span className="text-sm font-medium text-ink-700">
              {selectedIds.size} order{selectedIds.size === 1 ? '' : 's'} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedIds(new Set())}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50"
              >
                Clear
              </button>
              {tab === 'active' && (
                <button
                  onClick={openBulkReleaseConfirm}
                  className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Release selected
                </button>
              )}
              {tab === 'pending_approval' && (
                <button
                  onClick={openBulkRecallConfirm}
                  className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Recall selected
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <ActionModal
          action={confirmAction}
          checks={confirmChecks}
          total={confirmTotal}
          onCancel={closeConfirm}
          onConfirm={runAction}
          loading={actioning}
          error={actionError}
          successFlash={successFlash}
        />
      )}

      {toast && <Toast message={toast.message} variant={toast.variant} />}
    </div>
  )
}

function LiveRelativeTime({ timestamp, now }) {
  const secs = Math.max(0, Math.round((now - timestamp) / 1000))
  if (secs < 5) return <span>just now</span>
  if (secs < 60) return <span>{secs}s ago</span>
  const mins = Math.floor(secs / 60)
  return <span>{mins}m ago</span>
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

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded px-3.5 py-1.5 text-sm font-medium transition',
        active ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-50'
      )}
    >
      {children}
    </button>
  )
}
function KpiCard({ icon: Icon, label, value, secondary, accent = 'ink', onClick, active }) {
  const accents = {
    teal: { ring: 'border-teal-200', badge: 'bg-teal-100 text-teal-700', activeRing: 'ring-teal-400' },
    amber: { ring: 'border-amber-200', badge: 'bg-amber-100 text-amber-700', activeRing: 'ring-amber-400' },
    red: { ring: 'border-red-200', badge: 'bg-red-100 text-red-600', activeRing: 'ring-red-400' },
    ink: { ring: 'border-ink-100', badge: 'bg-ink-100 text-ink-600', activeRing: 'ring-ink-400' },
  }
  const style = accents[accent] || accents.ink
  const isLoading = value === null || value === undefined
  const isInteractive = typeof onClick === 'function'

  const card = (
    <Card
      className={cn(
        'relative overflow-hidden p-4 transition',
        isInteractive && 'hover:border-ink-200 hover:shadow-sm',
        active && cn('ring-2', style.activeRing),
      )}
    >
      <div
        className={cn(
          'pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed',
          style.ring,
        )}
        aria-hidden="true"
      />
      <div className="relative flex items-start gap-3">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', style.badge)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-6 w-12 animate-pulse rounded bg-ink-100" />
          ) : (
            <p className="truncate text-2xl font-semibold text-ink-900">{value}</p>
          )}
          <p className="truncate text-xs font-medium uppercase tracking-wide text-ink-400">{label}</p>
          {!isLoading && secondary && <p className="mt-0.5 truncate text-xs text-ink-500">{secondary}</p>}
        </div>
      </div>
    </Card>
  )

  if (isInteractive) {
    return (
      <button type="button" onClick={onClick} className="text-left" aria-pressed={!!active}>
        {card}
      </button>
    )
  }
  return card
}
function StatusBadge({ status }) {
  const styles = {
    reserved: 'bg-teal-100 text-teal-700',
    pending_approval: 'bg-amber-100 text-amber-700',
    picked_up: 'bg-teal-100 text-teal-700',
    partial: 'bg-amber-100 text-amber-700',
    expired: 'bg-slate-100 text-slate-500',
    cancelled: 'bg-orange-100 text-orange-700',
  }
  const labels = {
    reserved: 'Reserved',
    pending_approval: 'Pending approval',
    picked_up: 'Picked up',
    partial: 'Partially picked up',
    expired: 'Expired',
    cancelled: 'Released',
  }
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-medium', styles[status] || 'bg-ink-100 text-ink-600')}>
      {labels[status] || status || 'Unknown'}
    </span>
  )
}

function OutcomeBadge({ outcome }) {
  if (outcome === 'picked_up' || outcome === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">
        <Check className="h-3 w-3" />
        Approved &amp; picked up
      </span>
    )
  }
  if (outcome === 'released') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
        <Undo2 className="h-3 w-3" />
        Released
      </span>
    )
  }
  if (outcome === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
        <XCircle className="h-3 w-3" />
        Rejected by approver
      </span>
    )
  }
  if (outcome === 'returned') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        <RotateCcw className="h-3 w-3" />
        Returned for correction
      </span>
    )
  }
  if (outcome === 'expired') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">
        <AlertTriangle className="h-3 w-3" />
        Expired
      </span>
    )
  }
  return null
}

function ReservationRow({
  reservation,
  items,
  total,
  tab,
  minutesLeft,
  countdownLabel,
  urgencyLevel,
  waitingLabel,
  expanded,
  onToggleExpand,
  selectable,
  selected,
  onToggleSelect,
  onConfirmPickup,
  onRelease,
  onRecall,
}) {
  const checkCount = items.length
  const preview = payeePreview(items)
  const isHistory = tab === 'history'
  const isPending = tab === 'pending_approval'

  const pickedCount = isHistory ? items.filter((c) => c.outcome === 'picked_up').length : 0
  const releasedCount = isHistory ? items.filter((c) => c.outcome === 'released').length : 0

  const borderClass =
    urgencyLevel === 'critical'
      ? 'border-red-300'
      : urgencyLevel === 'warning'
      ? 'border-orange-300'
      : 'border-ink-100'

  return (
    <Card className={cn('overflow-hidden p-0', borderClass)}>
      <div className="flex items-start gap-2.5 px-3 py-3 sm:items-center sm:px-4">
        {selectable && (
          <button
            onClick={onToggleSelect}
            className="mt-0.5 shrink-0 text-ink-300 hover:text-teal-600 sm:mt-0"
            aria-label={selected ? 'Deselect order' : 'Select order'}
          >
            {selected ? (
              <CheckSquare className="h-4.5 w-4.5 text-teal-600" />
            ) : (
              <Square className="h-4.5 w-4.5" />
            )}
          </button>
        )}

        <button
          onClick={onToggleExpand}
          className="flex min-w-0 flex-1 flex-col gap-1.5 text-left sm:flex-row sm:items-center sm:gap-3"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <User className="h-4 w-4 shrink-0 text-ink-400" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-medium text-ink-900">
                  {reservation.collector_name || 'Unknown collector'}
                </span>
                <StatusBadge status={reservation.status} />
              </div>
              {preview && <p className="truncate text-xs text-ink-400">{preview}</p>}
              {reservation.status === 'partial' && (
                <p className="mt-0.5 text-[11px] font-medium text-amber-600">
                  {pickedCount} picked up · {releasedCount} released
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-ink-500 sm:pl-0">
            <span className="flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 font-medium text-ink-600">
              <Layers className="h-3 w-3" />
              {checkCount} check{checkCount === 1 ? '' : 's'}
            </span>
            <span className="font-mono font-semibold text-ink-800">{formatCurrency(total)}</span>
            {tab === 'active' ? (
              <span
                className={cn(
                  'flex items-center gap-1 font-mono font-medium',
                  urgencyLevel === 'critical'
                    ? 'text-red-600'
                    : urgencyLevel === 'warning'
                    ? 'text-orange-600'
                    : 'text-teal-700'
                )}
              >
                <Clock className="h-3.5 w-3.5" />
                {countdownLabel}
              </span>
            ) : isPending ? (
              <span
                className={cn(
                  'flex items-center gap-1 font-mono font-medium',
                  urgencyLevel === 'critical'
                    ? 'text-red-600'
                    : urgencyLevel === 'warning'
                    ? 'text-orange-600'
                    : 'text-amber-600'
                )}
              >
                <Hourglass className="h-3.5 w-3.5" />
                {waitingLabel}
              </span>
            ) : (
              <span>
                Reserved {formatDate(reservation.reserved_at)}
                {reservation.picked_up_at && ` · Resolved ${formatDate(reservation.picked_up_at)}`}
              </span>
            )}
            {expanded ? (
              <ChevronUp className="h-4 w-4 text-ink-300" />
            ) : (
              <ChevronDown className="h-4 w-4 text-ink-300" />
            )}
          </div>
        </button>
      </div>

      {expanded && (
        <>
          {checkCount === 0 ? (
            <p className="border-t border-ink-100 px-4 py-3 text-xs text-ink-400">
              No linked checks found for this order.
            </p>
          ) : (
            <div className="overflow-x-auto border-t border-ink-100">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-ink-50 text-left text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="px-4 py-2 font-medium">#</th>
                    <th className="px-2 py-2 font-medium">Check no.</th>
                    <th className="px-2 py-2 font-medium">Payee</th>
                    <th className="px-2 py-2 font-medium">Payor</th>
                    <th className="px-2 py-2 font-medium">Check date</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    {isPending && <th className="px-2 py-2 font-medium">OR no.</th>}
                    {isPending && <th className="px-2 py-2 font-medium">AR collected</th>}
                    {isPending && <th className="px-4 py-2 font-medium">Remarks</th>}
                    {isHistory && <th className="px-2 py-2 font-medium">Outcome</th>}
                    {isHistory && <th className="px-2 py-2 font-medium">OR no.</th>}
                    {isHistory && <th className="px-2 py-2 font-medium">AR collected</th>}
                    {isHistory && <th className="px-4 py-2 font-medium">Remarks</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {items.map((c, idx) => (
                    <tr key={c.id ?? `${reservation.id}-${idx}`}>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-400">{idx + 1}</td>
                      <td className="px-2 py-2.5 font-mono text-xs text-ink-700">
                        <span className="flex items-center gap-1">
                          <Hash className="h-3 w-3 text-ink-300" />
                          {c.check_no || '—'}
                        </span>
                      </td>
                      <td className="max-w-[160px] truncate px-2 py-2.5 font-medium text-ink-900">
                        {c.payee || '—'}
                      </td>
                      <td className="max-w-[160px] truncate px-2 py-2.5 text-ink-600">{c.payor || '—'}</td>
                      <td className="px-2 py-2.5 text-xs text-ink-500">
                        <span className="flex items-center gap-1">
                          <CalendarDays className="h-3 w-3 text-ink-300" />
                          {c.check_date ? formatDate(c.check_date) : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-medium text-ink-700">
                        {formatCurrency(c.amount)}
                      </td>
                      {isPending && (
                        <td className="px-2 py-2.5 font-mono text-xs text-ink-600">{c.or_no || '—'}</td>
                      )}
                      {isPending && (
                        <td className="px-2 py-2.5">
                          {c.ar_collected === null || c.ar_collected === undefined ? (
                            '—'
                          ) : c.ar_collected ? (
                            <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
                          ) : (
                            <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
                          )}
                        </td>
                      )}
                      {isPending && (
                        <td className="max-w-[220px] px-4 py-2.5 text-xs text-ink-500">{c.remarks || '—'}</td>
                      )}
                      {isHistory && (
                        <td className="px-2 py-2.5">
                          <OutcomeBadge outcome={c.outcome} />
                        </td>
                      )}
                     {isHistory && (
  <td className="px-2 py-2.5 font-mono text-xs text-ink-600">{c.or_no || '—'}</td>
)}
{isHistory && (
  <td className="px-2 py-2.5">
    {c.ar_collected === null || c.ar_collected === undefined ? (
      '—'
    ) : c.ar_collected ? (
      <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
    ) : (
      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
    )}
  </td>
)}
{isHistory && (
  <td className="max-w-[220px] px-4 py-2.5 text-xs text-ink-500">
    {c.remarks || '—'}
  </td>
)}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-100 bg-ink-50/40">
                    <td colSpan={5} className="px-4 py-2 text-right text-xs font-medium text-ink-500">
                      Order total
                    </td>
                    <td className="px-4 py-2 text-right font-mono font-semibold text-ink-900">
                      {formatCurrency(total)}
                    </td>
                 {isHistory && <td colSpan={4} />}
{isPending && <td colSpan={3} />}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {tab === 'active' && (
            <div className="flex items-center justify-end gap-2 border-t border-ink-100 bg-white px-4 py-3">
              <button
                onClick={onRelease}
                className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50"
              >
                <Undo2 className="h-3.5 w-3.5" />
                Release
              </button>
              <button
                onClick={onConfirmPickup}
                className="flex items-center gap-1.5 rounded-md bg-orange-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-600"
              >
                <Send className="h-3.5 w-3.5" />
                Submit for Approval
              </button>
            </div>
          )}

          {tab === 'pending_approval' && (
            <div className="flex items-center justify-between gap-2 border-t border-ink-100 bg-white px-4 py-3">
              <p className="flex items-center gap-1.5 text-xs text-ink-400">
                <ShieldCheck className="h-3.5 w-3.5" />
                Waiting on an approver to verify these checks.
              </p>
              <button
                onClick={onRecall}
                className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50"
                title="Pull this submission back to make corrections"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Recall for edits
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// Builds the initial per-check entry map: every check starts "included"
// (assumed picked up) with an empty OR number and no "AR collected" answer,
// so the admin's default action is a full pickup — they only need to touch
// rows for checks that are actually being left behind.
function buildInitialCheckEntries(checks) {
  const initial = {}
  checks.forEach((c) => {
    initial[c.checkId] = { include: true, orNo: '', collected: null, remarks: '' }
  })
  return initial
}

function ActionModal({ action, checks, total, onCancel, onConfirm, loading, error, successFlash }) {
  const isSubmit = action.type === 'submit'
  const isRelease = action.type === 'release'
  const isRecall = action.type === 'recall'
  const isBulkRelease = action.type === 'bulk-release'
  const isBulkRecall = action.type === 'bulk-recall'
  const reservation = action.reservation
  const checkCount = checks.length
  const dialogRef = useRef(null)
  const cancelButtonRef = useRef(null)
  const firstOrInputRef = useRef(null)

  // Per-check state for the submit flow: whether it's included in this
  // pickup, its OR number + AR collected answer if so, and a reason
  // (required either when AR wasn't collected, or when the check isn't
  // included at all). Irrelevant for the release/recall flows.
  const [orEntries, setOrEntries] = useState(() => buildInitialCheckEntries(checks))

  const updateInclude = useCallback((checkId, value) => {
    setOrEntries((prev) => ({
      ...prev,
      [checkId]: {
        include: value,
        orNo: value ? prev[checkId]?.orNo || '' : '',
        collected: value ? prev[checkId]?.collected ?? null : null,
        remarks: '',
      },
    }))
  }, [])

  const updateOrNo = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], orNo: value } }))
  }, [])

  const updateCollected = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], collected: value } }))
  }, [])

  const updateRemarks = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], remarks: value } }))
  }, [])

  // How many checks currently have a complete outcome, how many are
  // included (being submitted for pickup), and whether any entered OR
  // numbers collide.
  const { completedCount, duplicateOrNos, includeCount } = useMemo(() => {
    const seenCounts = {}
    let completed = 0
    let included = 0
    checks.forEach((c) => {
      const entry = orEntries[c.checkId]
      if (!entry) return
      if (entry.include) {
        included += 1
        const orNo = entry.orNo?.trim() ?? ''
        const reasonOk = entry.collected !== false || !!entry.remarks?.trim()
        if (orNo && entry.collected !== null && entry.collected !== undefined && reasonOk) {
          completed += 1
        }
        if (orNo) {
          const key = orNo.toLowerCase()
          seenCounts[key] = (seenCounts[key] || 0) + 1
        }
      } else if (entry.remarks?.trim()) {
        completed += 1
      }
    })
    const duplicates = new Set(
      Object.entries(seenCounts)
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
    )
    return { completedCount: completed, duplicateOrNos: duplicates, includeCount: included }
  }, [orEntries, checks])

  const hasDuplicates = duplicateOrNos.size > 0
  const allComplete = !isSubmit || (checkCount > 0 && completedCount === checkCount && !hasDuplicates)
  const releaseCount = checkCount - includeCount

  // Runs once on mount: focuses the first OR no. field (so an admin can
  // start typing immediately) or, if there's nothing to type into, the
  // Cancel button as a safe default. Deliberately an empty dependency
  // array — this must NOT re-run whenever `onCancel`/`loading` change, or
  // it steals focus back away from whatever the admin is doing every time
  // this component re-renders for an unrelated reason.
  useEffect(() => {
    const previouslyFocused = document.activeElement
    if (isSubmit && firstOrInputRef.current) {
      firstOrInputRef.current.focus()
    } else {
      cancelButtonRef.current?.focus()
    }

    // Prevent the page behind the modal from scrolling while it's open.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = prevOverflow
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape-to-close and a light focus trap so keyboard users aren't
  // dropped out of the modal into the page behind it. Kept separate from
  // the mount effect above so updating `loading`/`onCancel` only rebinds
  // the listener — it never touches focus.
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && !loading) {
        onCancel()
        return
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
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
    if (isSubmit && !allComplete) return
    onConfirm(isSubmit ? orEntries : undefined)
  }

  const title = isSubmit
    ? 'Submit pickup for approval'
    : isRecall
    ? 'Recall submission'
    : isBulkRecall
    ? 'Recall selected submissions'
    : isBulkRelease
    ? 'Release selected orders'
    : 'Release reservation'

  const confirmLabel = isSubmit
    ? includeCount === 0
      ? 'Release All'
      : includeCount === checkCount
      ? 'Submit for Approval'
      : 'Submit Partial for Approval'
    : isRecall
    ? 'Recall for Edits'
    : isBulkRecall
    ? `Recall ${action.reservations.length}`
    : isBulkRelease
    ? `Release ${action.reservations.length}`
    : 'Release'

  const isSimpleList = isRelease || isRecall

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading && !successFlash) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pickup-action-title"
        className="relative w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
          <h2 id="pickup-action-title" className="text-lg font-semibold text-ink-900">
            {title}
          </h2>
          <button
            onClick={onCancel}
            disabled={loading}
            className="text-ink-300 hover:text-ink-600 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto px-5 py-4">
          {(isBulkRelease || isBulkRecall) ? (
            <>
              <p className="text-sm text-ink-600">
                {isBulkRecall ? (
                  <>
                    This pulls {action.reservations.length} submission
                    {action.reservations.length === 1 ? '' : 's'} back out of the approval queue and
                    returns {action.reservations.length === 1 ? 'it' : 'them'} to your Active list so
                    you can fix a mistake before resubmitting. Nothing is released to the pool.
                  </>
                ) : (
                  <>
                    This releases {action.reservations.length} order
                    {action.reservations.length === 1 ? '' : 's'} back into the available pool
                    immediately. Use this if the collectors cancelled or won't be coming.
                  </>
                )}
              </p>
              <div className="mt-3 max-h-56 overflow-y-auto rounded-md border border-ink-100">
                <ul className="divide-y divide-ink-50 text-sm">
                  {action.reservations.map((r) => (
                    <li key={r.id} className="flex items-center justify-between px-3 py-2">
                      <span className="text-ink-800">{r.collector_name || 'Unknown collector'}</span>
                      <span className="text-xs text-ink-400">
                        {(r.checks || []).length} check{(r.checks || []).length === 1 ? '' : 's'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-600">
              {isSubmit ? (
                <>
                  For each check in <span className="font-medium text-ink-900">{reservation.collector_name}</span>
                  's order, confirm whether it's actually being picked up right now. Uncheck any check
                  the collector isn't taking today — you'll be asked why, and it goes straight back
                  into the available pool for someone else to reserve. Checks you submit will go to
                  an approver for verification before they're final.
                </>
              ) : isRecall ? (
                <>
                  This pulls <span className="font-medium text-ink-900">{reservation.collector_name}</span>
                  's submission of {checkCount} check{checkCount === 1 ? '' : 's'} back out of the
                  approval queue so you can fix a mistake — a wrong OR number, for example — before
                  resubmitting. It goes back to your Active list; nothing is released to the pool.
                </>
              ) : (
                <>
                  This releases this order of {checkCount} check{checkCount === 1 ? '' : 's'} held for{' '}
                  <span className="font-medium text-ink-900">{reservation.collector_name}</span> back into the
                  available pool immediately. Use this if the collector cancelled or won't be coming.
                </>
              )}
            </p>
          )}

          {isSubmit && checkCount > 0 && (
            <div className="mt-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-ink-500">Per-check outcome</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">
                    {includeCount} to submit
                  </span>
                  {releaseCount > 0 && (
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      {releaseCount} to release
                    </span>
                  )}
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      allComplete ? 'bg-teal-100 text-teal-700' : 'bg-orange-100 text-orange-700'
                    )}
                  >
                    {completedCount} of {checkCount} entered
                  </span>
                </div>
              </div>
              <div className="max-h-[22rem] overflow-y-auto rounded-md border border-ink-100">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ink-50">
                    <tr className="text-left uppercase tracking-wide text-ink-400">
                      <th className="px-3 py-1.5 font-medium">Pick up</th>
                      <th className="px-3 py-1.5 font-medium">Check no.</th>
                      <th className="px-3 py-1.5 font-medium">Payee</th>
                      <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                      <th className="px-3 py-1.5 font-medium">OR no.</th>
                      <th className="px-3 py-1.5 font-medium">AR collected</th>
                      <th className="px-3 py-1.5 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-50">
                    {checks.map((c, idx) => {
                      const entry = orEntries[c.checkId] || { include: true, orNo: '', collected: null, remarks: '' }
                      const trimmedOrNo = entry.orNo?.trim() ?? ''
                      const isDuplicate = entry.include && trimmedOrNo && duplicateOrNos.has(trimmedOrNo.toLowerCase())
                      const needsReason = entry.include ? entry.collected === false : true
                      const missingReason = needsReason && !entry.remarks?.trim()
                      const rowIncomplete = entry.include
                        ? !trimmedOrNo || entry.collected === null || entry.collected === undefined || missingReason
                        : missingReason

                      return (
                        <tr
                          key={c.checkId ?? idx}
                          className={cn(
                            !entry.include && 'bg-slate-50/70',
                            entry.include && isDuplicate && 'bg-red-50/70',
                            !isDuplicate && rowIncomplete && 'bg-amber-50/50'
                          )}
                        >
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => updateInclude(c.checkId, !entry.include)}
                              aria-pressed={entry.include}
                              aria-label={
                                entry.include
                                  ? `Mark check ${c.check_no || idx + 1} as not picked up`
                                  : `Mark check ${c.check_no || idx + 1} as picked up`
                              }
                              className={entry.include ? 'text-teal-600' : 'text-ink-300 hover:text-ink-500'}
                            >
                              {entry.include ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                            </button>
                          </td>
                          <td className="px-3 py-2 font-mono text-ink-700">{c.check_no || '—'}</td>
                          <td className="max-w-[110px] truncate px-3 py-2 text-ink-900">{c.payee || '—'}</td>
                          <td className="px-3 py-2 text-right font-mono text-ink-700">
                            {formatCurrency(c.amount)}
                          </td>
                          <td className="px-2 py-1.5">
                            {entry.include ? (
                              <>
                                <input
                                  ref={idx === 0 ? firstOrInputRef : undefined}
                                  type="text"
                                  inputMode="numeric"
                                  value={entry.orNo}
                                  onChange={(e) => updateOrNo(c.checkId, e.target.value)}
                                  onBlur={(e) => updateOrNo(c.checkId, e.target.value.trim())}
                                  placeholder="OR no."
                                  maxLength={40}
                                  aria-label={`OR number for check ${c.check_no || idx + 1}`}
                                  className={cn(
                                    'w-24 rounded border px-2 py-1 text-xs text-ink-800 focus:outline-none focus:ring-1 focus:ring-teal-500',
                                    isDuplicate ? 'border-red-400' : 'border-ink-200'
                                  )}
                                />
                                {isDuplicate && (
                                  <p className="mt-0.5 text-[10px] leading-tight text-red-600">Duplicate</p>
                                )}
                              </>
                            ) : (
                              <span className="text-ink-300">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {entry.include ? (
                              <div
                                className="flex gap-1"
                                role="group"
                                aria-label={`AR collected for check ${c.check_no || idx + 1}`}
                              >
                                <button
                                  type="button"
                                  onClick={() => updateCollected(c.checkId, true)}
                                  aria-pressed={entry.collected === true}
                                  className={cn(
                                    'rounded border px-2 py-1 text-[11px] font-medium transition',
                                    entry.collected === true
                                      ? 'border-teal-600 bg-teal-600 text-white'
                                      : 'border-ink-200 text-ink-500 hover:bg-ink-50'
                                  )}
                                >
                                  Yes
                                </button>
                                <button
                                  type="button"
                                  onClick={() => updateCollected(c.checkId, false)}
                                  aria-pressed={entry.collected === false}
                                  className={cn(
                                    'rounded border px-2 py-1 text-[11px] font-medium transition',
                                    entry.collected === false
                                      ? 'border-ink-700 bg-ink-700 text-white'
                                      : 'border-ink-200 text-ink-500 hover:bg-ink-50'
                                  )}
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                                Releasing
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {needsReason ? (
                              <input
                                type="text"
                                value={entry.remarks}
                                onChange={(e) => updateRemarks(c.checkId, e.target.value)}
                                placeholder={entry.include ? 'Why wasn\u2019t AR collected?' : 'Why isn\u2019t this being picked up?'}
                                maxLength={200}
                                aria-label={`Reason for check ${c.check_no || idx + 1}`}
                                className={cn(
                                  'w-40 rounded border px-2 py-1 text-xs text-ink-800 focus:outline-none focus:ring-1 focus:ring-teal-500',
                                  missingReason ? 'border-orange-400' : 'border-ink-200'
                                )}
                              />
                            ) : (
                              <span className="text-ink-300">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-ink-100 bg-ink-50/60">
                      <td colSpan={3} className="px-3 py-1.5 text-right font-medium text-ink-500">
                        Total
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono font-semibold text-ink-900">
                        {formatCurrency(total)}
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
              {!allComplete && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-orange-600">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {hasDuplicates
                    ? 'Each check being picked up needs its own unique OR number.'
                    : 'Every check needs an outcome: OR number + AR collected status if picking up, or a reason if not.'}
                </p>
              )}
            </div>
          )}

          {isSimpleList && checkCount > 0 && (
            <div className="mt-3 max-h-56 overflow-y-auto rounded-md border border-ink-100">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-ink-50">
                  <tr className="text-left uppercase tracking-wide text-ink-400">
                    <th className="px-3 py-1.5 font-medium">Check no.</th>
                    <th className="px-3 py-1.5 font-medium">Payee</th>
                    <th className="px-3 py-1.5 font-medium">Payor</th>
                    <th className="px-3 py-1.5 font-medium">Date</th>
                    <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {checks.map((c, idx) => (
                    <tr key={c.checkId ?? idx}>
                      <td className="px-3 py-1.5 font-mono text-ink-700">{c.check_no || '—'}</td>
                      <td className="max-w-[110px] truncate px-3 py-1.5 text-ink-900">{c.payee || '—'}</td>
                      <td className="max-w-[110px] truncate px-3 py-1.5 text-ink-600">{c.payor || '—'}</td>
                      <td className="px-3 py-1.5 text-ink-500">
                        {c.check_date ? formatDate(c.check_date) : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-ink-700">
                        {formatCurrency(c.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-100 bg-ink-50/60">
                    <td colSpan={4} className="px-3 py-1.5 text-right font-medium text-ink-500">
                      Total
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold text-ink-900">
                      {formatCurrency(total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {(isRelease || isBulkRelease) && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-orange-50 px-3 py-2 text-xs text-orange-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {isBulkRelease
                ? 'These reservations will be marked as not picked up.'
                : "This collector's reservation will be marked as not picked up."}
            </div>
          )}

          {(isRecall || isBulkRecall) && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {isBulkRecall
                ? 'These will need to be resubmitted for approval after you make your corrections.'
                : "This will need to be resubmitted for approval after you make your corrections."}
            </div>
          )}

          {error && (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-100 px-5 py-4">
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
            disabled={loading || (isSubmit && !allComplete)}
            title={isSubmit && !allComplete ? 'Every check needs a complete outcome before submitting' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60',
              isSubmit ? 'bg-orange-500 hover:bg-orange-600' : 'bg-ink-900 hover:bg-ink-800'
            )}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>

        {/* Success overlay: shown briefly right after the RPC call
            succeeds, covering the form so admins get a clear, celebratory
            "done" signal before the modal auto-closes. Purely presentational
            — the toast (rendered by the parent, outside this modal) is the
            durable confirmation that survives after this unmounts. */}
        {successFlash && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 backdrop-blur-sm">
            <style>{`
              @keyframes pickupSuccessPop {
                0% { transform: scale(0.6); opacity: 0; }
                60% { transform: scale(1.08); opacity: 1; }
                100% { transform: scale(1); }
              }
              .pickup-success-icon { animation: pickupSuccessPop 0.35s ease-out; }
            `}</style>
            <div className="pickup-success-icon flex h-14 w-14 items-center justify-center rounded-full bg-teal-100">
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

function EmptyState({ tab, hasFilter }) {
  const copy = {
    active: {
      title: 'No active reservations',
      body: 'Orders reserved by collectors will show up here until submitted or expired.',
    },
    pending_approval: {
      title: 'Nothing awaiting approval',
      body: 'Pickups you submit will show up here until an approver decides on them.',
    },
    history: {
      title: 'No history yet',
      body: 'Completed, expired, released, and rejected orders will appear here.',
    },
  }[tab]

  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-ink-200 px-4 py-16 text-center">
      <Clock className="h-8 w-8 text-ink-200" />
      <p className="mt-3 text-lg font-semibold text-ink-700">
        {hasFilter ? 'No matching reservations' : copy.title}
      </p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        {hasFilter ? 'Try a different search, or clear the filters.' : copy.body}
      </p>
    </div>
  )
}
