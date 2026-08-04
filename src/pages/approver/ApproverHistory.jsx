// src/pages/approver/ApproverHistory.jsx
//
// Per-approver decision history. Each approver/admin sees only the
// approve/return decisions THEY performed — submission log entries stay
// unfiltered (needed to reconstruct "sent at/by" per check via
// buildDecisionRows), but decision rows are scoped to the current user
// both at the query level (.or on performed_by) and again defensively in
// buildDecisionRows. The real access boundary must be a matching Postgres
// RLS policy on check_activity_log (performed_by = auth.uid() for the
// approver role) — this client-side filter narrows the request, it is
// not the security boundary.
//
// DECISION SCOPE: approver_decide only ever writes 'approved' or
// 'returned' — checks.status has no 'rejected' value in the schema, so
// that legacy action is excluded outright, not just hidden in the UI.
//
// COLLECTOR NAME: free-typed at intake, so raw values drift in casing and
// whitespace ("Juan Dela Cruz" vs "JUAN DELA CRUZ" vs double-spaced).
// normalizeCollectorName() collapses whitespace for display; collectorKey()
// is the case-insensitive identity used for filter dedup and matching, so
// the same person doesn't appear as multiple "different" collectors.
//
// COLLECTOR SOURCE: pickup_reservations.collector_name is fetched
// separately and preferred over checks.collector_name, which gets nulled
// on release/reject and can be overwritten by a later re-reservation.
//
// BANK: check_activity_log never logs bank; it only ever comes from the
// embedded checks row, with no reservation-level fallback.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Stamp, RefreshCw, Search, X, Check, RotateCcw, AlertTriangle, Hash, CalendarDays,
  ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Download, ArrowUp, ArrowDown,
  ArrowUpDown, ShieldAlert, Filter, SlidersHorizontal, ClipboardList, Wallet, Landmark, Lock, WifiOff,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card, CardContent } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import { useProfile, hasRole } from '../../context/ProfileContext'

const ALLOWED_ROLES = ['approver', 'admin']
const FETCH_LIMIT = 2000
const PAGE_SIZE_OPTIONS = [25, 50, 100]
const DECISION_ACTIONS = ['approved', 'returned']
const RETRY_DELAYS_MS = [400, 1200]
const FETCH_TIMEOUT_MS = 20000
const UNKNOWN_BANK_LABEL = 'Unspecified'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const DECISION_META = {
  approved: { label: 'Approved', icon: Check, badge: 'bg-ledger-stamp/10 text-ledger-stampDark', accent: 'border-l-ledger-stamp/60' },
  returned: { label: 'Returned', icon: RotateCcw, badge: 'bg-ledger-amber/10 text-ledger-amber', accent: 'border-l-ledger-amber/60' },
}

function normalizeBank(bank) {
  const trimmed = typeof bank === 'string' ? bank.trim() : ''
  return trimmed || UNKNOWN_BANK_LABEL
}

// Collapses internal whitespace and trims — display value, not an
// identity key. '' (not null) so downstream `|| '—'` fallbacks still work.
function normalizeCollectorName(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim()
}

// Case-insensitive identity for grouping/filtering/dedup — two collector
// strings that only differ by casing or whitespace resolve to one person.
function collectorKey(name) {
  return normalizeCollectorName(name).toLowerCase()
}

const BANK_BADGE_PALETTE = [
  'bg-teal-100 text-teal-700', 'bg-blue-100 text-blue-700', 'bg-purple-100 text-purple-700',
  'bg-amber-100 text-amber-700', 'bg-rose-100 text-rose-700', 'bg-indigo-100 text-indigo-700',
  'bg-cyan-100 text-cyan-700', 'bg-lime-100 text-lime-700',
]

function bankBadgeClass(bank) {
  if (bank === UNKNOWN_BANK_LABEL) return 'bg-ink-100 text-ink-500'
  let hash = 0
  for (let i = 0; i < bank.length; i += 1) hash = (hash * 31 + bank.charCodeAt(i)) >>> 0
  return BANK_BADGE_PALETTE[hash % BANK_BADGE_PALETTE.length]
}

function BankBadge({ bank, className }) {
  const label = normalizeBank(bank)
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', bankBadgeClass(label), className)} title={label}>
      <Landmark className="h-3 w-3 shrink-0" />
      <span className="max-w-[100px] truncate">{label}</span>
    </span>
  )
}

function fmtDateTime(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function durationMs(fromIso, toIso) {
  if (!fromIso || !toIso) return null
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

function durationLabel(ms) {
  if (ms === null || ms === undefined) return null
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hrs < 24) return `${hrs}h ${remMins}m`
  const days = Math.floor(hrs / 24)
  return `${days}d ${hrs % 24}h`
}

function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Preserves legitimate falsy values (false, 0, '') across sources —
// chained `??` can't distinguish "explicitly false" from "missing".
function firstDefined(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined) return v
  }
  return null
}

function classifyError(err) {
  const message = err?.message || String(err || 'Something went wrong')
  if (err?.name === 'AbortError') return { type: 'network', message: 'That took too long to respond. Please try again.' }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { type: 'network', message: "You're offline. Reconnect and try again." }
  if (/failed to fetch|network|timeout|econnreset|502|503|504/i.test(message)) return { type: 'network', message: 'Network error reaching the server. Please try again.' }
  return { type: 'validation', message }
}

// Retries transient failures with backoff under a shared AbortSignal.
// `buildQuery` must construct a fresh query per call — Supabase builders
// execute on await, so re-awaiting one instance won't actually retry.
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

// Reconstructs one row per decision, matched to the "sent for approval"
// submission that preceded it. Walks the log chronologically per check_id
// so a check returned and resubmitted multiple times matches correctly
// each time. `currentUserId` is enforced again here even though the query
// already scopes decisions server-side — defense in depth.
function buildDecisionRows(rawLog, reservationsById, currentUserId) {
  const lastSubmissionByCheck = new Map()
  const rows = []
  const orphanedDecisions = []

  const sorted = [...rawLog].sort((a, b) => new Date(a.performed_at) - new Date(b.performed_at))

  sorted.forEach((entry) => {
    if (entry.action === 'submitted_for_approval') {
      lastSubmissionByCheck.set(entry.check_id, entry)
      return
    }
    if (!DECISION_ACTIONS.includes(entry.action)) return
    if (entry.performed_by !== currentUserId) return

    const submission = lastSubmissionByCheck.get(entry.check_id)
    const c = entry.checks || {}
    const reservation = reservationsById?.get(entry.reservation_id) || null

    if (!submission) {
      orphanedDecisions.push({ checkId: entry.check_id, action: entry.action, performedAt: entry.performed_at })
    }

    const sentAt = firstDefined(submission?.performed_at, c.submitted_at)
    const decidedAt = entry.performed_at

    rows.push({
      id: entry.id,
      checkId: entry.check_id,
      reservationId: entry.reservation_id,
      decision: entry.action,
      collectorName: normalizeCollectorName(firstDefined(reservation?.collector_name, entry.collector_name, submission?.collector_name, c.collector_name)),
      or_no: firstDefined(entry.or_no, submission?.or_no, c.or_no),
      ar_collected: firstDefined(entry.ar_collected, submission?.ar_collected, c.ar_collected),
      bank: c.bank,
      row_number: c.row_number,
      payee: c.payee,
      payor: c.payor,
      check_no: c.check_no,
      check_date: c.check_date,
      amount: c.amount,
      remarks: entry.remarks,
      sentAt,
      sentByName: firstDefined(submission?.submitted_by_name, entry.submitted_by_name, c.submitted_by_name),
      decidedAt,
      turnaroundMs: durationMs(sentAt, decidedAt),
    })

    lastSubmissionByCheck.delete(entry.check_id)
  })

  // Orphaned decision = a write path logged approve/return without ever
  // logging submitted_for_approval first. The checks.submitted_at fallback
  // above avoids a blank cell but can't recover the exact historical value
  // if that check has since been resubmitted again.
  if (orphanedDecisions.length > 0 && import.meta.env?.DEV) {
    console.warn(
      `[ApproverHistory] ${orphanedDecisions.length} decision(s) have no matching submitted_for_approval entry — "Sent by/at" filled from the live checks row as a best-effort fallback.`,
      orphanedDecisions
    )
  }

  return rows
}

function matchesSearch(row, term) {
  if (!term) return true
  const needle = term.toLowerCase()
  return [row.collectorName, row.payee, row.payor, row.check_no, row.or_no, row.remarks, row.sentByName, row.bank]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(needle))
}

function toDateInputValue(d) {
  return d.toISOString().slice(0, 10)
}

// --- Column-header sorting: one accessor + type per column, so every
// column sorts through the same generic, type-aware comparator below
// instead of a bespoke switch statement per field. Nulls always sort
// last regardless of direction — a missing "sent at" shouldn't visually
// masquerade as the earliest timestamp.
const COLUMN_ACCESSORS = {
  decision: (r) => DECISION_META[r.decision]?.label || r.decision,
  collector: (r) => r.collectorName || '',
  bank: (r) => normalizeBank(r.bank),
  check_no: (r) => r.check_no || '',
  check_date: (r) => (r.check_date ? new Date(r.check_date).getTime() : null),
  payee: (r) => r.payee || '',
  payor: (r) => r.payor || '',
  amount: (r) => Number(r.amount) || 0,
  or_no: (r) => r.or_no || '',
  ar_collected: (r) => (r.ar_collected === true ? 2 : r.ar_collected === false ? 1 : null),
  sentByName: (r) => r.sentByName || '',
  sentAt: (r) => (r.sentAt ? new Date(r.sentAt).getTime() : null),
  decidedAt: (r) => (r.decidedAt ? new Date(r.decidedAt).getTime() : null),
  turnaround: (r) => r.turnaroundMs,
}

const COLUMN_TYPES = {
  decision: 'string', collector: 'string', bank: 'string', check_no: 'string',
  check_date: 'number', payee: 'string', payor: 'string', amount: 'number',
  or_no: 'string', ar_collected: 'number', sentByName: 'string', sentAt: 'number',
  decidedAt: 'number', turnaround: 'number',
}

function compareRows(a, b, key, dir) {
  const accessor = COLUMN_ACCESSORS[key]
  if (!accessor) return 0
  const av = accessor(a)
  const bv = accessor(b)
  const type = COLUMN_TYPES[key]

  let cmp
  if (type === 'number') {
    if (av === null && bv === null) cmp = 0
    else if (av === null) return 1
    else if (bv === null) return -1
    else cmp = av - bv
  } else {
    cmp = String(av).localeCompare(String(bv))
  }
  return dir === 'asc' ? cmp : -cmp
}

export default function ApproverHistory() {
  const { id: myId, role, loading: profileLoading, error: profileError } = useProfile()
  const authorized = hasRole(role, ALLOWED_ROLES)
  const canQuery = authorized && Boolean(myId)

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return toDateInputValue(d)
  })
  const [dateTo, setDateTo] = useState(() => toDateInputValue(new Date()))

  const [search, setSearch] = useState('')
  const [decisionFilter, setDecisionFilter] = useState(() => new Set(DECISION_ACTIONS))
  const [collectorFilter, setCollectorFilter] = useState('') // stores a collectorKey, '' = all
  const [bankFilter, setBankFilter] = useState('')
  const [arFilter, setArFilter] = useState('any')
  const [sortKey, setSortKey] = useState('decidedAt')
  const [sortDir, setSortDir] = useState('desc')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [expandedRowId, setExpandedRowId] = useState(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const isMountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const abortControllerRef = useRef(null)
  const searchInputRef = useRef(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      abortControllerRef.current?.abort()
    }
  }, [])

  const load = useCallback(
    async (showFullLoading) => {
      if (!canQuery) return
      const requestId = ++requestIdRef.current

      abortControllerRef.current?.abort()
      const controller = new AbortController()
      abortControllerRef.current = controller
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      if (showFullLoading) setLoading(true)
      else setRefreshing(true)
      setLoadError(null)

      try {
        const fromIso = new Date(`${dateFrom}T00:00:00`).toISOString()
        const toIso = new Date(`${dateTo}T23:59:59.999`).toISOString()

        const buildLogQuery = () =>
          supabase
            .from('check_activity_log')
            .select(
              'id, check_id, reservation_id, collector_name, action, or_no, ar_collected, remarks, performed_at, performed_by, submitted_by_name, checks(id, row_number, payee, payor, check_no, check_date, amount, collector_name, or_no, ar_collected, bank, submitted_by_name, submitted_at)'
            )
            .in('action', ['submitted_for_approval', ...DECISION_ACTIONS])
            .gte('performed_at', fromIso)
            .lte('performed_at', toIso)
            // Submissions unfiltered (needed to reconstruct sent-at/by);
            // decision rows scoped to the current user server-side. A
            // matching RLS policy on check_activity_log is the real
            // boundary — this narrows the request, it doesn't secure it.
            .or(`action.eq.submitted_for_approval,performed_by.eq.${myId}`)
            .order('performed_at', { ascending: true })
            .limit(FETCH_LIMIT)
            .abortSignal(controller.signal)

        const { data } = await runSupabaseQuery(buildLogQuery, controller.signal)
        if (!isMountedRef.current || requestId !== requestIdRef.current) return

        const rawLog = data || []
        const reservationIds = [...new Set(rawLog.map((r) => r.reservation_id).filter(Boolean))]
        let reservationsById = new Map()

        if (reservationIds.length > 0) {
          try {
            const buildReservationsQuery = () =>
              supabase.from('pickup_reservations').select('id, collector_name').in('id', reservationIds).abortSignal(controller.signal)
            const { data: reservationsData } = await runSupabaseQuery(buildReservationsQuery, controller.signal)
            if (!isMountedRef.current || requestId !== requestIdRef.current) return
            reservationsById = new Map((reservationsData || []).map((r) => [r.id, r]))
          } catch (reservationsErr) {
            // Non-fatal: rows still render without the reservation-level
            // collector-name fallback until the next successful refresh.
            console.error('pickup_reservations lookup for history failed:', reservationsErr)
          }
        }

        setRows(buildDecisionRows(rawLog, reservationsById, myId))
        setLastUpdated(Date.now())
        setPage(1)
      } catch (err) {
        if (err?.name === 'AbortError' || controller.signal.aborted) return
        if (!isMountedRef.current || requestId !== requestIdRef.current) return
        setLoadError(classifyError(err))
      } finally {
        clearTimeout(timeoutId)
        if (abortControllerRef.current === controller) abortControllerRef.current = null
        if (isMountedRef.current && requestId === requestIdRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [dateFrom, dateTo, canQuery, myId]
  )

  useEffect(() => {
    if (!profileLoading && canQuery) load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileLoading, canQuery])

  function toggleDecisionFilter(action) {
    setDecisionFilter((prev) => {
      const next = new Set(prev)
      next.has(action) ? next.delete(action) : next.add(action)
      return next
    })
    setPage(1)
  }

  function isolateDecision(action) {
    setDecisionFilter((prev) => (prev.size === 1 && prev.has(action) ? new Set(DECISION_ACTIONS) : new Set([action])))
    setPage(1)
  }

  function handleSort(key) {
    setSortKey((prevKey) => {
      setSortDir((prevDir) => (prevKey === key ? (prevDir === 'asc' ? 'desc' : 'asc') : 'desc'))
      return key
    })
  }

  const today = useMemo(() => toDateInputValue(new Date()), [])

  function handleFromChange(value) {
    if (!value) return setDateFrom(value)
    const clamped = value > today ? today : value
    setDateFrom(clamped > dateTo ? dateTo : clamped)
  }

  function handleToChange(value) {
    if (!value) return setDateTo(value)
    const clamped = value > today ? today : value
    setDateTo(clamped < dateFrom ? dateFrom : clamped)
  }

  // Deduped by collectorKey so casing/whitespace variants of the same
  // person collapse into one filter option instead of several.
  const collectorOptions = useMemo(() => {
    const map = new Map()
    rows.forEach((r) => {
      if (!r.collectorName) return
      const key = collectorKey(r.collectorName)
      if (!map.has(key)) map.set(key, r.collectorName)
    })
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => ({ key, label }))
  }, [rows])

  const bankOptions = useMemo(() => {
    const set = new Set(rows.map((r) => normalizeBank(r.bank)))
    return [...set].sort((a, b) => {
      if (a === UNKNOWN_BANK_LABEL) return 1
      if (b === UNKNOWN_BANK_LABEL) return -1
      return a.localeCompare(b)
    })
  }, [rows])

  const filteredRows = useMemo(() => {
    const term = search.trim()
    let list = rows.filter((r) => decisionFilter.has(r.decision))
    if (term) list = list.filter((r) => matchesSearch(r, term))
    if (collectorFilter) list = list.filter((r) => collectorKey(r.collectorName) === collectorFilter)
    if (bankFilter) list = list.filter((r) => normalizeBank(r.bank) === bankFilter)
    if (arFilter === 'yes') list = list.filter((r) => r.ar_collected === true)
    else if (arFilter === 'no') list = list.filter((r) => r.ar_collected === false)
    else if (arFilter === 'blank') list = list.filter((r) => r.ar_collected === null || r.ar_collected === undefined)

    return [...list].sort((a, b) => compareRows(a, b, sortKey, sortDir))
  }, [rows, search, decisionFilter, collectorFilter, bankFilter, arFilter, sortKey, sortDir])

  const summary = useMemo(() => {
    const approved = filteredRows.filter((r) => r.decision === 'approved')
    const returned = filteredRows.filter((r) => r.decision === 'returned')
    return {
      total: filteredRows.length,
      approved: approved.length,
      returned: returned.length,
      approvedValue: approved.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    }
  }, [filteredRows])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const clampedPage = Math.min(page, totalPages)
  const pageRows = useMemo(() => filteredRows.slice((clampedPage - 1) * pageSize, clampedPage * pageSize), [filteredRows, clampedPage, pageSize])

  function clearFilters() {
    setSearch('')
    setDecisionFilter(new Set(DECISION_ACTIONS))
    setCollectorFilter('')
    setBankFilter('')
    setArFilter('any')
    setPage(1)
  }

  const hasActiveFilters = Boolean(search.trim()) || decisionFilter.size !== DECISION_ACTIONS.length || Boolean(collectorFilter) || Boolean(bankFilter) || arFilter !== 'any'

  function exportCsv() {
    const headers = ['Decision', 'Collector', 'Bank', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'OR no.', 'AR collected', 'Remarks', 'Sent for approval by', 'Sent for approval at', 'Decided at', 'Time to decision']
    const csvRows = [headers]
    filteredRows.forEach((r) => {
      csvRows.push([
        DECISION_META[r.decision]?.label || r.decision,
        r.collectorName || '',
        normalizeBank(r.bank),
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
        r.decidedAt || '',
        durationLabel(r.turnaroundMs) || '',
      ])
    })
    const csv = csvRows
      .map((row) => row.map((cell) => {
        const str = String(cell ?? '')
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
      }).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `my-approval-history-${dateFrom}-to-${dateTo}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const pctOfTotal = (n) => (summary.total > 0 ? Math.round((n / summary.total) * 100) : null)

  if (profileLoading) return <div className="flex min-h-[40vh] items-center justify-center text-sm text-ink-300">Loading…</div>
  if (profileError) return <ProfileLoadError error={profileError} />
  if (!authorized) return <AccessDenied />
  if (!myId) return <NoAccountLinked />

  return (
    <div className="pb-20 sm:pb-0">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
        
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ledger-stampDark/80">Your decision history</p>
            <h1 className="font-display text-2xl font-semibold text-ink-900">Approval history</h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-400">Every check you've decided on — what you approved or returned, and when.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="hidden font-mono text-[11px] text-ink-300 sm:inline">Updated {Math.round((Date.now() - lastUpdated) / 1000)}s ago</span>}
          <button onClick={() => load(false)} disabled={refreshing || loading} className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-50">
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {!loading && (
        <>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-300">Decision summary</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard icon={ClipboardList} label="Decisions" value={summary.total} secondary={`${formatDate(dateFrom)} – ${formatDate(dateTo)}`} accent="ink" />
            <KpiCard icon={Check} label="Approved" value={summary.approved} secondary={pctOfTotal(summary.approved) !== null ? `${pctOfTotal(summary.approved)}% of decisions` : null} accent="stamp" active={decisionFilter.size === 1 && decisionFilter.has('approved')} onClick={() => isolateDecision('approved')} />
            <KpiCard icon={RotateCcw} label="Returned" value={summary.returned} secondary={pctOfTotal(summary.returned) !== null ? `${pctOfTotal(summary.returned)}% of decisions` : null} accent="amber" active={decisionFilter.size === 1 && decisionFilter.has('returned')} onClick={() => isolateDecision('returned')} />
            <KpiCard icon={Wallet} label="Approved value" value={formatCurrency(summary.approvedValue)} secondary={`${summary.approved} approved check${summary.approved === 1 ? '' : 's'}`} accent="stamp" />
          </div>
        </>
      )}

      <div className="mb-3 mt-5 flex flex-wrap items-end gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search collector, bank, check #, payee, payor, OR no., remarks..."
            className="border-ink-200 pl-9 pr-8 text-sm focus-visible:ring-ledger-stamp"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600" aria-label="Clear search">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div>
          <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">From</label>
          <input type="date" value={dateFrom} max={today} onChange={(e) => handleFromChange(e.target.value)} className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp" />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">To</label>
          <input type="date" value={dateTo} min={dateFrom} max={today} onChange={(e) => handleToChange(e.target.value)} className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp" />
        </div>
        <button onClick={() => load(true)} className="rounded-md bg-ink-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-ink-800">
          Apply range
        </button>

        <button onClick={() => setFiltersOpen((v) => !v)} className={cn('flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-ink-50', hasActiveFilters ? 'border-ledger-stamp/50 text-ledger-stampDark' : 'border-ink-200 text-ink-600')}>
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {hasActiveFilters && <span className="rounded-full bg-ledger-stampDark px-1.5 py-0.5 text-[10px] font-semibold text-white">on</span>}
        </button>

        <button onClick={exportCsv} disabled={filteredRows.length === 0} className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">
          <Download className="h-3.5 w-3.5" />
          Export ({filteredRows.length})
        </button>
      </div>

      {filtersOpen && (
        <Card className="mb-4 border-ink-100 p-4 shadow-sm">
          <div className="flex flex-wrap items-start gap-6">
            <div>
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">Decision</p>
              <div className="flex gap-1.5">
                {DECISION_ACTIONS.map((action) => {
                  const meta = DECISION_META[action]
                  const Icon = meta.icon
                  const active = decisionFilter.has(action)
                  return (
                    <button key={action} onClick={() => toggleDecisionFilter(action)} className={cn('flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition', active ? 'border-ink-300 bg-ink-900 text-white' : 'border-ink-200 text-ink-500 hover:bg-ink-50')}>
                      <Icon className="h-3.5 w-3.5" />
                      {meta.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">Collector</p>
              <select value={collectorFilter} onChange={(e) => { setCollectorFilter(e.target.value); setPage(1) }} className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp">
                <option value="">All collectors</option>
                {collectorOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>

            <div>
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">Bank</p>
              <select value={bankFilter} onChange={(e) => { setBankFilter(e.target.value); setPage(1) }} className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp">
                <option value="">All banks</option>
                {bankOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>

            <div>
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">AR collected</p>
              <select value={arFilter} onChange={(e) => { setArFilter(e.target.value); setPage(1) }} className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp">
                <option value="any">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
                <option value="blank">Not applicable</option>
              </select>
            </div>

            {hasActiveFilters && (
              <button onClick={clearFilters} className="ml-auto self-end rounded-md px-3 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50">
                Clear all filters
              </button>
            )}
          </div>
        </Card>
      )}

      {loadError && (
        <div className={cn('mb-4 flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm', loadError.type === 'network' ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-red-200 bg-red-50 text-red-700')}>
          <span className="flex items-center gap-2">
            {loadError.type === 'network' ? <WifiOff className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
            {loadError.message}
          </span>
          <button onClick={() => load(loading)} className="shrink-0 rounded-md border border-current px-3 py-1 text-xs font-medium hover:bg-white/50">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <ListSkeleton />
      ) : filteredRows.length === 0 ? (
        <EmptyState hasFilter={hasActiveFilters || Boolean(search.trim())} />
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-dashed border-ink-100 bg-ink-50/50 px-5 py-3.5">
              <div>
                <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink-900">
                  <ClipboardList className="h-4 w-4 text-ledger-stampDark" />
                  Decision records
                </h2>
                <p className="mt-0.5 text-xs text-ink-400">One row per decision you made — click any column header to sort.</p>
              </div>
              <span className="hidden shrink-0 font-mono text-[11px] text-ink-400 sm:inline">{filteredRows.length} record{filteredRows.length === 1 ? '' : 's'}</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1500px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-dashed border-ink-100 bg-ink-50/50 text-left font-mono text-[11px] uppercase tracking-wide text-ink-400">
                    <SortHeader label="Decision" sortKey="decision" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Collector" sortKey="collector" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Bank" sortKey="bank" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Check no." sortKey="check_no" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Check date" sortKey="check_date" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Payee" sortKey="payee" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Payor" sortKey="payor" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Amount" sortKey="amount" active={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    <SortHeader label="OR no." sortKey="or_no" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="AR collected" sortKey="ar_collected" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Sent by" sortKey="sentByName" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Sent at" sortKey="sentAt" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Decided at" sortKey="decidedAt" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortHeader label="Turnaround" sortKey="turnaround" active={sortKey} dir={sortDir} onSort={handleSort} />
                    <th className="w-9 px-3 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-dashed divide-ink-100">
                  {pageRows.map((r) => {
                    const meta = DECISION_META[r.decision]
                    const Icon = meta.icon
                    const isExpanded = expandedRowId === r.id
                    return (
                      <React.Fragment key={r.id}>
                        <tr className={cn('cursor-pointer border-l-[3px] border-l-transparent align-top transition-colors hover:bg-ink-50/50', meta.accent)} onClick={() => setExpandedRowId(isExpanded ? null : r.id)}>
                          <td className="px-4 py-4">
                            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', meta.badge)}>
                              <Icon className="h-3 w-3" />
                              {meta.label}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-2">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-50 font-mono text-[10px] font-semibold text-ink-600">{initials(r.collectorName)}</span>
                              <p className="max-w-[120px] truncate font-medium text-ink-900">{r.collectorName || '—'}</p>
                            </div>
                          </td>
                          <td className="px-4 py-4"><BankBadge bank={r.bank} /></td>
                          <td className="px-4 py-4">
                            <span className="flex items-center gap-1 font-mono text-xs text-ink-700">
                              <Hash className="h-3 w-3 text-ink-300" />
                              {r.check_no || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            <span className="flex items-center gap-1 text-xs text-ink-500">
                              <CalendarDays className="h-3 w-3 text-ink-300" />
                              {r.check_date ? formatDate(r.check_date) : '—'}
                            </span>
                          </td>
                          <td className="max-w-[160px] px-4 py-4"><p className="truncate font-medium text-ink-900">{r.payee || '—'}</p></td>
                          <td className="max-w-[140px] px-4 py-4"><p className="truncate text-xs text-ink-500">{r.payor || '—'}</p></td>
                          <td className="px-4 py-4 text-right font-mono font-semibold text-ink-800">{formatCurrency(r.amount)}</td>
                          <td className="px-4 py-4"><span className="font-mono text-xs text-ink-700">{r.or_no || '—'}</span></td>
                          <td className="px-4 py-4">
                            {r.ar_collected === null || r.ar_collected === undefined ? (
                              <span className="text-xs text-ink-300">N/A</span>
                            ) : r.ar_collected ? (
                              <span className="text-xs font-medium text-ledger-stampDark">Yes</span>
                            ) : (
                              <span className="text-xs font-medium text-ledger-amber">No</span>
                            )}
                          </td>
                          <td className="max-w-[130px] px-4 py-4"><p className="truncate text-xs text-ink-700">{r.sentByName || '—'}</p></td>
                          <td className="px-4 py-4"><p className="whitespace-nowrap font-mono text-xs text-ink-400">{fmtDateTime(r.sentAt) || '—'}</p></td>
                          <td className="px-4 py-4"><p className="whitespace-nowrap font-mono text-xs text-ink-400">{fmtDateTime(r.decidedAt) || '—'}</p></td>
                          <td className="px-4 py-4"><span className="font-mono text-xs font-medium text-ink-600">{durationLabel(r.turnaroundMs) || '—'}</span></td>
                          <td className="px-3 py-4 text-right">
                            <span className="inline-flex text-ink-300">{isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={15} className="bg-ink-50/40 px-4 pb-4 pt-0">
                              <div className="rounded-lg border border-dashed border-ink-200 bg-white px-4 py-3">
                                <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-ink-400">Remarks at time of {meta.label.toLowerCase()}</p>
                                <p className="whitespace-pre-wrap text-sm text-ink-700">{r.remarks?.trim() ? r.remarks : 'No remarks were entered for this decision.'}</p>
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
          </Card>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-ink-500">
              <span>Showing {(clampedPage - 1) * pageSize + 1}–{Math.min(clampedPage * pageSize, filteredRows.length)} of {filteredRows.length}</span>
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} className="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-600 focus:outline-none focus:ring-1 focus:ring-ledger-stamp">
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={clampedPage <= 1} className="flex items-center gap-1 rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">
                <ChevronLeft className="h-3.5 w-3.5" />
                Prev
              </button>
              <span className="text-xs text-ink-500">Page {clampedPage} of {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={clampedPage >= totalPages} className="flex items-center gap-1 rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">
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

function SortHeader({ label, sortKey: key, active, dir, onSort, align }) {
  const isActive = active === key
  return (
    <th className={cn('px-4 py-3 font-medium', align === 'right' && 'text-right')}>
      <button
        onClick={() => onSort(key)}
        className={cn('inline-flex items-center gap-1 hover:text-ink-700', align === 'right' && 'flex-row-reverse', isActive && 'text-ledger-stampDark')}
      >
        {label}
        {isActive ? (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </button>
    </th>
  )
}

function KpiCard({ icon: Icon, label, value, secondary, accent, active, onClick }) {
  const accents = {
    stamp: { badge: 'bg-ledger-stamp/10 text-ledger-stampDark', ring: 'border-ledger-stamp/30', active: 'ring-ledger-stamp/40' },
    amber: { badge: 'bg-ledger-amber/10 text-ledger-amber', ring: 'border-ledger-amber/30', active: 'ring-ledger-amber/40' },
    ink: { badge: 'bg-ink-50 text-ink-700', ring: 'border-ink-100', active: 'ring-ink-300' },
  }
  const style = accents[accent] || accents.ink
  const isLoading = value === null || value === undefined

  const content = (
    <CardContent className="relative overflow-hidden p-4">
      <div className={cn('pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed', style.ring)} aria-hidden="true" />
      <div className="relative flex items-start gap-3">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', style.badge)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? <div className="h-6 w-16 animate-pulse rounded bg-ink-100" /> : <p className="truncate font-display text-lg font-semibold text-ink-900">{value}</p>}
          <p className="truncate text-xs text-ink-400">{label}</p>
          {!isLoading && secondary && <p className="mt-0.5 truncate font-mono text-xs text-ink-500">{secondary}</p>}
        </div>
      </div>
    </CardContent>
  )

  const cardClassName = cn(onClick && 'transition hover:border-ink-200 hover:shadow-sm', active && 'ring-2 ring-offset-1', active && style.active)

  if (onClick) return <Card className={cardClassName}><button type="button" onClick={onClick} className="w-full text-left">{content}</button></Card>
  return <Card>{content}</Card>
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
      <p className="mt-1 max-w-sm text-sm text-ink-400">Viewing approval history requires the approver or admin role.</p>
    </div>
  )
}

function NoAccountLinked() {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-amber-200 bg-amber-50/40 px-4 py-16 text-center">
      <Lock className="h-8 w-8 text-amber-300" />
      <p className="mt-3 text-lg font-semibold text-ink-700">Couldn't identify your account</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">Your decision history can't be loaded without a linked account. Try refreshing, or ask an admin to check your profile.</p>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-lg border border-ink-100 bg-ink-50/60" />)}
    </div>
  )
}

function EmptyState({ hasFilter }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-ink-200 px-4 py-16 text-center">
      <Filter className="h-8 w-8 text-ink-200" />
      <p className="mt-3 text-lg font-semibold text-ink-700">{hasFilter ? 'No matching records' : 'No decisions in this date range'}</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">{hasFilter ? 'Try different filters or clear them.' : 'Try widening the date range above.'}</p>
    </div>
  )
}