// src/pages/verifier/VerifierStaleApprovals.jsx

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FileClock, Layers, Building2, Loader2, RefreshCw, Inbox, AlertTriangle,
  CheckCircle2, Clock3, Search, X, SlidersHorizontal, ChevronDown, ChevronUp,
  ArrowUpDown, Landmark, Hash, BadgeCheck, BadgeX, BadgeHelp, ArrowUp, ArrowDown,
  RotateCcw, CalendarClock, MessageSquareQuote,
} from 'lucide-react'
import { useProfile } from '../../context/ProfileContext'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import { STALE_BUCKETS, getStaleBucket } from '../../lib/staleChecks'

const PAGE_SIZE = 100
const POLL_INTERVAL_MS = 15000
const MAX_ROWS_PER_REPORT = 300

const UNSPECIFIED_BANK = 'Unspecified bank'
const UNSPECIFIED_BRANCH = 'No branch on file'

// generated_by is the primary match key. check_date / form_2307_attached
// feed the badges in the detail table; return_reason / returned_at /
// returned_by_name feed the return-audit cards — these already exist on
// `checks` from the general pickup workflow, so no schema change needed,
// just selecting them.
const REPORT_COLUMNS =
  'report_number, generated_by, generated_by_name, generated_at, submitted_at, submitted_by_name, status, decided_at, decided_by_name, approved_count, returned_count, branches, check_ids'
const CHECK_COLUMNS =
  'id, amount, bank, pickup_branch, payee, payor, check_no, check_date, form_2307_attached, status, return_reason, returned_at, returned_by_name'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'awaiting', label: 'Awaiting decision' },
  { value: 'decided', label: 'Decided' },
  { value: 'has_returns', label: 'Has returns' },
]

const SORT_OPTIONS = [
  { value: 'generated_desc', label: 'Newest generated first' },
  { value: 'generated_asc', label: 'Oldest generated first' },
  { value: 'amount_desc', label: 'Highest amount' },
  { value: 'amount_asc', label: 'Lowest amount' },
  { value: 'returns_desc', label: 'Most returned first' },
]

const AVATAR_PALETTE = [
  'bg-rose-500', 'bg-orange-500', 'bg-amber-500', 'bg-lime-500', 'bg-emerald-500',
  'bg-teal-500', 'bg-cyan-500', 'bg-blue-500', 'bg-indigo-500', 'bg-violet-500', 'bg-fuchsia-500',
]

function normalizeBank(bank) {
  return (typeof bank === 'string' ? bank.trim() : '') || UNSPECIFIED_BANK
}

function normalizeBranch(branch) {
  return (typeof branch === 'string' ? branch.trim() : '') || UNSPECIFIED_BRANCH
}

function attachment2307State(raw) {
  const value = String(raw ?? '').trim().toUpperCase()
  if (value === 'Y') return 'yes'
  if (value === 'N') return 'no'
  return 'unset'
}

function safeCurrency(amount) {
  const n = Number(amount)
  return Number.isFinite(n) ? formatCurrency(n) : '—'
}

function parseAmountBound(raw) {
  if (raw === '' || raw === null || raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function formatDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// Short relative label ("3h ago") for recent timestamps. Returns null
// once it's more than 30 days out so the UI falls back to the absolute
// date/time only — a "42d ago" label reads worse than just the date.
function formatRelativeTime(ts) {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  const diffMs = Date.now() - d.getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return null
}

function getInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function avatarColorClass(name) {
  const s = name || ''
  let hash = 0
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
}

// Merge two report arrays into a single de-duplicated list, keyed by
// report_number. Used to combine the id-based and name-based lookups
// below without ever showing the same report twice.
function mergeReportsByNumber(...lists) {
  const map = new Map()
  for (const list of lists) {
    for (const r of list || []) map.set(r.report_number, r)
  }
  return [...map.values()]
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

function bankBadgeClass(bank) {
  if (bank === UNSPECIFIED_BANK) return 'bg-ink-100 text-ink-500'
  let hash = 0
  for (let i = 0; i < bank.length; i += 1) hash = (hash * 31 + bank.charCodeAt(i)) >>> 0
  return BANK_BADGE_PALETTE[hash % BANK_BADGE_PALETTE.length]
}

function BankBadge({ bank }) {
  const label = normalizeBank(bank)
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', bankBadgeClass(label))} title={label}>
      <Landmark className="h-3 w-3 shrink-0" />
      <span className="max-w-[110px] truncate">{label}</span>
    </span>
  )
}

function StaleBucketBadge({ checkDate }) {
  const isStale = getStaleBucket(checkDate) === STALE_BUCKETS.STALE
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', isStale ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700')}>
      <AlertTriangle className="h-2.5 w-2.5" />
      {isStale ? 'Stale' : 'Nearing stale'}
    </span>
  )
}

function Attachment2307Badge({ value }) {
  const state = attachment2307State(value)
  if (state === 'yes')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <BadgeCheck className="h-2.5 w-2.5" /> Attached
      </span>
    )
  if (state === 'no')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium text-ink-500">
        <BadgeX className="h-2.5 w-2.5" /> Not attached
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink-50 px-2 py-0.5 text-[10px] font-medium text-ink-400">
      <BadgeHelp className="h-2.5 w-2.5" /> Not set
    </span>
  )
}

// Per-check disposition, independent of the report-level decided_at
// badge. A report can be "decided" while individual checks within it
// ended up with different outcomes — this reads straight off
// checks.status so the cascade never has to guess.
function CheckOutcomeBadge({ status }) {
  if (status === 'returned')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700 ring-1 ring-inset ring-orange-200">
        <RotateCcw className="h-2.5 w-2.5" /> Returned
      </span>
    )
  if (status === 'pending_approval')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
        Awaiting decision
      </span>
    )
  if (status === 'picked_up')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        Picked up
      </span>
    )
  if (status)
    return <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium text-ink-500 capitalize">{status}</span>
  return null
}

// Report-level status pill with distinct states for fully-confirmed,
// mixed, and fully-returned outcomes — a report where every check bounced
// back reads very differently to a verifier than one where a single check
// was returned, so these get visually distinct treatment rather than one
// generic "decided" badge.
function ReportStatusBadge({ report }) {
  if (!report.decided_at) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
        <Clock3 className="h-3 w-3" />
        Awaiting approver decision
      </span>
    )
  }

  const approved = report.approved_count ?? 0
  const returned = report.returned_count ?? 0

  if (returned > 0 && approved === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700 ring-1 ring-inset ring-orange-200">
        <RotateCcw className="h-3 w-3" />
        All {returned} returned to pool
      </span>
    )
  }

  if (returned > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
        <CheckCircle2 className="h-3 w-3" />
        {approved} confirmed · {returned} returned
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
      <CheckCircle2 className="h-3 w-3" />
      All {approved} confirmed stale
    </span>
  )
}

// Left-border accent so a report's outcome is legible at a glance in the
// collapsed list, before expanding into the detail table.
function reportAccentClass(r) {
  if (!r.decided_at) return 'border-l-4 border-l-amber-400'
  const approved = r.approved_count ?? 0
  const returned = r.returned_count ?? 0
  if (returned > 0 && approved === 0) return 'border-l-4 border-l-orange-500'
  if (returned > 0) return 'border-l-4 border-l-amber-500'
  return 'border-l-4 border-l-emerald-500'
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-400">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function SortHeader({ label, active, dir, onClick, className }) {
  return (
    <th className={cn('px-2 py-2 font-medium', className)}>
      <button type="button" onClick={onClick} className={cn('flex items-center gap-1 hover:text-ink-700', active && 'text-ledger-stampDark')}>
        {label}
        {active ? (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </button>
    </th>
  )
}

// Cascading check-level detail table for a single report. Read-only —
// verifiers submitted these checks, they don't decide on them, so this
// intentionally has no selection/decision controls (unlike the
// approver's equivalent table).
function ReportChecksTable({ checks }) {
  const [sortKey, setSortKey] = useState('default')
  const [sortDir, setSortDir] = useState('asc')

  const sortedChecks = useMemo(() => {
    if (sortKey === 'default') return checks
    const factor = sortDir === 'asc' ? 1 : -1
    return [...checks].sort((a, b) => {
      if (sortKey === 'amount') return ((Number(a.amount) || 0) - (Number(b.amount) || 0)) * factor
      if (sortKey === 'checkdate') return (new Date(a.check_date).getTime() - new Date(b.check_date).getTime()) * factor
      return 0
    })
  }, [checks, sortKey, sortDir])

  function toggleSort(key) {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
    } else if (sortDir === 'asc') {
      setSortDir('desc')
    } else {
      setSortKey('default')
      setSortDir('asc')
    }
  }

  const truncated = sortedChecks.length > MAX_ROWS_PER_REPORT
  const visibleChecks = truncated ? sortedChecks.slice(0, MAX_ROWS_PER_REPORT) : sortedChecks

  if (checks.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-xs text-ink-400">
        <Inbox className="h-3.5 w-3.5 shrink-0" />
        No check details could be loaded for this report.
      </div>
    )
  }

  return (
    <>
      {truncated && (
        <div className="flex items-center gap-2 border-b border-dashed border-ink-100 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Showing the first {MAX_ROWS_PER_REPORT} of {sortedChecks.length} checks on this report.
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-dashed border-ink-100 text-left font-mono text-[11px] uppercase tracking-wide text-ink-400">
              <th className="px-4 py-2 font-medium">Check no.</th>
              <th className="px-2 py-2 font-medium">Bank</th>
              <th className="px-2 py-2 font-medium">Branch</th>
              <th className="px-2 py-2 font-medium">Payee</th>
              <SortHeader label="Check date" active={sortKey === 'checkdate'} dir={sortDir} onClick={() => toggleSort('checkdate')} />
              <SortHeader label="Amount" active={sortKey === 'amount'} dir={sortDir} onClick={() => toggleSort('amount')} className="text-right" />
              <th className="px-2 py-2 font-medium">Bucket</th>
              <th className="px-2 py-2 font-medium">2307</th>
              <th className="px-2 py-2 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dashed divide-ink-50">
            {visibleChecks.map((c, idx) => (
              <tr key={c.id ?? idx} className={cn('transition-colors hover:bg-ink-50/60', c.status === 'returned' && 'bg-orange-50/40')}>
                <td className="px-4 py-3 font-mono text-xs text-ink-700">
                  <span className="flex items-start gap-1">
                    <Hash className="mt-0.5 h-3 w-3 shrink-0 text-ink-300" />
                    <span className="break-all">{c.check_no ?? '—'}</span>
                  </span>
                </td>
                <td className="px-2 py-2.5">
                  <BankBadge bank={c.bank} />
                </td>
                <td className="max-w-[120px] truncate px-2 py-2.5 text-ink-600" title={c.pickup_branch || undefined}>
                  {c.pickup_branch || '—'}
                </td>
                <td className="max-w-[160px] truncate px-2 py-2.5 font-medium text-ink-900" title={c.payee || undefined}>
                  {c.payee || '—'}
                </td>
                <td className="px-2 py-2.5 text-ink-600">{c.check_date ? formatDate(c.check_date) : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono font-medium text-ink-700">{safeCurrency(c.amount)}</td>
                <td className="px-2 py-2.5">
                  <StaleBucketBadge checkDate={c.check_date} />
                </td>
                <td className="px-2 py-2.5">
                  <Attachment2307Badge value={c.form_2307_attached} />
                </td>
                <td className="px-2 py-2.5">
                  <CheckOutcomeBadge status={c.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// A single returned check's audit trail: who returned it, when (absolute
// + relative), and why. Renders a graceful "no reason recorded" state
// rather than an empty blank, since return_reason can legitimately be
// null on rows written before reasons were required.
function ReturnAuditCard({ check }) {
  const relative = formatRelativeTime(check.returned_at)
  const absolute = formatDateTime(check.returned_at)

  return (
    <div className="group relative overflow-hidden rounded-xl border border-orange-200/70 bg-gradient-to-br from-orange-50/70 via-white to-white p-4 shadow-sm transition duration-150 hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm ring-2 ring-white',
              avatarColorClass(check.returned_by_name)
            )}
          >
            {getInitials(check.returned_by_name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-900">{check.returned_by_name || 'Unknown approver'}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1 font-mono text-[11px] text-ink-400">
              <CalendarClock className="h-3 w-3 shrink-0" />
              <span>{absolute}</span>
              {relative && <span className="text-ink-300">· {relative}</span>}
            </p>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-orange-100 px-2.5 py-1 text-[11px] font-semibold text-orange-700 ring-1 ring-inset ring-orange-200">
          <RotateCcw className="h-3 w-3" />
          Returned
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-dashed border-orange-100 pt-3 text-xs text-ink-500">
        <span className="flex items-center gap-1 font-mono text-ink-600">
          <Hash className="h-3 w-3 shrink-0 text-ink-300" />
          {check.check_no || '—'}
        </span>
        <span className="text-ink-300">·</span>
        <span className="max-w-[140px] truncate font-medium text-ink-700" title={check.payee || undefined}>
          {check.payee || '—'}
        </span>
        <span className="text-ink-300">·</span>
        <span className="font-mono font-semibold text-ink-800">{safeCurrency(check.amount)}</span>
      </div>

      {check.return_reason ? (
        <div className="relative mt-3 rounded-lg bg-ink-50/80 px-3 py-2.5">
          <MessageSquareQuote className="absolute left-2 top-2 h-3.5 w-3.5 text-orange-300" />
          <p className="pl-5 text-sm italic leading-snug text-ink-700">"{check.return_reason}"</p>
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-1.5 text-xs italic text-ink-300">
          <BadgeHelp className="h-3 w-3 shrink-0" />
          No reason was recorded for this return.
        </p>
      )}
    </div>
  )
}

// Groups every returned check in a report into a dedicated audit section,
// separate from the main table — this is the "who returned it, when, and
// why" detail the verifier actually needs to act on, so it gets its own
// visual weight instead of being buried as a table cell.
function ReturnDetailsSection({ checks }) {
  const returnedChecks = useMemo(() => checks.filter((c) => c.status === 'returned'), [checks])
  if (returnedChecks.length === 0) return null

  return (
    <div className="border-t border-dashed border-ink-100 bg-gradient-to-b from-orange-50/50 to-transparent px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600">
          <RotateCcw className="h-3.5 w-3.5" />
        </span>
        <h3 className="text-sm font-semibold text-ink-800">Return details</h3>
        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700">{returnedChecks.length}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {returnedChecks.map((c) => (
          <ReturnAuditCard key={c.id} check={c} />
        ))}
      </div>
    </div>
  )
}

export default function VerifierStaleApprovals() {
  // NOTE: `id` is the verifier's profiles.id (== auth.uid()). If your
  // ProfileContext doesn't currently expose it, add it there — it's the
  // same id already used as generated_by's FK target, so it should be
  // trivially available from the same session/profile row that gives you
  // `name`.
  const { id: myId, name, pickupBranch, isAllBranches, loading: profileLoading, error: profileError } = useProfile()

  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')

  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [bankFilter, setBankFilter] = useState('all')
  const [branchFilter, setBranchFilter] = useState('all')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')
  const [sortBy, setSortBy] = useState('generated_desc')
  const [showFilters, setShowFilters] = useState(false)
  const [expandedIds, setExpandedIds] = useState(() => new Set())

  const myName = (name || '').trim()

  const load = useCallback(
    async (mode = 'initial') => {
      if (profileLoading) return
      if (!myId && !myName) {
        setReports([])
        setLoading(false)
        return
      }

      mode === 'initial' ? setLoading(true) : setRefreshing(true)
      setLoadError('')

      try {
        // Scoped to reports THIS verifier generated, in THIS verifier's
        // branch. Two independent identity keys (id + name) are merged;
        // branch is enforced on top of both, mirroring the RLS policy
        // server-side — this isn't the security boundary (RLS is), it
        // just keeps the client from requesting rows outside scope and
        // keeps the "showing your submissions for X" banner accurate.
        const branchLabel = !isAllBranches ? pickupBranch : null

        const queries = []

        if (myId) {
          let q = supabase
            .from('staled_check_reports')
            .select(REPORT_COLUMNS)
            .eq('generated_by', myId)
            .order('generated_at', { ascending: false })
            .limit(PAGE_SIZE)
          if (branchLabel) q = q.contains('branches', [branchLabel])
          queries.push(q)
        }

        if (myName) {
          let q = supabase
            .from('staled_check_reports')
            .select(REPORT_COLUMNS)
            .ilike('generated_by_name', myName)
            .order('generated_at', { ascending: false })
            .limit(PAGE_SIZE)
          if (branchLabel) q = q.contains('branches', [branchLabel])
          queries.push(q)
        }

        const results = await Promise.all(queries)
        for (const { error } of results) {
          if (error) throw error
        }

        const data = mergeReportsByNumber(...results.map((r) => r.data))
        data.sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at))

        const allCheckIds = [...new Set(data.flatMap((r) => r.check_ids || []))]
        let checksById = new Map()

        if (allCheckIds.length > 0) {
          const { data: checkRows, error: checksError } = await supabase.from('checks').select(CHECK_COLUMNS).in('id', allCheckIds)
          if (checksError) throw checksError
          checksById = new Map((checkRows || []).map((c) => [c.id, c]))
        }

        setReports(
          data.map((r) => {
            // check_ids on the report is the source of truth for which
            // checks belong to it. If a check id has no matching row (e.g.
            // it was hard-deleted), it's silently dropped from the
            // cascade rather than crashing the row — checkCount below
            // still reflects the original check_ids length so a mismatch
            // is visible instead of hidden.
            const checks = (r.check_ids || []).map((id) => checksById.get(id)).filter(Boolean)
            const banks = [...new Set(checks.map((c) => normalizeBank(c.bank)))]
            const branches = [...new Set(checks.map((c) => normalizeBranch(c.pickup_branch)))]
            return {
              ...r,
              checks,
              checkCount: (r.check_ids || []).length,
              totalAmount: checks.reduce((sum, c) => sum + (Number(c.amount) || 0), 0),
              banks,
              branches,
            }
          })
        )
      } catch (err) {
        setLoadError(err?.message || 'Failed to load your report submissions. Please try again.')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [profileLoading, myId, myName, pickupBranch, isAllBranches]
  )

  useEffect(() => {
    load('initial')
  }, [load])

  useEffect(() => {
    const interval = setInterval(() => load('refresh'), POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [load])

  // Keep only expanded ids that still exist after a refresh, so a report
  // that dropped out of scope (e.g. filters changed) doesn't leave a
  // dangling expanded entry around.
  useEffect(() => {
    setExpandedIds((prev) => {
      if (prev.size === 0) return prev
      const validIds = new Set(reports.map((r) => r.report_number))
      const next = new Set([...prev].filter((id) => validIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [reports])

  function toggleExpand(reportNumber) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.has(reportNumber) ? next.delete(reportNumber) : next.add(reportNumber)
      return next
    })
  }

  const bankOptions = useMemo(() => {
    const set = new Set(reports.flatMap((r) => r.banks))
    return [...set].sort((a, b) => (a === UNSPECIFIED_BANK ? 1 : b === UNSPECIFIED_BANK ? -1 : a.localeCompare(b)))
  }, [reports])

  const branchOptions = useMemo(() => {
    const set = new Set(reports.flatMap((r) => r.branches))
    return [...set].sort((a, b) => (a === UNSPECIFIED_BRANCH ? 1 : b === UNSPECIFIED_BRANCH ? -1 : a.localeCompare(b)))
  }, [reports])

  const activeFilterCount = useMemo(
    () =>
      [
        statusFilter !== 'all',
        bankFilter !== 'all',
        isAllBranches && branchFilter !== 'all',
        amountMin !== '',
        amountMax !== '',
      ].filter(Boolean).length,
    [statusFilter, bankFilter, branchFilter, isAllBranches, amountMin, amountMax]
  )

  function clearFilters() {
    setSearchTerm('')
    setStatusFilter('all')
    setBankFilter('all')
    setBranchFilter('all')
    setAmountMin('')
    setAmountMax('')
  }

  const visibleReports = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    const min = parseAmountBound(amountMin)
    const max = parseAmountBound(amountMax)

    const list = reports.filter((r) => {
      if (statusFilter === 'awaiting' && r.decided_at) return false
      if (statusFilter === 'decided' && !r.decided_at) return false
      if (statusFilter === 'has_returns' && !(r.decided_at && (r.returned_count ?? 0) > 0)) return false
      if (bankFilter !== 'all' && !r.banks.includes(bankFilter)) return false
      if (isAllBranches && branchFilter !== 'all' && !r.branches.includes(branchFilter)) return false
      if (min !== null && r.totalAmount < min) return false
      if (max !== null && r.totalAmount > max) return false
      if (term) {
        const haystack = [
          r.report_number,
          ...r.banks,
          ...r.branches,
          ...r.checks.map((c) => c.payee),
          ...r.checks.map((c) => c.check_no),
          ...r.checks.map((c) => c.return_reason),
          ...r.checks.map((c) => c.returned_by_name),
        ]
        if (!haystack.some((v) => String(v || '').toLowerCase().includes(term))) return false
      }
      return true
    })

    list.sort((a, b) => {
      switch (sortBy) {
        case 'generated_asc':
          return new Date(a.generated_at) - new Date(b.generated_at)
        case 'amount_desc':
          return b.totalAmount - a.totalAmount
        case 'amount_asc':
          return a.totalAmount - b.totalAmount
        case 'returns_desc':
          return (b.returned_count ?? 0) - (a.returned_count ?? 0)
        case 'generated_desc':
        default:
          return new Date(b.generated_at) - new Date(a.generated_at)
      }
    })

    return list
  }, [reports, searchTerm, statusFilter, bankFilter, branchFilter, isAllBranches, amountMin, amountMax, sortBy])

  const summary = useMemo(() => {
    const pending = reports.filter((r) => !r.decided_at)
    const returnedChecksTotal = reports.reduce((sum, r) => sum + (r.decided_at ? r.returned_count ?? 0 : 0), 0)
    const reportsWithReturns = reports.filter((r) => r.decided_at && (r.returned_count ?? 0) > 0).length
    return {
      totalCount: reports.length,
      pendingCount: pending.length,
      pendingChecks: pending.reduce((sum, r) => sum + r.checkCount, 0),
      pendingAmount: pending.reduce((sum, r) => sum + r.totalAmount, 0),
      returnedChecksTotal,
      reportsWithReturns,
    }
  }, [reports])

  if (profileError) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Could not load your profile: {profileError}
      </div>
    )
  }

  if (!profileLoading && !myId && !myName) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Could not identify your account, so your submissions can't be looked up.
      </div>
    )
  }

  return (
    <div>
     

      {!loading && summary.reportsWithReturns > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-orange-200 bg-gradient-to-r from-orange-50 via-amber-50 to-orange-50 px-4 py-3 shadow-sm">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-600">
            <RotateCcw className="h-4 w-4" />
          </span>
          <div className="text-sm">
            <p className="font-semibold text-orange-800">
              {summary.returnedChecksTotal} check{summary.returnedChecksTotal === 1 ? '' : 's'} across {summary.reportsWithReturns} report
              {summary.reportsWithReturns === 1 ? '' : 's'} {summary.returnedChecksTotal === 1 ? 'was' : 'were'} returned to the pool.
            </p>
            <p className="mt-0.5 text-orange-700/80">Expand a report below to see who returned each check, when, and why.</p>
          </div>
        </div>
      )}

      <div className="mb-3 rounded-lg border border-ink-100 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search report #, bank, branch, payee, check no, or return reason..."
              className="border-ink-200 pl-8 pr-8 text-xs focus-visible:ring-ledger-stamp"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
              showFilters || activeFilterCount > 0
                ? 'border-ledger-stamp/40 bg-ledger-stamp/5 text-ledger-stampDark'
                : 'border-ink-200 text-ink-500 hover:bg-ink-50',
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters
            {activeFilterCount > 0 && (
              <span className="flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-ledger-stamp px-1 text-[10px] font-semibold text-white">
                {activeFilterCount}
              </span>
            )}
            {showFilters ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </button>

          <button
            onClick={() => load('refresh')}
            disabled={refreshing || loading}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>

        {showFilters && (
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-ink-100 pt-3 sm:grid-cols-3 lg:grid-cols-6">
            <FilterSelect label="Status" value={statusFilter} onChange={setStatusFilter} options={STATUS_OPTIONS} />
            <FilterSelect
              label="Bank"
              value={bankFilter}
              onChange={setBankFilter}
              options={[{ value: 'all', label: 'All banks' }, ...bankOptions.map((b) => ({ value: b, label: b }))]}
            />
            {isAllBranches && (
              <FilterSelect
                label="Branch"
                value={branchFilter}
                onChange={setBranchFilter}
                options={[{ value: 'all', label: 'All branches' }, ...branchOptions.map((b) => ({ value: b, label: b }))]}
              />
            )}
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-400">Min amount</label>
              <input
                type="number"
                inputMode="decimal"
                value={amountMin}
                onChange={(e) => setAmountMin(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-md border border-ink-200 px-2.5 py-1.5 text-xs text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-400">Max amount</label>
              <input
                type="number"
                inputMode="decimal"
                value={amountMax}
                onChange={(e) => setAmountMax(e.target.value)}
                placeholder="No limit"
                className="w-full rounded-md border border-ink-200 px-2.5 py-1.5 text-xs text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-ink-400">
                <ArrowUpDown className="h-3 w-3" /> Sort
              </label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {activeFilterCount > 0 && (
              <div className="col-span-2 flex items-end sm:col-span-3 lg:col-span-6">
                <button onClick={clearFilters} className="text-xs font-medium text-ledger-stamp hover:underline">
                  Clear filters
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {loadError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {loadError}
          </span>
          <button onClick={() => load('refresh')} className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium hover:bg-red-100">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-ink-300">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : visibleReports.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-ink-200 text-ink-300">
            <Inbox className="h-5 w-5" />
          </span>
          <p className="mt-3 text-sm font-medium text-ink-600">
            {reports.length === 0 ? "You haven't submitted any stale check reports yet" : 'No reports match your filters'}
          </p>
          {reports.length > 0 && activeFilterCount > 0 && (
            <button onClick={clearFilters} className="mt-2 text-xs font-medium text-ledger-stamp hover:underline">
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          {visibleReports.map((r) => {
            const expanded = expandedIds.has(r.report_number)
            return (
              <Card key={r.report_number} className={cn('overflow-hidden border-ink-100 p-0 shadow-sm transition-shadow hover:shadow-md', reportAccentClass(r))}>
                <button
                  type="button"
                  onClick={() => toggleExpand(r.report_number)}
                  aria-expanded={expanded}
                  className="flex w-full flex-col gap-2 px-4 py-3 text-left transition hover:bg-ink-50/60"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <FileClock className="h-4 w-4 text-amber-500" />
                      <span className="font-semibold text-ink-900">Report {r.report_number}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <ReportStatusBadge report={r} />
                      {expanded ? <ChevronUp className="h-4 w-4 text-ink-300" /> : <ChevronDown className="h-4 w-4 text-ink-300" />}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                    <span className="flex items-center gap-1">
                      <Layers className="h-3 w-3" /> {r.checkCount} checks · {formatCurrency(r.totalAmount)}
                    </span>
                    {r.banks.length > 0 && (
                      <span className="flex items-center gap-1">
                        <Landmark className="h-3 w-3" /> {r.banks.join(', ')}
                      </span>
                    )}
                    {r.branches.length > 0 && (
                      <span className="flex items-center gap-1">
                        <Building2 className="h-3 w-3" /> {r.branches.join(', ')}
                      </span>
                    )}
                    <span>Generated {formatDateTime(r.generated_at)}</span>
                    {r.submitted_at && <span>· Submitted {formatDateTime(r.submitted_at)}</span>}
                    {r.decided_at && <span>· Decided {formatDate(r.decided_at)} by {r.decided_by_name || '—'}</span>}
                  </div>
                </button>

                {expanded && (
                  <div className="border-t border-dashed border-ink-100">
                    <ReportChecksTable checks={r.checks} />
                    <ReturnDetailsSection checks={r.checks} />
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}