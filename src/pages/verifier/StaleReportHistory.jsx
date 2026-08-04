import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  FileSpreadsheet,
  Download,
  X,
  Eye,
  Inbox,
  Search,
  SlidersHorizontal,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Building2,
  Landmark,
  FileDown,
  CalendarRange,
  CheckCircle2,
  RotateCcw,
  Clock3,
  MinusCircle,
  Hash,
} from 'lucide-react'
import { useProfile } from '../../context/ProfileContext'
import { supabase } from '../../lib/supabaseClient'
import { Button } from '../../components/ui/button'
import { formatCurrency, cn } from '../../lib/utils'
import { buildStaleCheckReportPdf, buildStaleCheckReportWorkbook } from '../../lib/staleCheckReportDocument'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]
const SUBMITTED_STATUS = 'submitted'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'generated', label: 'Generated (pending)' },
]

// Decision is a separate axis from the submission status above. A report
// can only be decided once it's actually submitted, so this is driven by
// the submitted_at / decided_at timestamps (see getDecisionState), not by
// the free-text status column:
//   - no submitted_at                -> 'not_submitted'
//   - submitted_at set, no decided_at -> 'awaiting'
//   - submitted_at and decided_at set -> 'approved' | 'returned' | 'mixed'
const DECISION_OPTIONS = [
  { value: 'all', label: 'All decisions' },
  { value: 'not_submitted', label: 'Not submitted' },
  { value: 'awaiting', label: 'Pending approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'returned', label: 'Return to Bank' },
  { value: 'mixed', label: 'Mixed outcome' },
]

const DEFAULT_FILTERS = {
  status: 'all',
  decision: 'all',
  dateFrom: '',
  dateTo: '',
  branch: 'all',
  bank: 'all',
}

const SORTABLE_COLUMNS = {
  report_number: (r) => r.report_number || '',
  generated_at: (r) => (r.generated_at ? new Date(r.generated_at).getTime() : 0),
  submitted_at: (r) => (r.submitted_at ? new Date(r.submitted_at).getTime() : 0),
  decided_at: (r) => (r.decided_at ? new Date(r.decided_at).getTime() : 0),
  status: (r) => (isSubmitted(r) ? 1 : 0),
  check_count: (r) => Number(r.check_count) || 0,
  total_amount: (r) => Number(r.total_amount) || 0,
}

// staled_check_reports.branches is a text[] column already present on every
// row from verifier_list_staled_check_reports — no hydration needed for
// scoping or the branch filter.
const getReportBranches = (r) => (Array.isArray(r?.branches) ? r.branches.filter(Boolean) : [])

// staled_check_reports has no bank column, so bank names (and full check
// detail, for the expandable row) come from checks.bank via the per-report
// detail RPC.
const BANK_FIELD_CANDIDATES = ['bank', 'bank_name', 'bankName']
const CHECK_NO_FIELD_CANDIDATES = ['check_no', 'checkNo', 'check_number']
const PAYEE_FIELD_CANDIDATES = ['payee']
const BRANCH_FIELD_CANDIDATES = ['pickup_branch', 'branch', 'pickupBranch']
const CHECK_STATUS_FIELD_CANDIDATES = ['status', 'check_status']
const RETURN_REASON_FIELD_CANDIDATES = ['return_reason', 'reason', 'returnReason']
const AMOUNT_FIELD_CANDIDATES = ['amount', 'check_amount']

const DETAIL_FETCH_BATCH_SIZE = 4

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// submitted_at is the field actually stamped when a verifier submits a
// report, so it's the source of truth for "was this submitted" — not the
// free-text `status` column, which can drift out of sync with it.
function isSubmitted(r) {
  return Boolean(r?.submitted_at)
}

function useDebouncedValue(value, delay = 250) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** First non-empty string value found among a list of candidate field names. */
function firstDefined(row, keys) {
  for (const key of keys) {
    const value = row?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** First finite numeric value found among a list of candidate field names, defaulting to 0. */
function firstDefinedNumber(row, keys) {
  for (const key of keys) {
    const value = Number(row?.[key])
    if (Number.isFinite(value)) return value
  }
  return 0
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

function formatDateTime(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

function safeCurrency(amount) {
  const n = Number(amount)
  return Number.isFinite(n) ? formatCurrency(n) : '—'
}

function escapeCsvField(value) {
  const str = String(value ?? '')
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Normalizes any thrown/returned error (Postgrest, network, string) into one message. */
function toErrorMessage(err, fallback) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err.message) return err.message
  return fallback
}

// A report's decision outcome. Only a submitted report can have one — a
// report with no submitted_at was never sent to an approver, so it reads
// as 'not_submitted' regardless of how many newer reports have since
// superseded it. This is what keeps abandoned drafts (a verifier
// re-generating a report several times before submitting one of them)
// from ever being mislabeled as "awaiting decision".
function getDecisionState(r) {
  if (!isSubmitted(r)) return 'not_submitted'
  if (!r.decided_at) return 'awaiting'
  const approved = Number(r.approved_count) || 0
  const returned = Number(r.returned_count) || 0
  if (returned > 0 && approved === 0) return 'returned'
  if (returned > 0) return 'mixed'
  return 'approved'
}

// ---------------------------------------------------------------------------
// Presentational sub-components
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub, tone = 'default' }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-white px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-ink-400">{label}</p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold',
          tone === 'accent' ? 'text-ledger-stampDark' : 'text-ink-900',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-ink-400">{sub}</p>}
    </div>
  )
}

function SortHeader({ label, sortKey, sort, onSort, align = 'left' }) {
  const isActive = sort.key === sortKey
  const Icon = isActive ? (sort.direction === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown
  return (
    <th className={cn('px-4 py-2 font-medium', align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 text-[10px] uppercase tracking-wide hover:text-ink-700',
          isActive ? 'text-ink-700' : 'text-ink-400',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        <Icon className="h-3 w-3" />
      </button>
    </th>
  )
}

function BranchList({ names, icon: Icon }) {
  if (!names || names.length === 0) {
    return <span className="text-ink-300">—</span>
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={names.join(', ')}>
      <Icon className="h-3 w-3 shrink-0 text-ink-300" />
      {names.map((name) => (
        <span key={name} className="rounded-full bg-ink-50 px-1.5 py-0.5 text-[10px] font-medium text-ink-600">
          {name}
        </span>
      ))}
    </span>
  )
}

function NameList({ names, icon: Icon, loading, errored, onRetry }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-ink-300">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="text-[10px]">Loading…</span>
      </span>
    )
  }

  if (errored) {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1 text-[10px] font-medium text-red-500 hover:underline"
      >
        <AlertTriangle className="h-3 w-3" /> Retry
      </button>
    )
  }

  if (!names || names.length === 0) {
    return <span className="text-ink-300">—</span>
  }

  const visible = names.slice(0, 2)
  const remaining = names.length - visible.length
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={names.join(', ')}>
      <Icon className="h-3 w-3 shrink-0 text-ink-300" />
      {visible.map((name) => (
        <span key={name} className="rounded-full bg-ink-50 px-1.5 py-0.5 text-[10px] font-medium text-ink-600">
          {name}
        </span>
      ))}
      {remaining > 0 && <span className="text-[10px] text-ink-400">+{remaining} more</span>}
    </span>
  )
}

function StatusBadge({ submitted }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
        submitted ? 'bg-ledger-stamp/10 text-ledger-stampDark' : 'bg-amber-100 text-amber-700',
      )}
    >
      {submitted ? 'Submitted' : 'Generated'}
    </span>
  )
}

// The approver's decision on a report — independent of the submission
// StatusBadge above. "Not submitted" covers any report never sent for
// approval, including drafts superseded by a later generation. "Mixed"
// covers a submitted report where some checks were confirmed stale and
// others were returned to the pool.
function DecisionBadge({ report }) {
  switch (getDecisionState(report)) {
    case 'not_submitted':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-ink-50 px-2 py-0.5 text-[10px] font-medium text-ink-400">
          <MinusCircle className="h-2.5 w-2.5" /> Not submitted
        </span>
      )
    case 'returned':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-700">
          <RotateCcw className="h-2.5 w-2.5" /> Return to Bank
        </span>
      )
    case 'mixed':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
          <CheckCircle2 className="h-2.5 w-2.5" /> Mixed outcome
        </span>
      )
    case 'approved':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
          <CheckCircle2 className="h-2.5 w-2.5" /> Approved
        </span>
      )
    case 'awaiting':
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
          <Clock3 className="h-2.5 w-2.5" /> Pending approval
        </span>
      )
  }
}

// Per-check outcome inside the expanded detail table. Falls back to a
// plain capitalized label for any status value it doesn't recognize, so an
// unexpected value never renders as a blank cell.
function CheckOutcomeBadge({ status }) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'returned')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-700">
        <RotateCcw className="h-2.5 w-2.5" /> Return to Bank
      </span>
    )
  if (normalized === 'approved' || normalized === 'picked_up')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <CheckCircle2 className="h-2.5 w-2.5" /> {normalized === 'picked_up' ? 'Picked up' : 'Approved'}
      </span>
    )
  if (normalized === 'pending_approval')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
        <Clock3 className="h-2.5 w-2.5" /> Pending approval
      </span>
    )
  if (normalized)
    return (
      <span className="inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium capitalize text-ink-500">
        {normalized}
      </span>
    )
  return <span className="text-ink-300">—</span>
}

// Nested, read-only detail table shown when a report row is expanded.
// Sourced from the same detail cache used to hydrate the Banks column, so
// expanding a row never triggers an extra network call once that row has
// already been fetched for the page.
function CheckDetailTable({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-xs text-ink-400">
        <Inbox className="h-3.5 w-3.5 shrink-0" />
        No check details are available for this report.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-xs">
        <thead>
          <tr className="border-b border-dashed border-ink-100 text-left text-[10px] uppercase tracking-wide text-ink-400">
            <th className="px-4 py-2 font-medium">Check no.</th>
            <th className="px-2 py-2 font-medium">Bank</th>
            <th className="px-2 py-2 font-medium">Branch</th>
            <th className="px-2 py-2 font-medium">Payee</th>
            <th className="px-2 py-2 text-right font-medium">Amount</th>
            <th className="px-2 py-2 font-medium">Outcome</th>
            <th className="px-2 py-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-dashed divide-ink-50">
          {rows.map((row, idx) => {
            const checkNo = firstDefined(row, CHECK_NO_FIELD_CANDIDATES)
            const payee = firstDefined(row, PAYEE_FIELD_CANDIDATES)
            const branch = firstDefined(row, BRANCH_FIELD_CANDIDATES)
            const bank = firstDefined(row, BANK_FIELD_CANDIDATES)
            const status = firstDefined(row, CHECK_STATUS_FIELD_CANDIDATES)
            const reason = firstDefined(row, RETURN_REASON_FIELD_CANDIDATES)
            const amount = firstDefinedNumber(row, AMOUNT_FIELD_CANDIDATES)
            return (
              <tr key={row.id ?? checkNo ?? idx} className="hover:bg-ink-50/40">
                <td className="px-4 py-2 font-mono text-ink-700">
                  <span className="flex items-center gap-1">
                    <Hash className="h-3 w-3 shrink-0 text-ink-300" />
                    {checkNo || '—'}
                  </span>
                </td>
                <td className="px-2 py-2 text-ink-600">{bank || '—'}</td>
                <td className="max-w-[120px] truncate px-2 py-2 text-ink-600" title={branch || undefined}>
                  {branch || '—'}
                </td>
                <td className="max-w-[160px] truncate px-2 py-2 font-medium text-ink-800" title={payee || undefined}>
                  {payee || '—'}
                </td>
                <td className="px-2 py-2 text-right font-mono font-medium text-ink-700">{safeCurrency(amount)}</td>
                <td className="px-2 py-2">
                  <CheckOutcomeBadge status={status} />
                </td>
                <td className="max-w-[180px] truncate px-2 py-2 text-ink-500" title={reason || undefined}>
                  {reason || '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TableSkeleton({ rows = 6, columns = 11 }) {
  return (
    <tbody className="divide-y divide-ink-50">
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: columns }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-3 w-full max-w-[6rem] animate-pulse rounded bg-ink-100" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function StaleReportHistory() {
  const {
    id: currentUserId,
    pickupBranch,
    isAllBranches,
    loading: profileLoading,
    error: profileError,
  } = useProfile()

  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [searchInput, setSearchInput] = useState('')
  const debouncedSearch = useDebouncedValue(searchInput, 250)

  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [showFilters, setShowFilters] = useState(false)

  const [sort, setSort] = useState({ key: 'generated_at', direction: 'desc' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const [expandedRows, setExpandedRows] = useState(() => new Set())

  // Per-report cache of hydrated check detail, keyed by report_number:
  // { status: 'loading' | 'loaded' | 'error', rows: object[] | null, banks: string[] | null }
  // Serves both the Banks column and the expandable check-detail table so
  // expanding a row never triggers a duplicate fetch.
  const [detailCache, setDetailCache] = useState({})
  const detailCacheRef = useRef(detailCache)
  useEffect(() => {
    detailCacheRef.current = detailCache
  }, [detailCache])

  const [preview, setPreview] = useState({
    open: false,
    loading: false,
    reportNumber: '',
    meta: null,
    pdfDoc: null,
    pdfUrl: '',
    xlsxBlob: null,
    error: '',
  })

  const isMountedRef = useRef(true)
  const requestIdRef = useRef(0)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // -- Data loading ------------------------------------------------------

  const loadReports = useCallback(async () => {
    if (profileLoading) return

    const thisRequestId = ++requestIdRef.current
    setLoading(true)
    setLoadError('')

    try {
      const { data, error } = await supabase.rpc('verifier_list_staled_check_reports')

      if (!isMountedRef.current || thisRequestId !== requestIdRef.current) return

      if (error) {
        console.error('[StaleReportHistory] verifier_list_staled_check_reports failed:', error)
        setLoadError(toErrorMessage(error, 'Failed to load report history.'))
        return
      }

      if (!Array.isArray(data)) {
        console.error('[StaleReportHistory] Unexpected RPC response shape:', data)
        setLoadError('Received an unexpected response while loading report history.')
        setReports([])
        return
      }

      setReports(data)
    } catch (err) {
      if (!isMountedRef.current || thisRequestId !== requestIdRef.current) return
      console.error('[StaleReportHistory] loadReports threw:', err)
      setLoadError(toErrorMessage(err, 'Failed to load report history. Please check your connection and try again.'))
    } finally {
      if (isMountedRef.current && thisRequestId === requestIdRef.current) setLoading(false)
    }
  }, [profileLoading])

  useEffect(() => {
    loadReports()
  }, [loadReports])

  useEffect(() => {
    return () => {
      if (preview.pdfUrl) URL.revokeObjectURL(preview.pdfUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.pdfUrl])

  useEffect(() => {
    if (!preview.open) return
    function onKeyDown(e) {
      if (e.key === 'Escape') closePreview()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.open])

  // -- Ownership + branch scoping (defense-in-depth) ------------------------
  //
  // verifier_list_staled_check_reports() already scopes to this caller's own
  // reports (generated_by = auth.uid()) and, unless they're an 'all_branches'
  // verifier, to their own branch — enforced by the RPC body and RLS. This
  // mirrors that same rule client-side: not the security boundary (the DB
  // is), but it fails closed if the RPC/RLS ever drift out of sync.
  const scopedReports = useMemo(() => {
    if (!currentUserId) return []
    return reports.filter((r) => {
      const ownedByMe = r.generated_by === currentUserId
      const branchOk = isAllBranches || getReportBranches(r).includes(pickupBranch)
      if (!ownedByMe || !branchOk) {
        console.warn(
          `[StaleReportHistory] Dropped out-of-scope report ${r.report_number}: ` +
            `owner=${r.generated_by} (expected ${currentUserId}), branches=${JSON.stringify(getReportBranches(r))} ` +
            `(expected to include ${pickupBranch ?? '<all>'})`,
        )
      }
      return ownedByMe && branchOk
    })
  }, [reports, currentUserId, pickupBranch, isAllBranches])

  // Drop any expanded row that no longer exists after a refresh (e.g. it
  // fell out of scope), so we don't leave a dangling expanded entry around.
  useEffect(() => {
    setExpandedRows((prev) => {
      if (prev.size === 0) return prev
      const validIds = new Set(scopedReports.map((r) => r.report_number))
      const next = new Set([...prev].filter((id) => validIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [scopedReports])

  // -- Check detail hydration ---------------------------------------------
  //
  // staled_check_reports has no bank column and no per-check breakdown, so
  // both the Banks column and the expandable check table require the
  // per-report detail RPC. Lazily fetched for whatever's on the visible
  // page, batched, and cached per report_number so paging back — or
  // expanding a row already on-screen — never refetches.

  const fetchReportDetail = useCallback(async (reportNumber) => {
    setDetailCache((prev) => ({ ...prev, [reportNumber]: { status: 'loading', rows: null, banks: null } }))
    try {
      const { data: rows, error } = await supabase.rpc('verifier_get_staled_check_report_detail', {
        p_report_number: reportNumber,
      })
      if (error) throw error
      if (!Array.isArray(rows)) throw new Error('Unexpected response shape from report detail.')

      const banks = uniqueSorted(rows.map((row) => firstDefined(row, BANK_FIELD_CANDIDATES)).filter(Boolean))

      if (!isMountedRef.current) return
      setDetailCache((prev) => ({
        ...prev,
        [reportNumber]: { status: 'loaded', rows, banks },
      }))
    } catch (err) {
      console.error(`[StaleReportHistory] Failed to hydrate detail for report ${reportNumber}:`, err)
      if (!isMountedRef.current) return
      setDetailCache((prev) => ({ ...prev, [reportNumber]: { status: 'error', rows: null, banks: null } }))
    }
  }, [])

  function retryReportDetail(reportNumber) {
    fetchReportDetail(reportNumber)
  }

  function resolvedBankNames(r) {
    return detailCache[r.report_number]?.banks || null
  }

  function toggleExpandRow(reportNumber) {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(reportNumber)) {
        next.delete(reportNumber)
      } else {
        next.add(reportNumber)
      }
      return next
    })
  }

  const branchOptions = useMemo(() => {
    const names = []
    scopedReports.forEach((r) => names.push(...getReportBranches(r)))
    return uniqueSorted(names)
  }, [scopedReports])

  const bankOptions = useMemo(() => {
    const names = []
    scopedReports.forEach((r) => names.push(...(resolvedBankNames(r) || [])))
    return uniqueSorted(names)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedReports, detailCache])

  // -- Filtering / sorting / pagination -------------------------------------

  const filteredReports = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase()
    const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`) : null
    const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59`) : null

    return scopedReports.filter((r) => {
      if (term) {
        const haystack = `${r.report_number || ''} ${r.generated_by_name || ''} ${r.submitted_by_name || ''} ${r.decided_by_name || ''}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      if (filters.status === 'submitted' && !isSubmitted(r)) return false
      if (filters.status === 'generated' && isSubmitted(r)) return false
      if (filters.decision !== 'all' && getDecisionState(r) !== filters.decision) return false
      if (from || to) {
        const generatedAt = r.generated_at ? new Date(r.generated_at) : null
        if (!generatedAt || Number.isNaN(generatedAt.getTime())) return false
        if (from && generatedAt < from) return false
        if (to && generatedAt > to) return false
      }
      if (filters.branch !== 'all' && !getReportBranches(r).includes(filters.branch)) return false
      if (filters.bank !== 'all' && !resolvedBankNames(r)?.includes(filters.bank)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedReports, debouncedSearch, filters, detailCache])

  const sortedReports = useMemo(() => {
    const getValue = SORTABLE_COLUMNS[sort.key]
    if (!getValue) return filteredReports
    const copy = [...filteredReports]
    copy.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (av < bv) return sort.direction === 'asc' ? -1 : 1
      if (av > bv) return sort.direction === 'asc' ? 1 : -1
      return 0
    })
    return copy
  }, [filteredReports, sort])

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, filters, pageSize])

  const totalPages = Math.max(1, Math.ceil(sortedReports.length / pageSize))
  const clampedPage = Math.min(page, totalPages)

  const paginatedReports = useMemo(() => {
    const start = (clampedPage - 1) * pageSize
    return sortedReports.slice(start, start + pageSize)
  }, [sortedReports, clampedPage, pageSize])

  // Hydrate check detail for whatever's on the visible page, in small
  // concurrent batches, skipping anything already cached or in flight.
  useEffect(() => {
    const pending = paginatedReports
      .map((r) => r.report_number)
      .filter((num) => !detailCacheRef.current[num])

    if (pending.length === 0) return
    let cancelled = false

    ;(async () => {
      for (let i = 0; i < pending.length; i += DETAIL_FETCH_BATCH_SIZE) {
        if (cancelled) return
        const batch = pending.slice(i, i + DETAIL_FETCH_BATCH_SIZE)
        await Promise.all(batch.map(fetchReportDetail))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [paginatedReports, fetchReportDetail])

  function toggleSort(key) {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'desc' },
    )
  }

  function clearFilters() {
    setSearchInput('')
    setFilters(DEFAULT_FILTERS)
  }

  const hasActiveFilters =
    searchInput.trim() !== '' ||
    filters.status !== 'all' ||
    filters.decision !== 'all' ||
    filters.dateFrom !== '' ||
    filters.dateTo !== '' ||
    filters.branch !== 'all' ||
    filters.bank !== 'all'

  const stats = useMemo(() => {
    return filteredReports.reduce(
      (acc, r) => {
        const state = getDecisionState(r)
        return {
          checks: acc.checks + (Number(r.check_count) || 0),
          amount: acc.amount + Number(r.total_amount || 0),
          notSubmitted: acc.notSubmitted + (state === 'not_submitted' ? 1 : 0),
          awaiting: acc.awaiting + (state === 'awaiting' ? 1 : 0),
          approved: acc.approved + (state === 'approved' ? 1 : 0),
          returned: acc.returned + (state === 'returned' || state === 'mixed' ? 1 : 0),
        }
      },
      { checks: 0, amount: 0, notSubmitted: 0, awaiting: 0, approved: 0, returned: 0 },
    )
  }, [filteredReports])

  // -- Preview modal ---------------------------------------------------------

  async function openPreview(reportMeta) {
    setPreview({
      open: true,
      loading: true,
      reportNumber: reportMeta.report_number,
      meta: reportMeta,
      pdfDoc: null,
      pdfUrl: '',
      xlsxBlob: null,
      error: '',
    })

    try {
      const { data: rows, error } = await supabase.rpc('verifier_get_staled_check_report_detail', {
        p_report_number: reportMeta.report_number,
      })
      if (error) throw error
      if (!Array.isArray(rows)) throw new Error('Unexpected response while loading this report.')

      const docArgs = {
        reportNumber: reportMeta.report_number,
        generatedAt: reportMeta.generated_at,
        generatedByName: reportMeta.generated_by_name,
        submittedAt: reportMeta.submitted_at,
        submittedByName: reportMeta.submitted_by_name,
        status: reportMeta.status,
        decidedAt: reportMeta.decided_at,
        decidedByName: reportMeta.decided_by_name,
        rows,
      }

      const [pdfDoc, workbook] = await Promise.all([
        buildStaleCheckReportPdf(docArgs),
        buildStaleCheckReportWorkbook(docArgs),
      ])
      const buffer = await workbook.xlsx.writeBuffer()
      const xlsxBlob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const pdfUrl = pdfDoc.output('bloburl')

      setPreview((prev) => {
        if (!prev.open || prev.reportNumber !== reportMeta.report_number) {
          URL.revokeObjectURL(pdfUrl)
          return prev
        }
        return { ...prev, loading: false, pdfDoc, pdfUrl, xlsxBlob }
      })
    } catch (err) {
      console.error(`[StaleReportHistory] Failed to build preview for ${reportMeta.report_number}:`, err)
      setPreview((prev) =>
        prev.reportNumber === reportMeta.report_number
          ? { ...prev, loading: false, error: toErrorMessage(err, 'Failed to load this report.') }
          : prev,
      )
    }
  }

  function closePreview() {
    setPreview((prev) => {
      if (prev.pdfUrl) URL.revokeObjectURL(prev.pdfUrl)
      return {
        open: false,
        loading: false,
        reportNumber: '',
        meta: null,
        pdfDoc: null,
        pdfUrl: '',
        xlsxBlob: null,
        error: '',
      }
    })
  }

  function downloadPdf() {
    if (!preview.pdfDoc) return
    try {
      preview.pdfDoc.save(`staled-check-report-${preview.reportNumber}.pdf`)
    } catch (err) {
      console.error('[StaleReportHistory] PDF download failed:', err)
    }
  }

  function downloadExcel() {
    if (!preview.xlsxBlob) return
    try {
      downloadBlob(preview.xlsxBlob, `staled-check-report-${preview.reportNumber}.xlsx`)
    } catch (err) {
      console.error('[StaleReportHistory] Excel download failed:', err)
    }
  }

  function exportListCsv() {
    if (sortedReports.length === 0) return
    try {
      const header = [
        'Report No.',
        'Status',
        'Generated At',
        'Generated By',
        'Branches',
        'Submitted At',
        'Submitted By',
        'Decision',
        'Decided At',
        'Decided By',
        'Approved Count',
        'Returned Count',
        'Checks',
        'Total Amount',
        'Banks',
      ]
      const lines = sortedReports.map((r) => {
        const banks = resolvedBankNames(r)?.join('; ') || ''
        return [
          r.report_number,
          isSubmitted(r) ? 'Submitted' : 'Generated',
          r.generated_at ? new Date(r.generated_at).toISOString() : '',
          r.generated_by_name || '',
          getReportBranches(r).join('; '),
          r.submitted_at ? new Date(r.submitted_at).toISOString() : '',
          r.submitted_by_name || '',
          getDecisionState(r),
          r.decided_at ? new Date(r.decided_at).toISOString() : '',
          r.decided_by_name || '',
          r.approved_count ?? '',
          r.returned_count ?? '',
          r.check_count ?? 0,
          r.total_amount ?? 0,
          banks,
        ]
          .map(escapeCsvField)
          .join(',')
      })
      const csv = [header.map(escapeCsvField).join(','), ...lines].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      downloadBlob(blob, `staled-check-report-history-${new Date().toISOString().slice(0, 10)}.csv`)
    } catch (err) {
      console.error('[StaleReportHistory] CSV export failed:', err)
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (profileError) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Could not load your profile: {profileError}
      </div>
    )
  }

  if (!profileLoading && !isAllBranches && !pickupBranch) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Your account isn't assigned to a branch, so Report History can't determine which reports to show you.
        Please ask an admin to set your branch in your profile.
      </div>
    )
  }

  const rangeStart = sortedReports.length === 0 ? 0 : (clampedPage - 1) * pageSize + 1
  const rangeEnd = Math.min(clampedPage * pageSize, sortedReports.length)
  const isBusy = loading || profileLoading

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={exportListCsv} disabled={isBusy || sortedReports.length === 0}>
            <FileDown className="mr-2 h-3.5 w-3.5" />
            Export CSV
          </Button>
          <Button variant="outline" onClick={loadReports} disabled={isBusy}>
            {isBusy ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {!isBusy && filteredReports.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Reports" value={sortedReports.length} />
          <StatCard label="Checks" value={stats.checks.toLocaleString()} />
          <StatCard label="Total amount" value={formatCurrency(stats.amount)} tone="accent" />
          <StatCard label="Not submitted" value={stats.notSubmitted} />
          <StatCard label="Awaiting decision" value={stats.awaiting} />
          <StatCard label="Approved / Returned" value={`${stats.approved} / ${stats.returned}`} />
        </div>
      )}

      {loadError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {loadError}
          </span>
          <button
            onClick={loadReports}
            className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      )}

      <div className="mb-4 rounded-xl border border-ink-100 bg-white">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search report no., generated by, submitted by, decided by…"
              className="w-full rounded-md border border-ink-100 bg-ink-50/40 py-1.5 pl-8 pr-3 text-xs text-ink-700 placeholder:text-ink-300 focus:border-ledger-stamp focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
            />
          </div>

          <select
            value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
            className="rounded-md border border-ink-100 bg-white px-2.5 py-1.5 text-xs text-ink-600 focus:border-ledger-stamp focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            value={filters.decision}
            onChange={(e) => setFilters((f) => ({ ...f, decision: e.target.value }))}
            className="rounded-md border border-ink-100 bg-white px-2.5 py-1.5 text-xs text-ink-600 focus:border-ledger-stamp focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
          >
            {DECISION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFilters((v) => !v)}
            className={cn(showFilters && 'bg-ink-50')}
          >
            <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
            More filters
          </Button>

          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-ink-400 hover:text-ink-600"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}

          <span className="ml-auto text-[11px] text-ink-400">
            Showing {rangeStart}–{rangeEnd} of {sortedReports.length}
          </span>
        </div>

        {showFilters && (
          <div className="grid grid-cols-1 gap-3 border-t border-ink-100 px-3 py-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-ink-400">
                <CalendarRange className="h-3 w-3" /> Generated from
              </label>
              <input
                type="date"
                value={filters.dateFrom}
                max={filters.dateTo || undefined}
                onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
                className="w-full rounded-md border border-ink-100 bg-white px-2.5 py-1.5 text-xs text-ink-600 focus:border-ledger-stamp focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-ink-400">
                <CalendarRange className="h-3 w-3" /> Generated to
              </label>
              <input
                type="date"
                value={filters.dateTo}
                min={filters.dateFrom || undefined}
                onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
                className="w-full rounded-md border border-ink-100 bg-white px-2.5 py-1.5 text-xs text-ink-600 focus:border-ledger-stamp focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
              />
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-ink-400">
                <Building2 className="h-3 w-3" /> Branch
              </label>
              <select
                value={filters.branch}
                onChange={(e) => setFilters((f) => ({ ...f, branch: e.target.value }))}
                disabled={branchOptions.length === 0}
                className="w-full rounded-md border border-ink-100 bg-white px-2.5 py-1.5 text-xs text-ink-600 focus:border-ledger-stamp focus:outline-none focus:ring-1 focus:ring-ledger-stamp disabled:opacity-50"
              >
                <option value="all">{branchOptions.length ? 'All branches' : 'No branches'}</option>
                {branchOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-ink-400">
                <Landmark className="h-3 w-3" /> Bank
              </label>
              <select
                value={filters.bank}
                onChange={(e) => setFilters((f) => ({ ...f, bank: e.target.value }))}
                disabled={bankOptions.length === 0}
                className="w-full rounded-md border border-ink-100 bg-white px-2.5 py-1.5 text-xs text-ink-600 focus:border-ledger-stamp focus:outline-none focus:ring-1 focus:ring-ledger-stamp disabled:opacity-50"
              >
                <option value="all">{bankOptions.length ? 'All banks' : 'Loading banks…'}</option>
                {bankOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {!isBusy && scopedReports.length === 0 && !loadError ? (
        <div className="flex flex-col items-center rounded-xl border border-ink-100 bg-white py-16 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-ink-200 text-ink-300">
            <Inbox className="h-5 w-5" />
          </span>
          <p className="mt-3 text-sm font-medium text-ink-600">No Staled Check Reports have been generated yet</p>
        </div>
      ) : !isBusy && sortedReports.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-ink-100 bg-white py-16 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-ink-200 text-ink-300">
            <Search className="h-5 w-5" />
          </span>
          <p className="mt-3 text-sm font-medium text-ink-600">No reports match your current filters</p>
          <button onClick={clearFilters} className="mt-2 text-xs font-medium text-ledger-stampDark hover:underline">
            Clear filters
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ink-100 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 bg-ink-50/90 backdrop-blur">
              <tr className="border-b border-ink-100 text-[10px] uppercase tracking-wide text-ink-400">
                <th className="w-8 px-2 py-2" />
                <SortHeader label="Report No." sortKey="report_number" sort={sort} onSort={toggleSort} />
                <SortHeader label="Generated" sortKey="generated_at" sort={sort} onSort={toggleSort} />
                <SortHeader label="Submitted" sortKey="submitted_at" sort={sort} onSort={toggleSort} />
                <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                <SortHeader label="Decision" sortKey="decided_at" sort={sort} onSort={toggleSort} />
                <SortHeader label="Checks" sortKey="check_count" sort={sort} onSort={toggleSort} align="right" />
                <SortHeader label="Amount" sortKey="total_amount" sort={sort} onSort={toggleSort} align="right" />
                <th className="px-4 py-2 font-medium">Branches</th>
                <th className="px-4 py-2 font-medium">Banks</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>

            {isBusy ? (
              <TableSkeleton />
            ) : (
              <tbody className="divide-y divide-ink-50">
                {paginatedReports.map((r) => {
                  const generatedAt = formatDateTime(r.generated_at)
                  const submittedAt = formatDateTime(r.submitted_at)
                  const decidedAt = formatDateTime(r.decided_at)
                  const cacheEntry = detailCache[r.report_number]
                  const isHydrating = cacheEntry?.status === 'loading'
                  const hydrationErrored = cacheEntry?.status === 'error'
                  const isExpanded = expandedRows.has(r.report_number)

                  return (
                    <React.Fragment key={r.report_number}>
                      <tr className="hover:bg-ink-50/40">
                        <td className="px-2 py-2.5">
                          <button
                            type="button"
                            onClick={() => toggleExpandRow(r.report_number)}
                            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-ink-600"
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? 'Collapse check details' : 'Expand check details'}
                          >
                            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 font-mono font-medium text-ink-800">{r.report_number}</td>
                        <td className="px-4 py-2.5 text-ink-600">
                          <div>{generatedAt || '—'}</div>
                          <div className="text-[10px] text-ink-400">{r.generated_by_name || '—'}</div>
                        </td>
                        <td className="px-4 py-2.5 text-ink-600">
                          {submittedAt ? (
                            <>
                              <div>{submittedAt}</div>
                              <div className="text-[10px] text-ink-400">{r.submitted_by_name || '—'}</div>
                            </>
                          ) : (
                            <span className="text-ink-300">Not yet submitted</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge submitted={isSubmitted(r)} />
                        </td>
                        <td className="px-4 py-2.5">
                          <DecisionBadge report={r} />
                          {decidedAt && (
                            <div className="mt-0.5 text-[10px] text-ink-400">
                              {decidedAt}
                              {r.decided_by_name && ` · ${r.decided_by_name}`}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right text-ink-700">{r.check_count}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-ink-800">
                          {formatCurrency(r.total_amount)}
                        </td>
                        <td className="px-4 py-2.5">
                          <BranchList names={getReportBranches(r)} icon={Building2} />
                        </td>
                        <td className="px-4 py-2.5">
                          <NameList
                            names={resolvedBankNames(r)}
                            icon={Landmark}
                            loading={isHydrating}
                            errored={hydrationErrored}
                            onRetry={() => retryReportDetail(r.report_number)}
                          />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button size="sm" variant="outline" onClick={() => openPreview(r)}>
                            <Eye className="mr-1.5 h-3.5 w-3.5" /> Preview
                          </Button>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr>
                          <td colSpan={11} className="border-t border-dashed border-ink-100 bg-ink-50/30 p-0">
                            {isHydrating && (
                              <div className="flex items-center gap-2 px-4 py-4 text-xs text-ink-400">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Loading check details…
                              </div>
                            )}
                            {hydrationErrored && (
                              <div className="flex items-center justify-between gap-3 px-4 py-4 text-xs text-red-600">
                                <span className="flex items-center gap-2">
                                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                  Failed to load check details for this report.
                                </span>
                                <button
                                  onClick={() => retryReportDetail(r.report_number)}
                                  className="rounded-md border border-red-300 px-2 py-1 font-medium text-red-700 hover:bg-red-100"
                                >
                                  Retry
                                </button>
                              </div>
                            )}
                            {cacheEntry?.status === 'loaded' && (
                              <>
                                {r.decided_at && (
                                  <div className="flex flex-wrap items-center gap-2 border-b border-dashed border-ink-100 px-4 py-2.5 text-xs text-ink-500">
                                    <span className="font-medium text-ink-700">Approver decision:</span>
                                    <DecisionBadge report={r} />
                                    <span>
                                      decided {formatDateTime(r.decided_at)}
                                      {r.decided_by_name && ` by ${r.decided_by_name}`}
                                    </span>
                                  </div>
                                )}
                                <CheckDetailTable rows={cacheEntry.rows} />
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            )}
          </table>
        </div>
      )}

      {!isBusy && sortedReports.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-ink-500">
            <span>Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="rounded-md border border-ink-100 bg-white px-2 py-1 text-xs text-ink-600 focus:border-ledger-stamp focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={clampedPage <= 1}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-ink-100 text-ink-500 hover:bg-ink-50 disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="px-2 text-xs text-ink-500">
              Page {clampedPage} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={clampedPage >= totalPages}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-ink-100 text-ink-500 hover:bg-ink-50 disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {preview.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/50 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closePreview()
          }}
          role="dialog"
          aria-modal="true"
          aria-label={`Report ${preview.reportNumber} preview`}
        >
          <div className="flex h-full max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">Report {preview.reportNumber}</h3>
                {preview.meta && (
                  <p className="text-xs text-ink-400">
                    {preview.meta.check_count} checks · {formatCurrency(preview.meta.total_amount)}
                    {preview.meta.generated_at && <> · generated {formatDateTime(preview.meta.generated_at)}</>}
                    {preview.meta.submitted_at && <> · submitted {formatDateTime(preview.meta.submitted_at)}</>}
                    {preview.meta.decided_at && (
                      <>
                        {' '}
                        · decided {formatDateTime(preview.meta.decided_at)}
                        {preview.meta.decided_by_name && ` by ${preview.meta.decided_by_name}`}
                      </>
                    )}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={downloadExcel} disabled={!preview.xlsxBlob}>
                  <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" /> Excel
                </Button>
                <Button size="sm" variant="outline" onClick={downloadPdf} disabled={!preview.pdfDoc}>
                  <Download className="mr-1.5 h-3.5 w-3.5" /> PDF
                </Button>
                <button
                  onClick={closePreview}
                  className="rounded-full p-1.5 text-ink-300 hover:bg-ink-50 hover:text-ink-600"
                  aria-label="Close preview"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {preview.loading ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-300">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-xs">Building report preview…</span>
              </div>
            ) : preview.error ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-red-600">
                <span className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {preview.error}
                </span>
                <button
                  onClick={() => preview.meta && openPreview(preview.meta)}
                  className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                >
                  Retry
                </button>
              </div>
            ) : (
              <iframe title="Staled check report preview" src={preview.pdfUrl} className="flex-1 rounded-b-2xl" />
            )}
          </div>
        </div>
      )}
    </div>
  )
}