// src/pages/verifier/VerifierStaleApprovals.jsx
//
// Shows reports THIS verifier submitted that are still awaiting an
// approver's decision: status = 'submitted' AND decided_at IS NULL.
//
// A report only reaches 'submitted' once a verifier explicitly submits it;
// generating a report (possibly multiple times) leaves it at status =
// 'generated' until that happens. Unsubmitted drafts must never surface
// here as "awaiting decision" — they were never sent to an approver and
// never will be decided. Scoping is enforced both in the query and again
// client-side as defense-in-depth, mirroring the pattern used in
// StaleReportHistory.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FileClock, Layers, Building2, Loader2, RefreshCw, Inbox, AlertTriangle,
  Clock3, Search, X, SlidersHorizontal, ChevronDown, ChevronUp,
  ArrowUpDown, Landmark, Hash, BadgeCheck, BadgeX, BadgeHelp, ArrowUp, ArrowDown,
  RotateCcw,
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
const AWAITING_DECISION_STATUS = 'submitted'

// generated_by is the primary match key; generated_by_name is a fallback
// for rows where the id might not be populated. check_date and
// form_2307_attached feed badges in the detail table. status and
// decided_at both gate which reports belong on this page (see load()).
const REPORT_COLUMNS =
  'report_number, generated_by, generated_by_name, generated_at, submitted_at, submitted_by_name, status, decided_at, branches, check_ids'
const CHECK_COLUMNS =
  'id, amount, bank, pickup_branch, payee, payor, check_no, check_date, form_2307_attached, status'

const SORT_OPTIONS = [
  { value: 'generated_desc', label: 'Newest generated first' },
  { value: 'generated_asc', label: 'Oldest generated first' },
  { value: 'amount_desc', label: 'Highest amount' },
  { value: 'amount_asc', label: 'Lowest amount' },
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

// Merges report arrays into a de-duplicated list keyed by report_number,
// so the id-based and name-based lookups below never show a duplicate.
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

// Per-check status within an otherwise-pending report. Every check here
// should read "picked_up" or "pending_approval" — "returned" is kept as a
// defensive fallback in case of stale/inconsistent data.
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

// Every report on this page is, by construction, submitted and awaiting a
// decision — that's a fixed badge, not a branching status indicator.
function PendingStatusBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
      <Clock3 className="h-3 w-3" />
      Awaiting approver decision
    </span>
  )
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
// verifiers submitted these checks, they don't decide on them.
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

export default function VerifierStaleApprovals() {
  // `id` is the verifier's profiles.id (== auth.uid()), the same value
  // used as generated_by's FK target — it should already be available
  // wherever ProfileContext exposes `name`.
  const { id: myId, name, pickupBranch, isAllBranches, loading: profileLoading, error: profileError } = useProfile()

  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')

  const [searchTerm, setSearchTerm] = useState('')
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

      if (mode === 'initial') {
        setLoading(true)
      } else {
        setRefreshing(true)
      }
      setLoadError('')

      try {
        // Scoped to reports THIS verifier generated, in THIS verifier's
        // branch, that are submitted and still awaiting an approver's
        // decision. Two independent identity keys (id + name) are merged;
        // branch, status, and decided_at are enforced on top of both,
        // mirroring the RLS policy server-side. This isn't the security
        // boundary (RLS is) — it keeps the client from requesting rows
        // outside scope and keeps this page's "pending" framing accurate
        // even if the RPC/RLS drift.
        const branchLabel = !isAllBranches ? pickupBranch : null

        const queries = []

        if (myId) {
          let q = supabase
            .from('staled_check_reports')
            .select(REPORT_COLUMNS)
            .eq('generated_by', myId)
            .eq('status', AWAITING_DECISION_STATUS)
            .is('decided_at', null)
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
            .eq('status', AWAITING_DECISION_STATUS)
            .is('decided_at', null)
            .order('generated_at', { ascending: false })
            .limit(PAGE_SIZE)
          if (branchLabel) q = q.contains('branches', [branchLabel])
          queries.push(q)
        }

        const results = await Promise.all(queries)
        for (const { error } of results) {
          if (error) throw error
        }

        let data = mergeReportsByNumber(...results.map((r) => r.data))

        // Defense-in-depth: never trust the query filters alone to keep
        // unsubmitted drafts (status = 'generated') or decided reports off
        // this page. A verifier can generate a report multiple times
        // before submitting one of them — every earlier, unsubmitted
        // generation must never appear here as "awaiting decision", since
        // it was never sent to an approver and never will be.
        data = data.filter((r) => {
          const isEligible = r.status === AWAITING_DECISION_STATUS && !r.decided_at
          if (!isEligible) {
            console.warn(
              `[VerifierStaleApprovals] Dropped report ${r.report_number}: status="${r.status}", decided_at=${r.decided_at ?? 'null'} ` +
                `but matched the pending-reports query.`,
            )
          }
          return isEligible
        })

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
            // check_ids is the source of truth for which checks belong to
            // a report. A missing check row (e.g. hard-deleted) is
            // silently dropped from the cascade rather than crashing the
            // row — checkCount still reflects the original check_ids
            // length so any mismatch stays visible instead of hidden.
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

  // A report can leave this page mid-session (an approver decides on it
  // between polls) — drop any expanded id that no longer appears so we
  // don't leave a dangling expanded entry around.
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
      if (next.has(reportNumber)) {
        next.delete(reportNumber)
      } else {
        next.add(reportNumber)
      }
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
        bankFilter !== 'all',
        isAllBranches && branchFilter !== 'all',
        amountMin !== '',
        amountMax !== '',
      ].filter(Boolean).length,
    [bankFilter, branchFilter, isAllBranches, amountMin, amountMax]
  )

  function clearFilters() {
    setSearchTerm('')
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
        case 'generated_desc':
        default:
          return new Date(b.generated_at) - new Date(a.generated_at)
      }
    })

    return list
  }, [reports, searchTerm, bankFilter, branchFilter, isAllBranches, amountMin, amountMax, sortBy])

  const summary = useMemo(
    () => ({
      pendingCount: reports.length,
      pendingChecks: reports.reduce((sum, r) => sum + r.checkCount, 0),
      pendingAmount: reports.reduce((sum, r) => sum + r.totalAmount, 0),
    }),
    [reports]
  )

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
      {!loading && summary.pendingCount > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-ink-100 bg-white px-4 py-3 shadow-sm">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <Clock3 className="h-4 w-4" />
          </span>
          <p className="text-sm text-ink-600">
            <span className="font-semibold text-ink-900">{summary.pendingCount}</span> report{summary.pendingCount === 1 ? '' : 's'} awaiting approver
            decision · {summary.pendingChecks} checks · {formatCurrency(summary.pendingAmount)}
          </p>
        </div>
      )}

      <div className="mb-3 rounded-lg border border-ink-100 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search report #, bank, branch, payee, or check no..."
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
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-ink-100 pt-3 sm:grid-cols-3 lg:grid-cols-5">
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
              <div className="col-span-2 flex items-end sm:col-span-3 lg:col-span-5">
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
            {reports.length === 0 ? "You don't have any reports awaiting approver decision" : 'No reports match your filters'}
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
              <Card key={r.report_number} className="overflow-hidden border-ink-100 p-0 shadow-sm transition-shadow hover:border-ink-200 hover:shadow-md">
                <button
                  type="button"
                  onClick={() => toggleExpand(r.report_number)}
                  aria-expanded={expanded}
                  className="flex w-full flex-col gap-2 px-4 py-3.5 text-left transition hover:bg-ink-50/60"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-100 text-ink-500">
                        <FileClock className="h-3.5 w-3.5" />
                      </span>
                      <span className="font-semibold text-ink-900">Report {r.report_number}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <PendingStatusBadge />
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
                  </div>
                </button>

                {expanded && (
                  <div className="border-t border-dashed border-ink-100">
                    <ReportChecksTable checks={r.checks} />
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