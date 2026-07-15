// src/pages/approver/ApproverHistory.jsx
//
// Full audit trail for the approve/return/reject workflow. Unlike the
// "History" tab in AdminPickups.jsx (which only ever shows what's
// currently true about a reservation), this page reconstructs the whole
// chain per check: who submitted it for approval and when, who verified
// it and when, what they decided, and the OR no. / AR collected / remarks
// attached at that moment.
//
// DATA NOTE: check_activity_log doesn't have a "submitted_at" column on
// the decision row itself — only `performed_at` (when the decision
// happened). But every submission ALSO writes its own
// action = 'submitted_for_approval' log entry with its own performed_at.
// So "sent for approval at" is reconstructed by matching each decision
// entry to the most recent submitted_for_approval entry for the same
// check_id — exact, not estimated. See buildDecisionRows() below.
//
// Requires the same migration as ApproverHome.jsx / AdminPickups.jsx
// (approval-workflow migration + the approver_decide fix that logs
// action = 'approved' | 'rejected' | 'returned').
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RefreshCw,
  Search,
  X,
  Check,
  XCircle,
  RotateCcw,
  AlertTriangle,
  UserCheck,
  Hash,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Download,
  ArrowUpDown,
  ShieldCheck,
  Filter,
  SlidersHorizontal,
  ClipboardList,
  Wallet,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import { useProfile, hasRole } from '../../context/ProfileContext'

const ALLOWED_ROLES = ['approver', 'admin']
const FETCH_LIMIT = 2000
const PAGE_SIZE_OPTIONS = [25, 50, 100]
const DECISION_ACTIONS = ['approved', 'rejected', 'returned']

const DECISION_META = {
  approved: {
    label: 'Approved',
    icon: Check,
    badge: 'bg-teal-100 text-teal-700',
    accent: 'border-l-teal-400',
  },
  rejected: {
    label: 'Rejected',
    icon: XCircle,
    badge: 'bg-red-100 text-red-700',
    accent: 'border-l-red-400',
  },
  returned: {
    label: 'Returned',
    icon: RotateCcw,
    badge: 'bg-amber-100 text-amber-700',
    accent: 'border-l-amber-400',
  },
}

const SORT_OPTIONS = [
  { value: 'decided_desc', label: 'Most recently decided' },
  { value: 'decided_asc', label: 'Oldest decided first' },
  { value: 'sent_desc', label: 'Most recently sent' },
  { value: 'sent_asc', label: 'Oldest sent first' },
  { value: 'amount_desc', label: 'Highest amount' },
  { value: 'amount_asc', label: 'Lowest amount' },
  { value: 'collector_asc', label: 'Collector A→Z' },
]

function fmtDateTime(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function durationLabel(fromIso, toIso) {
  if (!fromIso || !toIso) return null
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hrs < 24) return `${hrs}h ${remMins}m`
  const days = Math.floor(hrs / 24)
  const remHrs = hrs % 24
  return `${days}d ${remHrs}h`
}

// Two-letter initials for the small avatar chips in the table — falls
// back to a single "?" when there's no name to draw from.
function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Reconstructs one row per decision (approve/return/reject), enriched
// with the matching "sent for approval" submission for that same check.
// Walks the log in chronological order per check_id so a check that gets
// returned and resubmitted multiple times is matched correctly each time
// — each decision picks up whichever submission most recently preceded it.
function buildDecisionRows(rawLog) {
  const lastSubmissionByCheck = new Map()
  const rows = []

  const sorted = [...rawLog].sort((a, b) => new Date(a.performed_at) - new Date(b.performed_at))

  sorted.forEach((entry) => {
    if (entry.action === 'submitted_for_approval') {
      lastSubmissionByCheck.set(entry.check_id, entry)
      return
    }
    if (!DECISION_ACTIONS.includes(entry.action)) return

    const submission = lastSubmissionByCheck.get(entry.check_id)
    const c = entry.checks || {}

    rows.push({
      id: entry.id,
      checkId: entry.check_id,
      reservationId: entry.reservation_id,
      decision: entry.action, // 'approved' | 'rejected' | 'returned'
      collectorName: entry.collector_name,
      row_number: c.row_number,
      payee: c.payee,
      payor: c.payor,
      check_no: c.check_no,
      check_date: c.check_date,
      amount: c.amount,
      or_no: entry.or_no,
      ar_collected: entry.ar_collected,
      remarks: entry.remarks,
      sentAt: submission?.performed_at ?? null,
      sentByName: submission?.submitted_by_name ?? entry.submitted_by_name ?? null,
      decidedAt: entry.performed_at,
      verifiedByName: entry.approved_by_name ?? null,
    })

    // Once a check is decided, its next submission (if any) starts a
    // fresh cycle — don't let a later resubmission of the SAME check
    // accidentally get matched to this now-consumed submission again.
    lastSubmissionByCheck.delete(entry.check_id)
  })

  return rows
}

function matchesSearch(row, term) {
  if (!term) return true
  const needle = term.toLowerCase()
  return [
    row.collectorName,
    row.payee,
    row.payor,
    row.check_no,
    row.or_no,
    row.remarks,
    row.sentByName,
    row.verifiedByName,
  ]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(needle))
}

function toDateInputValue(d) {
  return d.toISOString().slice(0, 10)
}

// Matches the KPI card treatment used on ApproverHome: a small tinted
// icon chip, a muted mono label, and a large display value.
function HistoryStatCard({ icon: Icon, label, value, tone = 'ink', active, onClick }) {
  const TONE = {
    ink: { chip: 'bg-ink-100 text-ink-500', value: 'text-ink-900' },
    teal: { chip: 'bg-teal-100 text-teal-600', value: 'text-teal-700' },
    red: { chip: 'bg-red-100 text-red-600', value: 'text-red-700' },
    amber: { chip: 'bg-amber-100 text-amber-600', value: 'text-amber-700' },
  }
  const t = TONE[tone] || TONE.ink
  const content = (
    <Card
      className={cn(
        'border-ink-100 p-4 shadow-sm transition',
        onClick && 'hover:border-ink-200 hover:shadow-md',
        active && 'ring-2 ring-offset-1',
        active && tone === 'teal' && 'ring-teal-400',
        active && tone === 'red' && 'ring-red-400',
        active && tone === 'amber' && 'ring-amber-400',
        active && tone === 'ink' && 'ring-ink-300'
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', t.chip)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="truncate font-mono text-[10px] uppercase tracking-wide text-ink-400">{label}</p>
      </div>
      <p className={cn('mt-1.5 font-display text-2xl font-semibold', t.value)}>{value}</p>
    </Card>
  )

  if (!onClick) return content
  return (
    <button onClick={onClick} className="text-left">
      {content}
    </button>
  )
}

export default function ApproverHistory() {
  const { role, loading: profileLoading, error: profileError } = useProfile()
  const authorized = hasRole(role, ALLOWED_ROLES)

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)

  // Date range defaults to the last 30 days — adjustable, re-queries the DB.
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return toDateInputValue(d)
  })
  const [dateTo, setDateTo] = useState(() => toDateInputValue(new Date()))

  // Client-side filters (applied in-memory to the fetched window).
  const [search, setSearch] = useState('')
  const [decisionFilter, setDecisionFilter] = useState(() => new Set(DECISION_ACTIONS)) // all on by default
  const [collectorFilter, setCollectorFilter] = useState('')
  const [verifierFilter, setVerifierFilter] = useState('')
  const [arFilter, setArFilter] = useState('any') // 'any' | 'yes' | 'no' | 'blank'
  const [sortBy, setSortBy] = useState('decided_desc')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [expandedRowId, setExpandedRowId] = useState(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const isMountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const searchInputRef = useRef(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const load = useCallback(
    async (showFullLoading) => {
      const requestId = ++requestIdRef.current
      if (showFullLoading) setLoading(true)
      else setRefreshing(true)
      setLoadError('')

      try {
        const fromIso = new Date(`${dateFrom}T00:00:00`).toISOString()
        const toIso = new Date(`${dateTo}T23:59:59.999`).toISOString()

        const { data, error } = await supabase
          .from('check_activity_log')
          .select(
            'id, check_id, reservation_id, collector_name, action, or_no, ar_collected, remarks, performed_at, submitted_by_name, approved_by_name, checks(id, row_number, payee, payor, check_no, check_date, amount)'
          )
          .in('action', ['submitted_for_approval', ...DECISION_ACTIONS])
          .gte('performed_at', fromIso)
          .lte('performed_at', toIso)
          .order('performed_at', { ascending: true })
          .limit(FETCH_LIMIT)

        if (!isMountedRef.current || requestId !== requestIdRef.current) return

        if (error) {
          setLoadError(error.message || 'Failed to load approval history. Please try again.')
          return
        }

        setRows(buildDecisionRows(data || []))
        setLastUpdated(Date.now())
        setPage(1)
      } catch (err) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) return
        setLoadError(err?.message || 'Failed to load approval history. Please try again.')
      } finally {
        if (isMountedRef.current && requestId === requestIdRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [dateFrom, dateTo]
  )

  useEffect(() => {
    if (!profileLoading && authorized) load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileLoading, authorized])

  function toggleDecisionFilter(action) {
    setDecisionFilter((prev) => {
      const next = new Set(prev)
      if (next.has(action)) next.delete(action)
      else next.add(action)
      return next
    })
    setPage(1)
  }

  // Clicking a KPI card isolates that decision type; clicking it again
  // restores the full set. Mirrors the "quick filter" affordance on
  // ApproverHome's stat cards.
  function isolateDecision(action) {
    setDecisionFilter((prev) => {
      if (prev.size === 1 && prev.has(action)) return new Set(DECISION_ACTIONS)
      return new Set([action])
    })
    setPage(1)
  }

  const collectorOptions = useMemo(
    () => [...new Set(rows.map((r) => r.collectorName).filter(Boolean))].sort(),
    [rows]
  )
  const verifierOptions = useMemo(
    () => [...new Set(rows.map((r) => r.verifiedByName).filter(Boolean))].sort(),
    [rows]
  )

  const filteredRows = useMemo(() => {
    const term = search.trim()
    let list = rows.filter((r) => decisionFilter.has(r.decision))
    if (term) list = list.filter((r) => matchesSearch(r, term))
    if (collectorFilter) list = list.filter((r) => r.collectorName === collectorFilter)
    if (verifierFilter) list = list.filter((r) => r.verifiedByName === verifierFilter)
    if (arFilter === 'yes') list = list.filter((r) => r.ar_collected === true)
    else if (arFilter === 'no') list = list.filter((r) => r.ar_collected === false)
    else if (arFilter === 'blank') list = list.filter((r) => r.ar_collected === null || r.ar_collected === undefined)

    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case 'decided_asc':
          return new Date(a.decidedAt || 0) - new Date(b.decidedAt || 0)
        case 'sent_desc':
          return new Date(b.sentAt || 0) - new Date(a.sentAt || 0)
        case 'sent_asc':
          return new Date(a.sentAt || 0) - new Date(b.sentAt || 0)
        case 'amount_desc':
          return (Number(b.amount) || 0) - (Number(a.amount) || 0)
        case 'amount_asc':
          return (Number(a.amount) || 0) - (Number(b.amount) || 0)
        case 'collector_asc':
          return String(a.collectorName || '').localeCompare(String(b.collectorName || ''))
        case 'decided_desc':
        default:
          return new Date(b.decidedAt || 0) - new Date(a.decidedAt || 0)
      }
    })

    return list
  }, [rows, search, decisionFilter, collectorFilter, verifierFilter, arFilter, sortBy])

  const summary = useMemo(() => {
    const approved = filteredRows.filter((r) => r.decision === 'approved')
    const rejected = filteredRows.filter((r) => r.decision === 'rejected')
    const returned = filteredRows.filter((r) => r.decision === 'returned')
    return {
      total: filteredRows.length,
      approved: approved.length,
      rejected: rejected.length,
      returned: returned.length,
      approvedValue: approved.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    }
  }, [filteredRows])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const clampedPage = Math.min(page, totalPages)
  const pageRows = useMemo(
    () => filteredRows.slice((clampedPage - 1) * pageSize, clampedPage * pageSize),
    [filteredRows, clampedPage, pageSize]
  )

  function clearFilters() {
    setSearch('')
    setDecisionFilter(new Set(DECISION_ACTIONS))
    setCollectorFilter('')
    setVerifierFilter('')
    setArFilter('any')
    setPage(1)
  }

  const hasActiveFilters =
    !!search.trim() ||
    decisionFilter.size !== DECISION_ACTIONS.length ||
    !!collectorFilter ||
    !!verifierFilter ||
    arFilter !== 'any'

  function exportCsv() {
    const headers = [
      'Decision',
      'Collector',
      'Check no.',
      'Payee',
      'Payor',
      'Check date',
      'Amount',
      'OR no.',
      'AR collected',
      'Remarks',
      'Sent for approval by',
      'Sent for approval at',
      'Verified by',
      'Decided at',
      'Time to decision',
    ]
    const csvRows = [headers]
    filteredRows.forEach((r) => {
      csvRows.push([
        DECISION_META[r.decision]?.label || r.decision,
        r.collectorName || '',
        r.check_no || '',
        r.payee || '',
        r.payor || '',
        r.check_date || '',
        r.amount ?? '',
        r.or_no || '',
        r.ar_collected === null || r.ar_collected === undefined ? '' : r.ar_collected ? 'Yes' : 'No',
        r.remarks || '',
        r.sentByName || '',
        r.sentAt || '',
        r.verifiedByName || '',
        r.decidedAt || '',
        durationLabel(r.sentAt, r.decidedAt) || '',
      ])
    })
    const csv = csvRows
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
    a.download = `approval-history-${dateFrom}-to-${dateTo}.csv`
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
    return <ErrorState message={profileError} />
  }
  if (!authorized) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-red-200 bg-red-50/40 px-4 py-16 text-center">
        <ShieldCheck className="h-8 w-8 text-red-300" />
        <p className="mt-3 text-lg font-semibold text-ink-700">You don't have access to this page</p>
        <p className="mt-1 max-w-sm text-sm text-ink-400">
          Viewing approval history requires the approver or admin role.
        </p>
      </div>
    )
  }

  return (
    <div className="pb-20 sm:pb-0">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Approval history</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">
            Full audit trail for every check that's gone through approval — who submitted it, who
            verified it, what they decided, and when each step happened.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="hidden text-xs text-ink-400 sm:inline">
              Updated {Math.round((Date.now() - lastUpdated) / 1000)}s ago
            </span>
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

      {/* Date range — the only filter that re-queries the DB; everything
          else below filters in-memory over this window. */}
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-ink-100 bg-ink-50/40 p-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">From</label>
          <input
            type="date"
            value={dateFrom}
            max={dateTo}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">To</label>
          <input
            type="date"
            value={dateTo}
            min={dateFrom}
            max={toDateInputValue(new Date())}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
        </div>
        <button
          onClick={() => load(true)}
          className="rounded-md bg-ink-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-ink-800"
        >
          Apply range
        </button>
      </div>

      {/* KPI cards — same treatment as the approver home dashboard: a
          tinted icon chip, a muted mono label, and a large value. Each
          decision card doubles as a quick filter. */}
      {!loading && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:max-w-3xl sm:grid-cols-5">
          <HistoryStatCard icon={ClipboardList} label="Decisions" value={summary.total} tone="ink" />
          <HistoryStatCard
            icon={Check}
            label="Approved"
            value={summary.approved}
            tone="teal"
            active={decisionFilter.size === 1 && decisionFilter.has('approved')}
            onClick={() => isolateDecision('approved')}
          />
          <HistoryStatCard
            icon={XCircle}
            label="Rejected"
            value={summary.rejected}
            tone="red"
            active={decisionFilter.size === 1 && decisionFilter.has('rejected')}
            onClick={() => isolateDecision('rejected')}
          />
          <HistoryStatCard
            icon={RotateCcw}
            label="Returned"
            value={summary.returned}
            tone="amber"
            active={decisionFilter.size === 1 && decisionFilter.has('returned')}
            onClick={() => isolateDecision('returned')}
          />
          <HistoryStatCard icon={Wallet} label="Approved value" value={formatCurrency(summary.approvedValue)} tone="ink" />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            placeholder="Search collector, check #, payee, payor, OR no., remarks, names..."
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

        <button
          onClick={() => setFiltersOpen((v) => !v)}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-ink-50',
            hasActiveFilters ? 'border-teal-400 text-teal-700' : 'border-ink-200 text-ink-600'
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {hasActiveFilters && <span className="rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">on</span>}
        </button>

        <div className="relative shrink-0">
          <button
            onClick={() => setSortMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50"
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            {activeSortLabel}
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
          onClick={exportCsv}
          disabled={filteredRows.length === 0}
          className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          Export report ({filteredRows.length})
        </button>
      </div>

      {filtersOpen && (
        <Card className="mb-4 border-ink-100 p-4 shadow-sm">
          <div className="flex flex-wrap items-start gap-6">
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">Decision</p>
              <div className="flex gap-1.5">
                {DECISION_ACTIONS.map((action) => {
                  const meta = DECISION_META[action]
                  const Icon = meta.icon
                  const active = decisionFilter.has(action)
                  return (
                    <button
                      key={action}
                      onClick={() => toggleDecisionFilter(action)}
                      className={cn(
                        'flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
                        active ? 'border-ink-300 bg-ink-900 text-white' : 'border-ink-200 text-ink-500 hover:bg-ink-50'
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {meta.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">Collector</p>
              <select
                value={collectorFilter}
                onChange={(e) => {
                  setCollectorFilter(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                <option value="">All collectors</option>
                {collectorOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">Verified by</p>
              <select
                value={verifierFilter}
                onChange={(e) => {
                  setVerifierFilter(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                <option value="">All verifiers</option>
                {verifierOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">AR collected</p>
              <select
                value={arFilter}
                onChange={(e) => {
                  setArFilter(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                <option value="any">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
                <option value="blank">Not applicable</option>
              </select>
            </div>

            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="ml-auto self-end rounded-md px-3 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50"
              >
                Clear all filters
              </button>
            )}
          </div>
        </Card>
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
      ) : filteredRows.length === 0 ? (
        <EmptyState hasFilter={hasActiveFilters || !!search.trim()} />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-ink-100 shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-ink-100 bg-ink-50/70 text-left text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="px-4 py-3 font-medium">Decision</th>
                    <th className="px-4 py-3 font-medium">Collector &amp; check</th>
                    <th className="px-4 py-3 font-medium">Payee</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 font-medium">OR / AR</th>
                    <th className="px-4 py-3 font-medium">Sent → Verified</th>
                    <th className="px-4 py-3 font-medium">Turnaround</th>
                    <th className="w-9 px-3 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {pageRows.map((r) => {
                    const meta = DECISION_META[r.decision]
                    const Icon = meta.icon
                    const isExpanded = expandedRowId === r.id
                    return (
                      <React.Fragment key={r.id}>
                        <tr
                          className={cn(
                            'cursor-pointer border-l-[3px] border-l-transparent align-top transition-colors hover:bg-ink-50/50',
                            meta.accent
                          )}
                          onClick={() => setExpandedRowId(isExpanded ? null : r.id)}
                        >
                          <td className="px-4 py-4">
                            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', meta.badge)}>
                              <Icon className="h-3 w-3" />
                              {meta.label}
                            </span>
                          </td>

                          <td className="px-4 py-4">
                            <div className="flex items-center gap-2.5">
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-100 text-[10px] font-semibold text-ink-500">
                                {initials(r.collectorName)}
                              </span>
                              <div className="min-w-0">
                                <p className="truncate font-medium text-ink-900">{r.collectorName || '—'}</p>
                                <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-400">
                                  <Hash className="h-3 w-3" />
                                  <span className="font-mono">{r.check_no || '—'}</span>
                                  {r.check_date && (
                                    <span className="flex items-center gap-1 before:mx-1 before:content-['·']">
                                      <CalendarDays className="h-3 w-3" />
                                      {formatDate(r.check_date)}
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>
                          </td>

                          <td className="max-w-[200px] px-4 py-4">
                            <p className="truncate font-medium text-ink-900">{r.payee || '—'}</p>
                            <p className="truncate text-xs text-ink-400">from {r.payor || '—'}</p>
                          </td>

                          <td className="px-4 py-4 text-right font-mono font-semibold text-ink-800">
                            {formatCurrency(r.amount)}
                          </td>

                          <td className="px-4 py-4">
                            <p className="font-mono text-xs text-ink-700">{r.or_no || 'No OR no.'}</p>
                            {r.ar_collected === null || r.ar_collected === undefined ? (
                              <p className="mt-0.5 text-xs text-ink-300">AR n/a</p>
                            ) : r.ar_collected ? (
                              <p className="mt-0.5 text-xs font-medium text-teal-600">AR collected</p>
                            ) : (
                              <p className="mt-0.5 text-xs font-medium text-orange-600">AR not collected</p>
                            )}
                          </td>

                          <td className="px-4 py-4">
                            <div className="flex items-center gap-2 text-xs">
                              <div className="min-w-0 max-w-[110px]">
                                <p className="truncate font-medium text-ink-700">{r.sentByName || '—'}</p>
                                <p className="truncate text-ink-400">{fmtDateTime(r.sentAt) || 'Unknown'}</p>
                              </div>
                              <ChevronRight className="h-3 w-3 shrink-0 text-ink-300" />
                              <div className="min-w-0 max-w-[110px]">
                                <p className="flex items-center gap-1 truncate font-medium text-ink-700">
                                  <UserCheck className="h-3 w-3 shrink-0 text-ink-300" />
                                  {r.verifiedByName || '—'}
                                </p>
                                <p className="truncate text-ink-400">{fmtDateTime(r.decidedAt) || '—'}</p>
                              </div>
                            </div>
                          </td>

                          <td className="px-4 py-4 text-xs font-medium text-ink-500">
                            {durationLabel(r.sentAt, r.decidedAt) || '—'}
                          </td>

                          <td className="px-3 py-4 text-right">
                            <span className="inline-flex text-ink-300">
                              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </span>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={8} className="bg-ink-50/40 px-4 pb-4 pt-0">
                              <div className="rounded-lg border border-ink-100 bg-white px-4 py-3">
                                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-400">
                                  Remarks at time of {meta.label.toLowerCase()}
                                </p>
                                <p className="whitespace-pre-wrap text-sm text-ink-700">
                                  {r.remarks?.trim() ? r.remarks : 'No remarks were entered for this decision.'}
                                </p>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-ink-500">
              <span>
                Showing {(clampedPage - 1) * pageSize + 1}–{Math.min(clampedPage * pageSize, filteredRows.length)} of{' '}
                {filteredRows.length}
              </span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value))
                  setPage(1)
                }}
                className="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-600 focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={clampedPage <= 1}
                className="flex items-center gap-1 rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Prev
              </button>
              <span className="text-xs text-ink-500">
                Page {clampedPage} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={clampedPage >= totalPages}
                className="flex items-center gap-1 rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ErrorState({ message }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-orange-200 bg-orange-50/40 px-4 py-16 text-center">
      <AlertTriangle className="h-8 w-8 text-orange-300" />
      <p className="mt-3 text-lg font-semibold text-ink-700">Couldn't load this page</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">{message}</p>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg border border-ink-100 bg-ink-50/60" />
      ))}
    </div>
  )
}

function EmptyState({ hasFilter }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-ink-200 px-4 py-16 text-center">
      <Filter className="h-8 w-8 text-ink-200" />
      <p className="mt-3 text-lg font-semibold text-ink-700">
        {hasFilter ? 'No matching records' : 'No decisions in this date range'}
      </p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        {hasFilter ? 'Try different filters or clear them.' : 'Try widening the date range above.'}
      </p>
    </div>
  )
}
