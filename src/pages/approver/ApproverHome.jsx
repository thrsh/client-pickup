// src/pages/approver/ApproverHome.jsx
//
// This is the other half of the submit-for-approval flow started in
// AdminPickups.jsx. An admin submits per-check pickup data (OR no., AR
// collected, remarks); those checks land here as 'pending_approval'. For
// each one, an approver makes one of three decisions:
//   - Approve -> check is finally marked picked_up. Done.
//   - Reject  -> check is released straight back into the general
//                available pool. Use this when the collector isn't
//                actually taking the check (wrong call by admin, collector
//                backed out, etc.) — anyone can reserve it again.
//   - Return  -> check goes back to the SAME reservation as 'reserved',
//                landing back in the submitting admin's Active tab so they
//                can fix a mistake (e.g. a mistyped OR number) and
//                resubmit. It is NOT released to the pool, so nobody else
//                can grab it out from under the original collector while
//                the correction is made.
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RefreshCw,
  Search,
  X,
  Check,
  XCircle,
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

// One row per check pending approval, flattened out of whatever reservation
// it belongs to. Approvers think in terms of "which checks", not "which
// reservations" — a single order can have some checks awaiting approval
// while others in the same order were already released before submission.
function pendingCheckRows(reservations) {
  const rows = []
  reservations.forEach((r) => {
    const checks = Array.isArray(r.checks) ? r.checks : []
    checks.forEach((c) => {
      if (c.status !== 'pending_approval') return
      rows.push({
        id: c.id,
        checkId: c.id,
        reservationId: r.id,
        collectorName: r.collector_name,
        row_number: c.row_number,
        payee: c.payee,
        payor: c.payor,
        check_no: c.check_no,
        check_date: c.check_date,
        amount: c.amount,
        or_no: c.or_no,
        ar_collected: c.ar_collected,
        remarks: c.remarks,
        submitted_by_name: c.submitted_by_name,
        submitted_at: c.submitted_at,
      })
    })
  })
  return rows
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
    [c.payee, c.payor, c.check_no, c.collectorName, c.or_no]
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
  const [quickFilter, setQuickFilter] = useState('all') // 'all' | 'stale'
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const [selectedCheckIds, setSelectedCheckIds] = useState(() => new Set())
  const [confirmAction, setConfirmAction] = useState(null) // { group, checks } or { groups, bulk: true }
  const [actioning, setActioning] = useState(false)
  const [actionError, setActionError] = useState('')
  const [successFlash, setSuccessFlash] = useState(null)
  const [toast, setToast] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [now, setNow] = useState(Date.now())

  const isMountedRef = useRef(true)
  const inFlightRef = useRef(false)
  const requestIdRef = useRef(0)
  const toastTimerRef = useRef(null)
  const successTimerRef = useRef(null)
  const searchInputRef = useRef(null)

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
      const { data, error } = await supabase
        .from('pickup_reservations')
        .select(
          'id, collector_name, status, checks(id, status, row_number, payee, payor, check_no, check_date, amount, or_no, ar_collected, remarks, submitted_by_name, submitted_at)'
        )
        .eq('status', 'pending_approval')
        .order('reserved_at', { ascending: true })
        .limit(150)

      if (!isMountedRef.current || requestId !== requestIdRef.current) return

      if (error) {
        // A 401/403 here almost always means the RLS policy on
        // pending_approval reservations doesn't recognize this role —
        // surface that distinctly from a generic network failure.
        const isAuthError = error.code === 'PGRST301' || /permission|policy/i.test(error.message || '')
        setLoadError(
          isAuthError
            ? "You don't have permission to view pending approvals. Contact an admin if this seems wrong."
            : error.message || 'Failed to load pending approvals. Please try again.'
        )
        return
      }

      setGroups(groupByReservation(pendingCheckRows(data || [])))
      setLastUpdated(Date.now())
      setSelectedCheckIds((prev) => {
        if (prev.size === 0) return prev
        const validIds = new Set(pendingCheckRows(data || []).map((r) => r.checkId))
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
    const mins = minutesWaiting(submittedAtMs)
    if (mins < 60) return `${mins}m`
    const hrs = Math.floor(mins / 60)
    const rem = mins % 60
    return `${hrs}h ${rem}m`
  }

  function pendingUrgency(submittedAtMs) {
    const mins = minutesWaiting(submittedAtMs)
    if (mins >= PENDING_CRITICAL_MINUTES) return 'critical'
    if (mins >= PENDING_WARN_MINUTES) return 'warning'
    return 'normal'
  }

  const visibleGroups = useMemo(() => {
    const term = search.trim()
    let list = groups.filter((g) => matchesSearch(g.items, term))

    list = list.map((g) => ({ ...g, total: orderTotal(g.items), submittedAtMs: earliestSubmittedAt(g.items) }))

    if (quickFilter === 'stale') {
      list = list.filter((g) => g.submittedAtMs && minutesWaiting(g.submittedAtMs) >= PENDING_WARN_MINUTES)
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
  }, [groups, search, sortBy, quickFilter, now])

  const summary = useMemo(() => {
    const allItems = groups.flatMap((g) => g.items)
    const stale = groups.filter((g) => {
      const submittedAtMs = earliestSubmittedAt(g.items)
      return submittedAtMs && minutesWaiting(submittedAtMs) >= PENDING_WARN_MINUTES
    }).length
    return {
      orders: groups.length,
      checks: allItems.length,
      totalValue: orderTotal(allItems),
      stale,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ groups: [...byReservation.values()], bulk: true })
  }

  const closeConfirm = useCallback(() => {
    clearTimeout(successTimerRef.current)
    setSuccessFlash(null)
    setConfirmAction(null)
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
      let rejectedTotal = 0
      let returnedTotal = 0
      const results = []

      for (const t of targets) {
        const p_decisions = t.items.map((c) => {
          const d = decisionsByCheckId[c.checkId]
          if (d.decision === 'approve') {
            approvedTotal += 1
            return { check_id: c.checkId, decision: 'approve' } // no remarks — nothing to explain on approval
          }
          if (d.decision === 'return') {
            returnedTotal += 1
            return { check_id: c.checkId, decision: 'return', remarks: d.remarks.trim() }
          }
          rejectedTotal += 1
          return { check_id: c.checkId, decision: 'reject', remarks: d.remarks.trim() }
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
      if (rejectedTotal > 0) parts.push(`${rejectedTotal} rejected`)
      const summaryMsg = parts.length > 0 ? parts.join(', ') : 'Decisions recorded'

      setSuccessFlash({ message: summaryMsg })
      clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => {
        if (!isMountedRef.current) return
        setSuccessFlash(null)
        setConfirmAction(null)
        setSelectedCheckIds(new Set())
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
    const headers = ['Collector', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'OR no.', 'AR collected', 'Remarks', 'Submitted by', 'Submitted at']
    const rows = [headers]
    visibleGroups.forEach((g) => {
      g.items.forEach((c) => {
        rows.push([
          g.collectorName || '',
          c.check_no || '',
          c.payee || '',
          c.payor || '',
          c.check_date || '',
          c.amount ?? '',
          c.or_no || '',
          c.ar_collected === null || c.ar_collected === undefined ? '' : c.ar_collected ? 'Yes' : 'No',
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
              submitted, then approve for release, return to the admin to fix a mistake, or reject
              to send it back into the available pool.
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
        <div className="mb-5 grid grid-cols-2 gap-3 sm:max-w-2xl sm:grid-cols-4">
          <LedgerStatCard icon={Layers} label="Orders" value={summary.orders} />
          <LedgerStatCard icon={Hash} label="Checks awaiting" value={summary.checks} />
          <LedgerStatCard icon={Stamp} label="Total value" value={formatCurrency(summary.totalValue)} />
          <button onClick={() => setQuickFilter((f) => (f === 'stale' ? 'all' : 'stale'))} className="text-left">
            <Card
              className={cn(
                'relative overflow-hidden border-ink-100 p-4 transition',
                summary.stale > 0 && 'border-orange-300 bg-orange-50',
                quickFilter === 'stale' && 'ring-2 ring-orange-400'
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
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
            <Input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search collector, check #, payee, payor, or OR no... (press /)"
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
        <EmptyState hasFilter={!!search.trim() || quickFilter !== 'all'} />
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

function LedgerStatCard({ icon: Icon, label, value }) {
  return (
    <Card className="relative overflow-hidden border-ink-100 p-4">
      <div
        className="pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed border-ledger-stamp/30"
        aria-hidden="true"
      />
      <div className="relative flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ledger-stamp/10 text-ledger-stampDark">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-400">{label}</p>
      </div>
      <p className="relative mt-1.5 font-display text-2xl font-semibold text-ink-900">{value}</p>
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
              <span className="truncate font-display font-medium text-ink-900">{group.collectorName || 'Unknown collector'}</span>
              {items[0]?.submitted_by_name && (
                <p className="truncate font-mono text-xs text-ink-400">Submitted by {items[0].submitted_by_name}</p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-ink-500 sm:pl-0">
            <span className="flex items-center gap-1 rounded-full bg-ledger-amber/15 px-2 py-0.5 font-medium text-ledger-amber">
              <Layers className="h-3 w-3" />
              {items.length} awaiting
            </span>
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
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-dashed border-ink-100 text-left font-mono text-[11px] uppercase tracking-wide text-ink-400">
                  <th className="px-4 py-2 font-medium"></th>
                  <th className="px-2 py-2 font-medium">Check no.</th>
                  <th className="px-2 py-2 font-medium">Payee</th>
                  <th className="px-2 py-2 font-medium">Payor</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-2 py-2 font-medium">OR no.</th>
                  <th className="px-2 py-2 font-medium">AR collected</th>
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
                    <td className="px-2 py-2.5 font-mono text-xs text-ink-700">
                      <span className="flex items-center gap-1">
                        <Hash className="h-3 w-3 text-ink-300" />
                        {c.check_no || '—'}
                      </span>
                    </td>
                    <td className="max-w-[140px] truncate px-2 py-2.5 font-medium text-ink-900">{c.payee || '—'}</td>
                    <td className="max-w-[140px] truncate px-2 py-2.5 text-ink-600">{c.payor || '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-medium text-ink-700">{formatCurrency(c.amount)}</td>
                    <td className="px-2 py-2.5 font-mono text-xs text-ink-700">{c.or_no || '—'}</td>
                    <td className="px-2 py-2.5">
                      {c.ar_collected === null || c.ar_collected === undefined ? (
                        '—'
                      ) : c.ar_collected ? (
                        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
                      ) : (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
                      )}
                    </td>
                    <td className="max-w-[200px] px-4 py-2.5 text-xs text-ink-500">{c.remarks || '—'}</td>
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
// re-confirming every single row. Remarks only ever matter for return/reject;
// an approval never carries or requires an explanation.
function buildInitialDecisions(checks) {
  const initial = {}
  checks.forEach((c) => {
    initial[c.checkId] = { decision: 'approve', remarks: '' }
  })
  return initial
}

function ReviewModal({ action, onCancel, onConfirm, loading, error, successFlash }) {
  const allChecks = action.bulk ? action.groups.flatMap((g) => g.items) : action.checks
  const total = orderTotal(allChecks)
  const dialogRef = useRef(null)
  const cancelButtonRef = useRef(null)
  const remarksRefs = useRef({})

  const [decisions, setDecisions] = useState(() => buildInitialDecisions(allChecks))
  // Only start nagging about a missing reason after the approver has
  // actually tried to confirm once — flagging every return/reject row red
  // the instant it's picked is noisy, not helpful.
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

  const { approveCount, rejectCount, returnCount, allComplete, firstIncompleteId } = useMemo(() => {
    let approve = 0
    let reject = 0
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
      if (d.decision === 'reject') reject += 1
      else ret += 1
      // Reasons must be real text, not just whitespace, and only ever
      // required for return/reject.
      if (!d.remarks?.trim()) {
        complete = false
        if (!firstIncomplete) firstIncomplete = c.checkId
      }
    })
    return { approveCount: approve, rejectCount: reject, returnCount: ret, allComplete: complete, firstIncompleteId: firstIncomplete }
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
      if (e.key === 'Escape' && !loading) onCancel()
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
        className="relative flex h-full max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-dashed border-ink-100 bg-ink-50/50 px-6 py-4">
          <div>
            <h2 className="flex items-center gap-2 font-display text-xl font-semibold text-ink-900">
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
            a fixable mistake back to the submitting admin, or <span className="font-medium text-ink-800">reject</span> if the
            collector isn't actually taking it. Return and reject each require a short reason.
          </p>

          <div className="mt-3 mb-3 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-teal-100 px-2.5 py-1 text-xs font-medium text-teal-700">{approveCount} to approve</span>
            {returnCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">{returnCount} to return</span>
            )}
            {rejectCount > 0 && (
              <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700">{rejectCount} to reject</span>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-ink-100">
            <div className="max-h-[52vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-ink-50 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                  <tr className="text-left font-mono text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="px-4 py-2.5 font-medium">Check no.</th>
                    <th className="px-4 py-2.5 font-medium">Payee</th>
                    <th className="px-4 py-2.5 font-medium">Payor</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">OR no.</th>
                    <th className="px-4 py-2.5 font-medium">AR</th>
                    <th className="px-4 py-2.5 font-medium">Decision</th>
                    <th className="px-4 py-2.5 font-medium">Reason (return / reject only)</th>
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
                          d.decision === 'reject' && 'bg-red-50/50',
                          d.decision === 'return' && 'bg-amber-50/50',
                          flagRow && 'bg-orange-50 ring-1 ring-inset ring-orange-300'
                        )}
                      >
                        <td className="px-4 py-3 font-mono text-xs text-ink-700">
                          <span className="flex items-center gap-1">
                            <Hash className="h-3 w-3 text-ink-300" />
                            {c.check_no || '—'}
                          </span>
                        </td>
                        <td className="max-w-[160px] truncate px-4 py-3 font-medium text-ink-900">{c.payee || '—'}</td>
                        <td className="max-w-[160px] truncate px-4 py-3 text-ink-600">{c.payor || '—'}</td>
                        <td className="px-4 py-3 text-right font-mono text-ink-700">{formatCurrency(c.amount)}</td>
                        <td className="px-4 py-3 font-mono text-xs text-ink-700">{c.or_no || '—'}</td>
                        <td className="px-4 py-3">
                          {c.ar_collected === null || c.ar_collected === undefined ? '—' : c.ar_collected ? 'Yes' : 'No'}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex gap-1.5" role="group" aria-label={`Decision for check ${c.check_no || idx + 1}`}>
                            <button
                              type="button"
                              onClick={() => updateDecision(c.checkId, 'approve')}
                              title="Approve for release — no explanation needed"
                              className={cn(
                                'flex items-center gap-1 rounded border px-2 py-1.5 text-xs font-medium transition',
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
                              className={cn(
                                'flex items-center gap-1 rounded border px-2 py-1.5 text-xs font-medium transition',
                                d.decision === 'return' ? 'border-amber-600 bg-amber-600 text-white' : 'border-ink-200 text-ink-500 hover:bg-ink-50'
                              )}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Return
                            </button>
                            <button
                              type="button"
                              onClick={() => updateDecision(c.checkId, 'reject')}
                              title="Release back into the available pool"
                              className={cn(
                                'flex items-center gap-1 rounded border px-2 py-1.5 text-xs font-medium transition',
                                d.decision === 'reject' ? 'border-red-600 bg-red-600 text-white' : 'border-ink-200 text-ink-500 hover:bg-ink-50'
                              )}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              Reject
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
                                placeholder={d.decision === 'return' ? 'What needs fixing?' : 'Why is this being rejected?'}
                                maxLength={REMARKS_MAX_LEN}
                                required
                                aria-required="true"
                                aria-invalid={missingReason}
                                className={cn(
                                  'w-56 rounded border px-2.5 py-1.5 text-sm text-ink-800 focus:outline-none focus:ring-1 focus:ring-teal-500',
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
                    <td colSpan={3} className="px-4 py-2.5 text-right font-medium text-ink-500">Total</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-ink-900">{formatCurrency(total)}</td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {showValidation && !allComplete && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-orange-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Enter a reason for every returned or rejected check before confirming.
            </p>
          )}

          {returnCount > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Returned checks go back to the submitting admin's Active list — the collector's
              reservation is unaffected and nobody else can claim it while it's corrected.
            </div>
          )}

          {rejectCount > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Rejected checks are released immediately into the available pool for any collector
              to reserve.
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
          ? 'Try a different search, or clear the filter.'
          : 'Checks submitted by admins for pickup will show up here for verification.'}
      </p>
    </div>
  )
}
