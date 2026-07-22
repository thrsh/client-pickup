// src/pages/approver/ApproverHistory.jsx
//
// Full audit trail for the approve/return/reject workflow. Unlike the
// "History" tab in AdminPickups.jsx (which only ever shows what's
// currently true about a reservation), this page reconstructs the whole
// chain per check: who submitted it for approval and when, who verified
// it and when, what they decided, and the OR no. / AR collected / remarks
// attached at that moment.
//
// DESIGN: uses the same "ledger" visual identity and shared components
// (KpiCard, SectionCard) as ApproverDashboard.jsx, so this page and the
// overview read as one consistent system rather than two different UIs.
// If a future page needs the same stat-card or section-card treatment,
// copy these two components rather than re-inventing the styling.
//
// DATA NOTE: check_activity_log doesn't have a "submitted_at" column on
// the decision row itself — only `performed_at` (when the decision
// happened). But every submission ALSO writes its own
// action = 'submitted_for_approval' log entry with its own performed_at.
// So "sent for approval at" is reconstructed by matching each decision
// entry to the most recent submitted_for_approval entry for the same
// check_id — exact, not estimated. See buildDecisionRows() below.
//
// COLLECTOR / SENT-BY / SENT-AT ROBUSTNESS FIX (read before touching):
//   collector_name, or_no, ar_collected, submitted_by_name, and
//   submitted_at are entered by the COLLECTOR/ADMIN at submission time
//   and only ever get written durably onto:
//     (a) the submitted_for_approval log row itself (partially — some
//         write paths don't populate every field on the log row), and
//     (b) the live `checks` row (checks.collector_name,
//         checks.submitted_by_name, checks.submitted_at).
//   (b) is NOT safe to trust for history: admin_release_reservation,
//   approver_decide('reject'), and cancelSubmissions() (AdminChecks.jsx)
//   all NULL those columns out the moment a check goes back to
//   'available' — so every rejected/released decision showed a blank
//   collector. Worse, once that check is re-reserved by a DIFFERENT
//   collector, checks.collector_name gets overwritten with the NEW
//   collector's name — so an old decision could silently show the wrong
//   person, not just a blank one.
//
//   The one source that is genuinely immutable per-decision is
//   pickup_reservations.collector_name, keyed off the log entry's own
//   `reservation_id` — set once when that specific reservation was
//   created and never rewritten afterward (ApproverHome.jsx and
//   AdminPickups.jsx already rely on exactly this for the same reason).
//   This page now fetches pickup_reservations in a SECOND, separate query
//   (same "don't trust a single embed, fetch and merge client-side"
//   pattern already used for the checks/activity join — see the
//   HISTORY-TAB DATA NOTE in AdminPickups.jsx) and treats it as the
//   highest-priority source for collectorName. sentAt/sentByName still
//   prefer the matched submission log row, but now also fall back to the
//   live checks row as a last resort (better than a blank cell) when no
//   submission entry can be matched at all — see the DEV SAFETY NET below
//   for why that gap can exist in the first place.
//
// BANK NOTE (added): check_activity_log has no `bank` column of its own —
// it was never part of what gets logged at submit/decide time, only
// `checks.bank` exists. So unlike collector_name there is no reservation-
// level fallback for bank; it can only ever come from the embedded
// `checks` row. normalizeBank() turns a blank/whitespace value into a
// real "Unspecified" bucket for display, search, and filtering.
//
// Requires the same migration as ApproverHome.jsx / AdminPickups.jsx
// (approval-workflow migration + the approver_decide fix that logs
// action = 'approved' | 'rejected' | 'returned').
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Stamp,
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
  ShieldAlert,
  Filter,
  SlidersHorizontal,
  ClipboardList,
  Wallet,
  Landmark,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card, CardContent } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import { useProfile, hasRole } from '../../context/ProfileContext'

const ALLOWED_ROLES = ['approver', 'admin']
const FETCH_LIMIT = 2000
const PAGE_SIZE_OPTIONS = [25, 50, 100]
const DECISION_ACTIONS = ['approved', 'rejected', 'returned']

// Recolored onto the ledger palette (ledger-stamp / ledger-amber / red)
// used across the approver area, instead of a one-off teal/red/amber set.
const DECISION_META = {
  approved: {
    label: 'Approved',
    icon: Check,
    badge: 'bg-ledger-stamp/10 text-ledger-stampDark',
    accent: 'border-l-ledger-stamp/60',
  },
  rejected: {
    label: 'Rejected',
    icon: XCircle,
    badge: 'bg-red-50 text-red-600',
    accent: 'border-l-red-400',
  },
  returned: {
    label: 'Returned',
    icon: RotateCcw,
    badge: 'bg-ledger-amber/10 text-ledger-amber',
    accent: 'border-l-ledger-amber/60',
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

// Fallback label whenever a check's bank field is blank/null. Kept in
// sync (name + semantics) with the same constant in ApproverHome.jsx so
// an approver sees the same "Unspecified" wording in both places rather
// than two different placeholder strings for the same data gap.
const UNKNOWN_BANK_LABEL = 'Unspecified'

// Normalizes a raw checks.bank value for display, grouping, and filtering
// so that '', null, undefined, and whitespace-only values are all treated
// as the same "unknown" bucket instead of creating near-duplicate filter
// options (e.g. '' vs null showing up as separate entries).
function normalizeBank(bank) {
  const trimmed = typeof bank === 'string' ? bank.trim() : ''
  return trimmed || UNKNOWN_BANK_LABEL
}

// Same deterministic small color set as ApproverHome.jsx's bank badges,
// hashed off the bank name so a given bank always renders the same color
// across pages without a hardcoded bank->color map to keep in sync.
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
      <span className="max-w-[100px] truncate">{label}</span>
    </span>
  )
}

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

// Reads a value off multiple possible sources in priority order, treating
// null/undefined as "missing" but preserving real falsy values (false, 0,
// '') from whichever source actually has them. Use this instead of chained
// `??` when a field can legitimately be `false` or `0` (e.g. ar_collected),
// since `a ?? b` alone can't distinguish "explicitly false" from "missing"
// once you start mixing types across sources.
function firstDefined(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined) return v
  }
  return null
}

// Reconstructs one row per decision (approve/return/reject), enriched
// with the matching "sent for approval" submission for that same check.
// Walks the log in chronological order per check_id so a check that gets
// returned and resubmitted multiple times is matched correctly each time
// — each decision picks up whichever submission most recently preceded it.
//
// `reservationsById` is a Map<reservationId, { collector_name }> fetched
// separately in load() — see the ROBUSTNESS FIX note at the top of this
// file for why this can't just be read off the embedded `checks` row.
function buildDecisionRows(rawLog, reservationsById) {
  const lastSubmissionByCheck = new Map()
  const rows = []
  const orphanedDecisions = [] // decisions with no matched submission — data issue, not display issue

  const sorted = [...rawLog].sort((a, b) => new Date(a.performed_at) - new Date(b.performed_at))

  sorted.forEach((entry) => {
    if (entry.action === 'submitted_for_approval') {
      lastSubmissionByCheck.set(entry.check_id, entry)
      return
    }
    if (!DECISION_ACTIONS.includes(entry.action)) return

    const submission = lastSubmissionByCheck.get(entry.check_id)
    const c = entry.checks || {}
    const reservation = reservationsById?.get(entry.reservation_id) || null

    if (!submission) {
      orphanedDecisions.push({ checkId: entry.check_id, action: entry.action, performedAt: entry.performed_at })
    }

    rows.push({
      id: entry.id,
      checkId: entry.check_id,
      reservationId: entry.reservation_id,
      decision: entry.action, // 'approved' | 'rejected' | 'returned'

      // COLLECTOR NAME — pickup_reservations.collector_name is checked
      // FIRST, ahead of the log/checks fallbacks. It's set once when this
      // specific reservation is created and is the only source in this
      // chain that's genuinely immutable per-decision: the live `checks`
      // row gets nulled on release/reject, and — worse — can get
      // overwritten with a DIFFERENT collector's name if the check is
      // later re-reserved. entry.collector_name / submission.collector_name
      // are kept as fallbacks only in case a future write path starts
      // populating them; today they're effectively always null.
      collectorName: firstDefined(
        reservation?.collector_name,
        entry.collector_name,
        submission?.collector_name,
        c.collector_name
      ),
      or_no: firstDefined(entry.or_no, submission?.or_no, c.or_no),
      ar_collected: firstDefined(entry.ar_collected, submission?.ar_collected, c.ar_collected),

      // Unlike collector_name, `bank` was never part of what gets logged
      // onto either the submission or decision row in check_activity_log
      // (see BANK NOTE at the top of this file), and there's no
      // reservation-level bank to fall back to either — the checks row is
      // the only real source. normalizeBank() at render/filter time turns
      // a blank value into a real "Unspecified" bucket.
      bank: c.bank,

      row_number: c.row_number,
      payee: c.payee,
      payor: c.payor,
      check_no: c.check_no,
      check_date: c.check_date,
      amount: c.amount,
      remarks: entry.remarks,

      // SENT AT / SENT BY — normally exact, from the matched
      // submitted_for_approval log row. When no submission entry can be
      // matched at all (an orphaned decision — see the DEV SAFETY NET
      // below), fall back to the live checks.submitted_at /
      // checks.submitted_by_name as a last resort. This can be
      // imprecise if the same check has since been resubmitted again
      // (it would reflect that LATER submission, not this one) — but for
      // the common case, and for any row that would otherwise render two
      // blank columns, it's strictly better than nothing. The real fix
      // for orphaned decisions is at the RPC layer (see below).
      sentAt: firstDefined(submission?.performed_at, c.submitted_at),
      sentByName: firstDefined(submission?.submitted_by_name, entry.submitted_by_name, c.submitted_by_name),
      decidedAt: entry.performed_at,
      verifiedByName: entry.approved_by_name ?? null,
    })

    // Once a check is decided, its next submission (if any) starts a
    // fresh cycle — don't let a later resubmission of the SAME check
    // accidentally get matched to this now-consumed submission again.
    lastSubmissionByCheck.delete(entry.check_id)
  })

  // DEV SAFETY NET: a decision with no matched submission means some
  // write path logged 'approved' | 'rejected' | 'returned' WITHOUT ever
  // logging 'submitted_for_approval' for that check first. The
  // checks.submitted_at/submitted_by_name fallback above keeps those rows
  // from rendering fully blank, but "Sent at" for those rows will reflect
  // the check's CURRENT submission record, which is only guaranteed
  // correct if the check hasn't been resubmitted again since. No amount
  // of read-side fallback can fully recover the exact historical value,
  // because the data was never written. This surfaces the gap loudly in
  // dev instead of letting it ship as silent (or subtly wrong) cells.
  // Fix at the source: find whichever approve/return/reject code path
  // skips the submission-log insert (e.g. a bulk-approve or admin
  // override button) and make it always write both entries.
  if (orphanedDecisions.length > 0 && import.meta.env?.DEV) {
    console.warn(
      `[ApproverHistory] ${orphanedDecisions.length} decision(s) have no matching ` +
        `submitted_for_approval log entry — their "Sent by / Sent at" columns are now ` +
        `filled from the live checks row as a best-effort fallback, which can be ` +
        `imprecise if that check was resubmitted again since. Check IDs:`,
      orphanedDecisions
    )
  }

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
    row.bank,
  ]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(needle))
}

function toDateInputValue(d) {
  return d.toISOString().slice(0, 10)
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
  const [bankFilter, setBankFilter] = useState('')
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
            'id, check_id, reservation_id, collector_name, action, or_no, ar_collected, remarks, performed_at, submitted_by_name, approved_by_name, checks(id, row_number, payee, payor, check_no, check_date, amount, collector_name, or_no, ar_collected, bank, submitted_by_name, submitted_at)'
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

        const rawLog = data || []

        // SECOND, SEPARATE QUERY for pickup_reservations.collector_name —
        // deliberately not a compound embed on check_activity_log
        // alongside `checks(...)` above. This page already relies on one
        // embed (`checks`) working reliably; stacking a second embed onto
        // the same query multiplies the exact same "PostgREST silently
        // returns null for the whole relationship" risk documented in
        // AdminPickups.jsx's HISTORY-TAB DATA NOTE, and — unlike the
        // `checks` embed, which happens to be visibly fine today — this is
        // precisely the field that was broken, so it gets the more
        // defensive two-query treatment on principle. Non-fatal if it
        // fails: rows still render, just without the reservation-level
        // collector name fallback until the next successful refresh.
        const reservationIds = [...new Set(rawLog.map((r) => r.reservation_id).filter(Boolean))]
        let reservationsById = new Map()
        if (reservationIds.length > 0) {
          const { data: reservationsData, error: reservationsError } = await supabase
            .from('pickup_reservations')
            .select('id, collector_name')
            .in('id', reservationIds)

          if (!isMountedRef.current || requestId !== requestIdRef.current) return

          if (reservationsError) {
            console.error('pickup_reservations lookup for history failed:', reservationsError)
          } else {
            reservationsById = new Map((reservationsData || []).map((r) => [r.id, r]))
          }
        }

        setRows(buildDecisionRows(rawLog, reservationsById))
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
  // restores the full set. Mirrors the "quick filter" affordance the
  // dashboard's linked KPI cards use for navigation.
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
  // Derived live from the fetched window, same as collector/verifier —
  // never hardcoded, so it can't show a bank that isn't actually present
  // in the current date range.
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
    if (collectorFilter) list = list.filter((r) => r.collectorName === collectorFilter)
    if (verifierFilter) list = list.filter((r) => r.verifiedByName === verifierFilter)
    if (bankFilter) list = list.filter((r) => normalizeBank(r.bank) === bankFilter)
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
  }, [rows, search, decisionFilter, collectorFilter, verifierFilter, bankFilter, arFilter, sortBy])

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
    setBankFilter('')
    setArFilter('any')
    setPage(1)
  }

  const hasActiveFilters =
    !!search.trim() ||
    decisionFilter.size !== DECISION_ACTIONS.length ||
    !!collectorFilter ||
    !!verifierFilter ||
    !!bankFilter ||
    arFilter !== 'any'

  function exportCsv() {
    const headers = [
      'Decision',
      'Collector',
      'Bank',
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
  const pctOfTotal = (n) => (summary.total > 0 ? Math.round((n / summary.total) * 100) : null)

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
              Approval audit trail
            </p>
            <h1 className="font-display text-2xl font-semibold text-ink-900">Approval history</h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-400">
              Every check that's gone through approval — who submitted it, who verified it, what they
              decided, and when each step happened.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="hidden font-mono text-[11px] text-ink-300 sm:inline">
              Updated {Math.round((Date.now() - lastUpdated) / 1000)}s ago
            </span>
          )}
          <button
            onClick={() => load(false)}
            disabled={refreshing || loading}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

    {/* Date range — the only filter that re-queries the DB; everything
    else below filters in-memory over this window. */}
{(() => {
  const today = toDateInputValue(new Date());

  const handleFromChange = (value) => {
    if (!value) return setDateFrom(value);
    const clamped = value > today ? today : value;
    setDateFrom(clamped > dateTo ? dateTo : clamped);
  };

  const handleToChange = (value) => {
    if (!value) return setDateTo(value);
    const clamped = value > today ? today : value;
    setDateTo(clamped < dateFrom ? dateFrom : clamped);
  };

  return (
    <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-ink-100 bg-ink-50/50 p-3.5">
      <div>
        <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">From</label>
        <input
          type="date"
          value={dateFrom}
          max={today}
          onChange={(e) => handleFromChange(e.target.value)}
          className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
        />
      </div>
      <div>
        <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">To</label>
        <input
          type="date"
          value={dateTo}
          min={dateFrom}
          max={today}
          onChange={(e) => handleToChange(e.target.value)}
          className="rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
        />
      </div>
      <button
        onClick={() => load(true)}
        className="rounded-md bg-ink-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-ink-800"
      >
        Apply range
      </button>
    </div>
  );
})()}

      {/* KPI cards — the same KpiCard template used on ApproverDashboard
          (icon badge, accent ring, value + secondary line). Each decision
          card also acts as a quick filter via the onClick affordance. */}
      {!loading && (
        <>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-300">Decision summary</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <KpiCard
              icon={ClipboardList}
              label="Decisions"
              value={summary.total}
              secondary={`${formatDate(dateFrom)} – ${formatDate(dateTo)}`}
              accent="ink"
            />
            <KpiCard
              icon={Check}
              label="Approved"
              value={summary.approved}
              secondary={pctOfTotal(summary.approved) !== null ? `${pctOfTotal(summary.approved)}% of decisions` : null}
              accent="stamp"
              active={decisionFilter.size === 1 && decisionFilter.has('approved')}
              onClick={() => isolateDecision('approved')}
            />
            <KpiCard
              icon={XCircle}
              label="Rejected"
              value={summary.rejected}
              secondary={pctOfTotal(summary.rejected) !== null ? `${pctOfTotal(summary.rejected)}% of decisions` : null}
              accent="critical"
              active={decisionFilter.size === 1 && decisionFilter.has('rejected')}
              onClick={() => isolateDecision('rejected')}
            />
            <KpiCard
              icon={RotateCcw}
              label="Returned"
              value={summary.returned}
              secondary={pctOfTotal(summary.returned) !== null ? `${pctOfTotal(summary.returned)}% of decisions` : null}
              accent="amber"
              active={decisionFilter.size === 1 && decisionFilter.has('returned')}
              onClick={() => isolateDecision('returned')}
            />
            <KpiCard
              icon={Wallet}
              label="Approved value"
              value={formatCurrency(summary.approvedValue)}
              secondary={`${summary.approved} approved check${summary.approved === 1 ? '' : 's'}`}
              accent="stamp"
            />
          </div>
        </>
      )}

      <div className="mb-3 mt-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            placeholder="Search collector, bank, check #, payee, payor, OR no., remarks, names..."
            className="border-ink-200 pl-9 pr-8 text-sm focus-visible:ring-ledger-stamp"
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
            hasActiveFilters ? 'border-ledger-stamp/50 text-ledger-stampDark' : 'border-ink-200 text-ink-600'
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {hasActiveFilters && (
            <span className="rounded-full bg-ledger-stampDark px-1.5 py-0.5 text-[10px] font-semibold text-white">
              on
            </span>
          )}
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
                      sortBy === o.value ? 'text-ledger-stampDark' : 'text-ink-600'
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
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">Decision</p>
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
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">Collector</p>
              <select
                value={collectorFilter}
                onChange={(e) => {
                  setCollectorFilter(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
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
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">Bank</p>
              <select
                value={bankFilter}
                onChange={(e) => {
                  setBankFilter(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
              >
                <option value="">All banks</option>
                {bankOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">Verified by</p>
              <select
                value={verifierFilter}
                onChange={(e) => {
                  setVerifierFilter(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
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
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-400">AR collected</p>
              <select
                value={arFilter}
                onChange={(e) => {
                  setArFilter(e.target.value)
                  setPage(1)
                }}
                className="rounded-md border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
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
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-dashed border-ink-100 bg-ink-50/50 px-5 py-3.5">
              <div>
                <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink-900">
                  <ClipboardList className="h-4 w-4 text-ledger-stampDark" />
                  Decision records
                </h2>
                <p className="mt-0.5 text-xs text-ink-400">
                  One row per decision — every field below is its own column, so nothing is bundled
                  together that you might want to sort, scan, or export separately.
                </p>
              </div>
              <span className="hidden shrink-0 font-mono text-[11px] text-ink-400 sm:inline">
                {filteredRows.length} record{filteredRows.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1620px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-dashed border-ink-100 bg-ink-50/50 text-left font-mono text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="px-4 py-3 font-medium">Decision</th>
                    <th className="px-4 py-3 font-medium">Collector</th>
                    <th className="px-4 py-3 font-medium">Bank</th>
                    <th className="px-4 py-3 font-medium">Check no.</th>
                    <th className="px-4 py-3 font-medium">Check date</th>
                    <th className="px-4 py-3 font-medium">Payee</th>
                    <th className="px-4 py-3 font-medium">Payor</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 font-medium">OR no.</th>
                    <th className="px-4 py-3 font-medium">AR collected</th>
                    <th className="px-4 py-3 font-medium">Sent by</th>
                    <th className="px-4 py-3 font-medium">Sent at</th>
                    <th className="px-4 py-3 font-medium">Verified by</th>
                    <th className="px-4 py-3 font-medium">Decided at</th>
                    <th className="px-4 py-3 font-medium">Turnaround</th>
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
                        <tr
                          className={cn(
                            'cursor-pointer border-l-[3px] border-l-transparent align-top transition-colors hover:bg-ink-50/50',
                            meta.accent
                          )}
                          onClick={() => setExpandedRowId(isExpanded ? null : r.id)}
                        >
                          <td className="px-4 py-4">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                                meta.badge
                              )}
                            >
                              <Icon className="h-3 w-3" />
                              {meta.label}
                            </span>
                          </td>

                          <td className="px-4 py-4">
                            <div className="flex items-center gap-2">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-50 font-mono text-[10px] font-semibold text-ink-600">
                                {initials(r.collectorName)}
                              </span>
                              <p className="max-w-[120px] truncate font-medium text-ink-900">
                                {r.collectorName || '—'}
                              </p>
                            </div>
                          </td>

                          <td className="px-4 py-4">
                            <BankBadge bank={r.bank} />
                          </td>

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

                          <td className="max-w-[160px] px-4 py-4">
                            <p className="truncate font-medium text-ink-900">{r.payee || '—'}</p>
                          </td>

                          <td className="max-w-[140px] px-4 py-4">
                            <p className="truncate text-xs text-ink-500">{r.payor || '—'}</p>
                          </td>

                          <td className="px-4 py-4 text-right font-mono font-semibold text-ink-800">
                            {formatCurrency(r.amount)}
                          </td>

                          <td className="px-4 py-4">
                            <span className="font-mono text-xs text-ink-700">{r.or_no || '—'}</span>
                          </td>

                          <td className="px-4 py-4">
                            {r.ar_collected === null || r.ar_collected === undefined ? (
                              <span className="text-xs text-ink-300">N/A</span>
                            ) : r.ar_collected ? (
                              <span className="text-xs font-medium text-ledger-stampDark">Yes</span>
                            ) : (
                              <span className="text-xs font-medium text-ledger-amber">No</span>
                            )}
                          </td>

                          <td className="max-w-[130px] px-4 py-4">
                            <p className="truncate text-xs text-ink-700">{r.sentByName || '—'}</p>
                          </td>

                          <td className="px-4 py-4">
                            <p className="whitespace-nowrap font-mono text-xs text-ink-400">
                              {fmtDateTime(r.sentAt) || '—'}
                            </p>
                          </td>

                          <td className="max-w-[130px] px-4 py-4">
                            <p className="flex items-center gap-1 truncate text-xs text-ink-700">
                              <UserCheck className="h-3 w-3 shrink-0 text-ink-300" />
                              {r.verifiedByName || '—'}
                            </p>
                          </td>

                          <td className="px-4 py-4">
                            <p className="whitespace-nowrap font-mono text-xs text-ink-400">
                              {fmtDateTime(r.decidedAt) || '—'}
                            </p>
                          </td>

                          <td className="px-4 py-4">
                            <span className="font-mono text-xs font-medium text-ink-600">
                              {durationLabel(r.sentAt, r.decidedAt) || '—'}
                            </span>
                          </td>

                          <td className="px-3 py-4 text-right">
                            <span className="inline-flex text-ink-300">
                              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </span>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={16} className="bg-ink-50/40 px-4 pb-4 pt-0">
                              <div className="rounded-lg border border-dashed border-ink-200 bg-white px-4 py-3">
                                <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-ink-400">
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
          </Card>

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
                className="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-600 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
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

// ---- Shared template pieces -----------------------------------------------
// These two components (KpiCard, and the state screens below) mirror
// ApproverDashboard.jsx exactly, so the two pages read as one system.
// KpiCard additionally supports `active` + `onClick` here, for cards that
// double as quick filters — a superset of the dashboard's `to`-link usage.

function KpiCard({ icon: Icon, label, value, secondary, loading, accent, delta, deltaUnit = '%', to, active, onClick }) {
  const accents = {
    stamp: { badge: 'bg-ledger-stamp/10 text-ledger-stampDark', ring: 'border-ledger-stamp/30', active: 'ring-ledger-stamp/40' },
    amber: { badge: 'bg-ledger-amber/10 text-ledger-amber', ring: 'border-ledger-amber/30', active: 'ring-ledger-amber/40' },
    ink: { badge: 'bg-ink-50 text-ink-700', ring: 'border-ink-100', active: 'ring-ink-300' },
    critical: { badge: 'bg-red-50 text-red-600', ring: 'border-red-200', active: 'ring-red-300' },
  }
  const style = accents[accent] || accents.ink
  const isLoading = value === null || value === undefined

  const content = (
    <CardContent className="relative overflow-hidden p-4">
      <div
        className={cn(
          'pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed',
          style.ring
        )}
        aria-hidden="true"
      />

      <div className="relative flex items-start gap-3">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', style.badge)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-6 w-16 animate-pulse rounded bg-ink-100" />
          ) : (
            <div className="flex items-center gap-2">
              <p className="truncate font-display text-lg font-semibold text-ink-900">{value}</p>
              {delta && !delta.isNew && delta.pct !== null && (
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-0.5 text-[11px] font-medium',
                    delta.direction === 'up' ? 'text-ledger-stampDark' : 'text-ink-400'
                  )}
                >
                  {Math.abs(delta.pct)}
                  {deltaUnit}
                </span>
              )}
              {delta && delta.isNew && (
                <span className="shrink-0 text-[11px] font-medium text-ledger-stampDark">new</span>
              )}
            </div>
          )}
          <p className="truncate text-xs text-ink-400">{label}</p>
          {!isLoading && secondary && (
            <p className="mt-0.5 truncate font-mono text-xs text-ink-500">{secondary}</p>
          )}
        </div>
      </div>
    </CardContent>
  )

  const cardClassName = cn(
    (to || onClick) && 'transition hover:border-ink-200 hover:shadow-sm',
    active && 'ring-2 ring-offset-1',
    active && style.active
  )

  if (to) {
    return (
      <Card className={cardClassName}>
        <Link to={to}>{content}</Link>
      </Card>
    )
  }
  if (onClick) {
    return (
      <Card className={cardClassName}>
        <button type="button" onClick={onClick} className="w-full text-left">
          {content}
        </button>
      </Card>
    )
  }
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
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        Viewing approval history requires the approver or admin role. If this seems wrong, ask an
        admin to check your account's role.
      </p>
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