// src/pages/approver/ApproverStaleReports.jsx
//
// Approver-side decisioning for Staled Check Reports. Groups by
// report_number (never by pickup_reservation) and only ever finalizes a
// "confirmed stale" or "returned to pool" disposition — nothing here is
// released to a collector.
//
// Backend: public.approver_decide_staled_report(report_number, decisions)
// validates against staled_check_reports.check_ids server-side with row
// locking and per-check optimistic-concurrency guards.
//
// Branch scoping: profiles.branch stores machine-readable codes
// (csba_parqal / csba_bgc / all_branches); checks.pickup_branch stores the
// human-readable label collectors/verifiers actually typed. BRANCH_CODE_TO_LABEL
// is the single translation point between the two — update it there if
// either vocabulary changes. The corresponding Postgres RLS policy on
// `checks` must apply the same translation; a client-side filter alone is
// not the access boundary.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RefreshCw, Search, X, Check, RotateCcw, Loader2, AlertTriangle, Hash, Layers,
  ChevronDown, ChevronUp, CheckSquare, Square, MinusSquare, Download, ArrowUpDown,
  ArrowUp, ArrowDown, CheckCircle2, ShieldCheck, ShieldAlert, Pause, Play, Stamp,
  Hourglass, SlidersHorizontal, Landmark, Building2, BadgeCheck, BadgeX, BadgeHelp,
  FileClock, Inbox, Lock, WifiOff, Info, ChevronsDown,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import { useProfile, hasRole } from '../../context/ProfileContext'
import { STALE_BUCKETS, getStaleBucket } from '../../lib/staleChecks'

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const STALE_LINK_COLUMN = 'report_number'
const BRANCH_COLUMN = 'pickup_branch'

const PAGE_SIZE = 100
const POLL_INTERVAL_MS = 20000
const SUCCESS_FLASH_MS = 900
const ALLOWED_ROLES = ['approver', 'admin']
const REMARKS_MAX_LEN = 200
const MAX_ROWS_PER_REPORT = 300
const RETRY_DELAYS_MS = [400, 1200]
const FETCH_TIMEOUT_MS = 20000
const SEARCH_DEBOUNCE_MS = 250

const UNSPECIFIED_BRANCH = 'No branch on file'
const UNSPECIFIED_BANK = 'Unspecified bank'

// profiles.branch (code) -> checks.pickup_branch (label)
const BRANCH_CODE_TO_LABEL = {
  csba_parqal: 'CSBA - PARQAL',
  csba_bgc: 'CSBA - BGC',
}
const UNRESTRICTED_BRANCH_CODE = 'all_branches'

const SELECT_COLUMNS =
  'id, status, payee, payor, check_no, check_date, amount, bank, pickup_branch, form_2307_attached, submitted_by_name, submitted_at, report_number'
const REPORT_SELECT_COLUMNS =
  'report_number, generated_by_name, generated_at, submitted_at, submitted_by_name, decided_at, check_ids'
const REPORT_PAGE_SIZE = 50
const SORT_OPTIONS = [
  { value: 'submitted_asc', label: 'Oldest submitted first' },
  { value: 'submitted_desc', label: 'Newest submitted first' },
  { value: 'amount_desc', label: 'Highest amount' },
  { value: 'amount_asc', label: 'Lowest amount' },
  { value: 'checkdate_asc', label: 'Check date — oldest first' },
]

const BUCKET_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'stale', label: 'Stale' },
  { value: 'nearing', label: 'Nearing stale' },
]

const ATTACHMENT_FILTER_OPTIONS = [
  { value: 'all', label: '2307: All' },
  { value: 'yes', label: '2307: Attached' },
  { value: 'no', label: '2307: Not attached' },
  { value: 'unset', label: '2307: Not set' },
]

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const PHASE_LABELS = {
  verifying: 'Verifying latest status…',
  submitting: 'Submitting decisions…',
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function normalizeBank(bank) {
  return (typeof bank === 'string' ? bank.trim() : '') || UNSPECIFIED_BANK
}

function normalizeBranch(branch) {
  return (typeof branch === 'string' ? branch.trim() : '') || UNSPECIFIED_BRANCH
}

function branchKey(branch) {
  return normalizeBranch(branch).trim().toLowerCase()
}

// Resolves a profiles.branch code to the checks.pickup_branch label it
// should be compared against. Returns null for "unrestricted" (admin-like)
// codes and for anything not in BRANCH_CODE_TO_LABEL — callers must treat
// null-with-a-real-code as a config gap, not as "no restriction".
function resolveBranchLabel(code) {
  if (!code || code === UNRESTRICTED_BRANCH_CODE) return null
  return BRANCH_CODE_TO_LABEL[code] || null
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

function orderTotal(items) {
  return items.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
}

function earliestSubmittedAt(items) {
  const times = items
    .map((c) => c.submitted_at)
    .filter(Boolean)
    .map((t) => new Date(t).getTime())
    .filter(Number.isFinite)
  return times.length ? Math.min(...times) : null
}

function formatMinutesDuration(mins) {
  if (mins === null || mins === undefined || Number.isNaN(mins)) return '—'
  const whole = Math.max(0, Math.round(mins))
  if (whole < 60) return `${whole}m`
  return `${Math.floor(whole / 60)}h ${whole % 60}m`
}

function parseAmountBound(raw) {
  if (raw === '' || raw === null || raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function buildGroupsFromReports(reports, checksById, requiredBranch) {
  const required = requiredBranch ? branchKey(requiredBranch) : null
  const groups = []

  for (const report of reports || []) {
    const items = (report.check_ids || [])
      .map((id) => checksById.get(id))
      .filter(Boolean)
      .filter((c) => !required || branchKey(c.pickup_branch) === required)
      .map((c) => ({
        id: c.id,
        checkId: c.id,
        reportNumber: report.report_number,
        payee: c.payee,
        payor: c.payor,
        check_no: c.check_no,
        check_date: c.check_date,
        amount: c.amount,
        bank: c.bank,
        pickup_branch: c.pickup_branch,
        form_2307_attached: c.form_2307_attached,
        submitted_by_name: c.submitted_by_name || report.submitted_by_name,
        submitted_at: c.submitted_at || report.submitted_at,
      }))

    if (items.length > 0) groups.push({ reportNumber: report.report_number, items })
  }

  return groups
}

function classifyError(err) {
  const message = err?.message || String(err || 'Something went wrong')
  const lower = message.toLowerCase()
  if (err?.name === 'AbortError') {
    return { type: 'network', message: 'That took too long to respond. Please try again.' }
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { type: 'network', message: "You're offline. Reconnect and try again." }
  }
  if (/failed to fetch|network|timeout|econnreset|502|503|504/i.test(message)) {
    return { type: 'network', message: 'Network error reaching the server. Please try again.' }
  }
  if (/no longer pending approval|no longer belongs|already been decided|not awaiting approval|changed since|different branch/i.test(lower)) {
    return { type: 'conflict', message }
  }
  if (/only approvers|not authenticated|permission|branch/i.test(lower)) {
    return { type: 'auth', message }
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

// Re-checks live status of every check in a decision batch directly
// against Postgres immediately before the RPC call, so a concurrent
// decision, recall, or branch change surfaces a specific message instead
// of a generic Postgres exception.
async function revalidateReportChecks(reportNumber, expectedItems, requiredBranch, signal) {
  const ids = expectedItems.map((c) => c.checkId)
  if (ids.length === 0) return

  const { data } = await runSupabaseQuery(
    () => supabase.from('checks').select('id, status, report_number, pickup_branch').in('id', ids).abortSignal(signal),
    signal
  )

  const byId = new Map((data || []).map((r) => [r.id, r]))
  const problems = []
  for (const c of expectedItems) {
    const current = byId.get(c.checkId)
    const label = c.check_no || c.checkId
    if (!current) {
      problems.push(`Check ${label} could not be found.`)
      continue
    }
    if (current.status !== 'pending_approval') {
      problems.push(`Check ${label} is no longer pending approval (now: ${current.status}).`)
      continue
    }
    if (String(current.report_number) !== String(reportNumber)) {
      problems.push(`Check ${label} no longer belongs to report ${reportNumber}.`)
      continue
    }
    if (requiredBranch && branchKey(current.pickup_branch) !== branchKey(requiredBranch)) {
      problems.push(`Check ${label} now belongs to a different branch.`)
    }
  }

  if (problems.length > 0) {
    const extra = problems.length > 1 ? ` (+${problems.length - 1} more)` : ''
    throw new Error(`Some checks changed since this report was loaded — ${problems[0]}${extra}. Refresh and try again.`)
  }
}

function groupByReport(rows) {
  const map = new Map()
  rows.forEach((row) => {
    if (!map.has(row.reportNumber)) map.set(row.reportNumber, { reportNumber: row.reportNumber, items: [] })
    map.get(row.reportNumber).items.push(row)
  })
  return [...map.values()]
}

function flattenGroups(groups) {
  return groups.flatMap((g) => g.items)
}

// Merges a newly fetched page into rows already on screen, de-duplicated
// by check id, so a row that shifted position between pages never
// appears twice.
function mergeRows(existingRows, incomingRows) {
  const map = new Map(existingRows.map((r) => [r.checkId, r]))
  incomingRows.forEach((r) => map.set(r.checkId, r))
  return [...map.values()]
}
function mergeGroups(existingGroups, incomingGroups) {
  const map = new Map(existingGroups.map((g) => [g.reportNumber, g]))
  incomingGroups.forEach((g) => map.set(g.reportNumber, g))
  return [...map.values()]
}
function matchesSearch(items, reportNumber, term) {
  if (!term) return true
  const needle = term.toLowerCase()
  if (String(reportNumber).toLowerCase().includes(needle)) return true
  return items.some((c) =>
    [c.payee, c.payor, c.check_no, c.bank, c.pickup_branch].filter(Boolean).some((field) => String(field).toLowerCase().includes(needle))
  )
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

function csvCell(value) {
  const str = String(value ?? '')
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

function slugify(value) {
  return (
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'all-branches'
  )
}

// Batch decisions are per-report, not per-check: a Staled Check Report is
// generated as a single unit, so approving or returning it applies the same
// disposition to every check it contains. If some of those checks turn out
// not to belong, the whole report is returned and a corrected report gets
// generated again — there is no partial/per-row outcome here.
function buildInitialBatchDecision() {
  return { decision: 'approve', remarks: '' }
}

// ---------------------------------------------------------------------
// Small presentational components
// ---------------------------------------------------------------------

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

function LedgerStatCard({ icon: Icon, label, value, accent }) {
  return (
    <Card className={cn('relative overflow-hidden border-ink-100 p-4 transition-shadow hover:shadow-sm', accent === 'warning' && 'border-orange-200 bg-orange-50/60', accent === 'danger' && 'border-red-200 bg-red-50/60')}>
      <div className="relative flex items-center gap-2">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700', accent === 'warning' && 'bg-orange-100 text-orange-600', accent === 'danger' && 'bg-red-100 text-red-600')}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-400">{label}</p>
      </div>
      <p className={cn('relative mt-1.5 font-display text-2xl font-semibold', accent === 'warning' ? 'text-orange-600' : accent === 'danger' ? 'text-red-600' : 'text-ink-900')}>{value}</p>
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
      <p className="mt-1 max-w-sm text-sm text-ink-400">Deciding on staled check reports requires the approver or admin role.</p>
    </div>
  )
}

function NoBranchAssigned() {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-amber-200 bg-amber-50/40 px-4 py-16 text-center">
      <Lock className="h-8 w-8 text-amber-300" />
      <p className="mt-3 text-lg font-semibold text-ink-700">Your account isn't linked to a branch yet</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        Stale check approvals are scoped per branch. Ask an admin to assign your account to a branch before reviewing reports here.
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
        Your account is assigned branch code "{code}", which isn't mapped to a pickup branch yet. Ask an admin to add it before reviewing reports here.
      </p>
    </div>
  )
}

function Toast({ message, variant }) {
  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 animate-in fade-in slide-in-from-bottom-2 sm:bottom-6">
      <div className={cn('flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium text-white shadow-lg', variant === 'warning' ? 'bg-orange-600' : variant === 'error' ? 'bg-red-600' : 'bg-ink-900')}>
        {variant === 'error' ? <WifiOff className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
        {message}
      </div>
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
        className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 transition focus:outline-none focus:ring-1 focus:ring-teal-500"
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
      <Inbox className="h-8 w-8 text-ink-200" />
      <p className="mt-3 font-display text-lg font-semibold text-ink-700">{hasFilter ? 'No matching checks' : 'Nothing awaiting approval'}</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        {hasFilter ? 'Try a different search or filter combination, or clear your filters.' : `Staled check reports submitted for ${branchLabel} will show up here.`}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------

export default function ApproverStaleReports({ active = true, refreshToken = 0, onSynced } = {}) {
  const { role, name, branch: myBranchCode, loading: profileLoading, error: profileError } = useProfile()

  const authorized = hasRole(role, ALLOWED_ROLES)
  const isAdmin = role === 'admin'

  const myBranchLabel = useMemo(() => resolveBranchLabel(myBranchCode), [myBranchCode])
  const myBranchUnmapped = Boolean(myBranchCode) && myBranchCode !== UNRESTRICTED_BRANCH_CODE && !myBranchLabel
  const branchLocked = !isAdmin && myBranchCode !== UNRESTRICTED_BRANCH_CODE
  const canQuery = isAdmin || (Boolean(myBranchCode) && (myBranchCode === UNRESTRICTED_BRANCH_CODE || Boolean(myBranchLabel)))

  const [groups, setGroups] = useState([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loadError, setLoadError] = useState(null)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [sortBy, setSortBy] = useState('submitted_asc')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const [selectedCheckIds, setSelectedCheckIds] = useState(() => new Set())
  const [confirmAction, setConfirmAction] = useState(null)
  const [actioning, setActioning] = useState(false)
  const [actionPhase, setActionPhase] = useState('')
  const [actionError, setActionError] = useState(null)
  const [successFlash, setSuccessFlash] = useState(null)
  const [toast, setToast] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [now, setNow] = useState(Date.now())

  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [branchScopeFilter, setBranchScopeFilter] = useState('all') // admin only
  const [bankFilter, setBankFilter] = useState('all')
  const [bucketFilter, setBucketFilter] = useState('all')
  const [attachmentFilter, setAttachmentFilter] = useState('all')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')

  const effectiveBranch = isAdmin ? (branchScopeFilter !== 'all' ? branchScopeFilter : null) : branchLocked ? myBranchLabel : null

  const isMountedRef = useRef(true)
  const loadedCountRef = useRef(0)
  const requestIdRef = useRef(0)
  const abortControllerRef = useRef(null)
  const toastTimerRef = useRef(null)
  const successTimerRef = useRef(null)
  const searchTimerRef = useRef(null)
  const searchInputRef = useRef(null)
  const lastFocusedElRef = useRef(null)
  const onSyncedRef = useRef(onSynced)

  useEffect(() => {
    onSyncedRef.current = onSynced
  }, [onSynced])

  useEffect(() => {
    clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(searchTimerRef.current)
  }, [search])

  function showToast(message, variant = 'success') {
    clearTimeout(toastTimerRef.current)
    setToast({ message, variant })
    toastTimerRef.current = setTimeout(() => setToast(null), 3500)
  }

const load = useCallback(
    async (mode) => {
      if (!canQuery) return

      const requestId = ++requestIdRef.current
      abortControllerRef.current?.abort()
      const controller = new AbortController()
      abortControllerRef.current = controller
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      if (mode === 'initial') {
        loadedCountRef.current = 0
        setLoading(true)
      } else if (mode === 'loadMore') {
        setLoadingMore(true)
      } else {
        setRefreshing(true)
      }
      setLoadError(null)

      const from = mode === 'loadMore' ? loadedCountRef.current : 0
      const windowSize = mode === 'refresh' ? Math.max(loadedCountRef.current, REPORT_PAGE_SIZE) : REPORT_PAGE_SIZE
      const to = from + windowSize - 1

      try {
        // Step 1: fetch submitted-but-undecided REPORTS. This is the
        // authoritative "awaiting approval" list — never derived from
        // checks.status.
        const buildReportsQuery = () =>
          supabase
            .from('staled_check_reports')
            .select(REPORT_SELECT_COLUMNS, { count: 'exact' })
            .not('submitted_at', 'is', null)
            .is('decided_at', null)
            .order('submitted_at', { ascending: true })
            .range(from, to)
            .abortSignal(controller.signal)

        const { data: reportRows, count } = await runSupabaseQuery(buildReportsQuery, controller.signal)
        if (!isMountedRef.current || requestId !== requestIdRef.current) return

        const reports = reportRows || []

        // Step 2: fetch the actual checks those reports reference, by id
        // — not by status or report_number, so a submit RPC that forgot
        // to stamp those columns can't hide the report from approvers.
        const allCheckIds = [...new Set(reports.flatMap((r) => r.check_ids || []))]
        let checksById = new Map()

        if (allCheckIds.length > 0) {
          let checksQuery = supabase.from('checks').select(SELECT_COLUMNS).in('id', allCheckIds).abortSignal(controller.signal)
          // Branch scoping happens here, against a real column with a
          // real CHECK constraint — not against staled_check_reports.
          // branches, which is free-text and easy to get out of sync.
          if (effectiveBranch) checksQuery = checksQuery.eq(BRANCH_COLUMN, effectiveBranch)

          const { data: checkRows, error: checksError } = await checksQuery
          if (checksError) throw checksError
          checksById = new Map((checkRows || []).map((c) => [c.id, c]))
        }

        if (!isMountedRef.current || requestId !== requestIdRef.current) return

        const newGroups = buildGroupsFromReports(reports, checksById, effectiveBranch)

        setGroups((prev) => (mode === 'loadMore' ? mergeGroups(prev, newGroups) : newGroups))

        const newLoadedCount = from + reports.length
        loadedCountRef.current = newLoadedCount
        const serverCount = count ?? newLoadedCount
        setTotalCount(serverCount)
        setHasMore(reports.length >= windowSize && newLoadedCount < serverCount)

        const syncedAt = Date.now()
        setLastUpdated(syncedAt)
        setSelectedCheckIds((prev) => {
          if (prev.size === 0) return prev
          const validIds = new Set(newGroups.flatMap((g) => g.items.map((c) => c.checkId)))
          const next = new Set([...prev].filter((id) => mode === 'loadMore' || validIds.has(id)))
          return next.size === prev.size ? prev : next
        })
        onSyncedRef.current?.({ count: serverCount, lastUpdated: syncedAt })
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
          setLoadingMore(false)
        }
      }
    },
    [canQuery, effectiveBranch]
  )

  useEffect(() => {
    isMountedRef.current = true
    if (!profileLoading && authorized && canQuery) load('initial')
    return () => {
      isMountedRef.current = false
      abortControllerRef.current?.abort()
      clearTimeout(successTimerRef.current)
      clearTimeout(toastTimerRef.current)
      clearTimeout(searchTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileLoading, authorized, canQuery, effectiveBranch])

  useEffect(() => {
    if (!authorized || !active || !canQuery) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => {
      if (autoRefresh) load('refresh')
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, authorized, active, canQuery, effectiveBranch])

  // Realtime sync scoped to the effective branch, so an approver's channel
  // only wakes for changes that could affect their queue. Best-effort: if
  // the channel fails to subscribe, polling still keeps the page correct.
 useEffect(() => {
    if (!authorized || !active || !canQuery) return
    let debounceTimer = null
    const channel = supabase
      .channel(`approver-stale-reports-${slugify(effectiveBranch)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staled_check_reports' }, () => {
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          if (isMountedRef.current) load('refresh')
        }, 800)
      })
      .subscribe()
    return () => {
      clearTimeout(debounceTimer)
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, active, canQuery, effectiveBranch])

  const prevActiveRef = useRef(active)
  useEffect(() => {
    if (prevActiveRef.current === active) return
    prevActiveRef.current = active
    if (!active) {
      abortControllerRef.current?.abort()
      return
    }
    if (authorized && canQuery) load('refresh')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, authorized, canQuery])

  const prevRefreshTokenRef = useRef(refreshToken)
  useEffect(() => {
    if (prevRefreshTokenRef.current === refreshToken) return
    prevRefreshTokenRef.current = refreshToken
    if (authorized && canQuery) load('refresh')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, authorized, canQuery])

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

  function minutesWaiting(submittedAtMs) {
    return submittedAtMs ? Math.max(0, Math.round((now - submittedAtMs) / 60000)) : 0
  }
  function formatWaiting(submittedAtMs) {
    return submittedAtMs ? formatMinutesDuration(minutesWaiting(submittedAtMs)) : '—'
  }

  const branchOptions = useMemo(() => {
    const set = new Set(groups.flatMap((g) => g.items.map((c) => normalizeBranch(c.pickup_branch))))
    return [...set].sort((a, b) => (a === UNSPECIFIED_BRANCH ? 1 : b === UNSPECIFIED_BRANCH ? -1 : a.localeCompare(b)))
  }, [groups])

  const bankOptions = useMemo(() => {
    const set = new Set(groups.flatMap((g) => g.items.map((c) => normalizeBank(c.bank))))
    return [...set].sort((a, b) => (a === UNSPECIFIED_BANK ? 1 : b === UNSPECIFIED_BANK ? -1 : a.localeCompare(b)))
  }, [groups])

  const activeFilterCount = useMemo(
    () =>
      [bankFilter !== 'all', bucketFilter !== 'all', attachmentFilter !== 'all', amountMin !== '', amountMax !== '', isAdmin && branchScopeFilter !== 'all'].filter(Boolean).length,
    [bankFilter, bucketFilter, attachmentFilter, amountMin, amountMax, isAdmin, branchScopeFilter]
  )

  function clearAdvancedFilters() {
    setBankFilter('all')
    setBucketFilter('all')
    setAttachmentFilter('all')
    setAmountMin('')
    setAmountMax('')
    if (isAdmin) setBranchScopeFilter('all')
  }

  const visibleGroups = useMemo(() => {
    const term = debouncedSearch
    const min = parseAmountBound(amountMin)
    const max = parseAmountBound(amountMax)

    const list = groups
      .map((g) => {
        const items = g.items.filter((c) => {
          if (bankFilter !== 'all' && normalizeBank(c.bank) !== bankFilter) return false
          if (bucketFilter !== 'all') {
            const bucket = getStaleBucket(c.check_date)
            if (bucketFilter === 'stale' && bucket !== STALE_BUCKETS.STALE) return false
            if (bucketFilter === 'nearing' && bucket === STALE_BUCKETS.STALE) return false
          }
          if (attachmentFilter !== 'all' && attachment2307State(c.form_2307_attached) !== attachmentFilter) return false
          const amt = Number(c.amount) || 0
          if (min !== null && amt < min) return false
          if (max !== null && amt > max) return false
          return true
        })
        return { ...g, items }
      })
      .filter((g) => g.items.length > 0)
      .filter((g) => matchesSearch(g.items, g.reportNumber, term))
      .map((g) => ({ ...g, total: orderTotal(g.items), submittedAtMs: earliestSubmittedAt(g.items) }))

    list.sort((a, b) => {
      switch (sortBy) {
        case 'submitted_desc':
          return (b.submittedAtMs || 0) - (a.submittedAtMs || 0)
        case 'amount_desc':
          return b.total - a.total
        case 'amount_asc':
          return a.total - b.total
        case 'checkdate_asc': {
          const aMin = Math.min(...a.items.map((c) => new Date(c.check_date).getTime()))
          const bMin = Math.min(...b.items.map((c) => new Date(c.check_date).getTime()))
          return aMin - bMin
        }
        case 'submitted_asc':
        default:
          return (a.submittedAtMs || 0) - (b.submittedAtMs || 0)
      }
    })

    return list
  }, [groups, debouncedSearch, sortBy, bankFilter, bucketFilter, attachmentFilter, amountMin, amountMax])

  const summary = useMemo(() => {
    const allItems = groups.flatMap((g) => g.items)
    const waitMinutesList = groups
      .map((g) => earliestSubmittedAt(g.items))
      .filter(Boolean)
      .map((t) => Math.max(0, Math.round((now - t) / 60000)))
    const staleCount = allItems.filter((c) => getStaleBucket(c.check_date) === STALE_BUCKETS.STALE).length

    return {
      reports: groups.length,
      checks: allItems.length,
      totalValue: orderTotal(allItems),
      staleCount,
      nearingCount: allItems.length - staleCount,
      uniqueBanks: new Set(allItems.map((c) => normalizeBank(c.bank))).size,
      uniqueBranches: new Set(allItems.map((c) => normalizeBranch(c.pickup_branch))).size,
      avgWaitMinutes: waitMinutesList.length > 0 ? waitMinutesList.reduce((s, m) => s + m, 0) / waitMinutesList.length : 0,
    }
  }, [groups, now])

  function toggleExpand(reportNumber) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.has(reportNumber) ? next.delete(reportNumber) : next.add(reportNumber)
      return next
    })
  }

  function toggleSelectCheck(checkId) {
    setSelectedCheckIds((prev) => {
      const next = new Set(prev)
      next.has(checkId) ? next.delete(checkId) : next.add(checkId)
      return next
    })
  }

  function toggleSelectAllInGroup(group) {
    setSelectedCheckIds((prev) => {
      const ids = group.items.map((c) => c.checkId)
      const allSelected = ids.every((id) => prev.has(id))
      const next = new Set(prev)
      ids.forEach((id) => (allSelected ? next.delete(id) : next.add(id)))
      return next
    })
  }

  function openReviewForGroup(group) {
    lastFocusedElRef.current = document.activeElement
    setActionError(null)
    setSuccessFlash(null)
    setConfirmAction({ reportNumber: group.reportNumber, checks: group.items.slice(0, MAX_ROWS_PER_REPORT) })
  }

  const closeConfirm = useCallback(() => {
    clearTimeout(successTimerRef.current)
    setSuccessFlash(null)
    setConfirmAction(null)
    requestAnimationFrame(() => lastFocusedElRef.current?.focus?.())
  }, [])

  // Two-phase submit with optimistic UI: revalidate live state directly
  // against Postgres, optimistically remove decided checks locally, call
  // the RPC (server re-checks under a row lock), and roll back to an exact
  // pre-decision snapshot on any failure.
  async function runDecision(batchDecision) {
    if (!confirmAction || actioning) return
    if (!authorized) {
      setActionError({ type: 'auth', message: "You don't have permission to decide on staled check reports." })
      return
    }
    const approverName = (name || '').trim()
    if (!approverName) {
      setActionError({ type: 'auth', message: 'Could not identify your account name. Please refresh and try again.' })
      return
    }
    if (branchLocked && !myBranchLabel) {
      setActionError({ type: 'auth', message: 'Your account has no assigned branch. Contact an admin before submitting decisions.' })
      return
    }

    setActioning(true)
    setActionError(null)

    const snapshotGroups = groups
    const snapshotTotalCount = totalCount
    const decidedCheckIds = new Set(confirmAction.checks.map((c) => c.checkId))
    let appliedOptimisticUpdate = false

    function rollback() {
      if (!appliedOptimisticUpdate) return
      setGroups(snapshotGroups)
      setTotalCount(snapshotTotalCount)
      appliedOptimisticUpdate = false
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      setActionPhase('verifying')
      await revalidateReportChecks(confirmAction.reportNumber, confirmAction.checks, effectiveBranch, controller.signal)

      setGroups((prev) => prev.map((g) => ({ ...g, items: g.items.filter((c) => !decidedCheckIds.has(c.checkId)) })).filter((g) => g.items.length > 0))
      setTotalCount((prev) => Math.max(0, prev - decidedCheckIds.size))
      loadedCountRef.current = Math.max(0, loadedCountRef.current - decidedCheckIds.size)
      setSelectedCheckIds((prev) => {
        if (prev.size === 0) return prev
        const next = new Set(prev)
        decidedCheckIds.forEach((id) => next.delete(id))
        return next
      })
      appliedOptimisticUpdate = true

      const p_decisions = confirmAction.checks.map((c) =>
        batchDecision.decision === 'approve'
          ? { check_id: c.checkId, decision: 'approve' }
          : { check_id: c.checkId, decision: 'return', remarks: batchDecision.remarks.trim() }
      )

      setActionPhase('submitting')
      const { data, error } = await supabase.rpc('approver_decide_staled_report', {
        p_report_number: confirmAction.reportNumber,
        p_decisions,
        p_approver_name: approverName,
      })

      if (error) {
        rollback()
        setActionError(classifyError(error))
        load('refresh')
        return
      }

      const result = Array.isArray(data) ? data[0] : data
      const approvedTotal = result?.approved_count ?? 0
      const returnedTotal = result?.returned_count ?? 0
      const parts = []
      if (approvedTotal > 0) parts.push(`${approvedTotal} confirmed stale`)
      if (returnedTotal > 0) parts.push(`${returnedTotal} returned to pool`)
      const summaryMsg = parts.length > 0 ? parts.join(', ') : 'Decisions recorded'

      setSuccessFlash({ message: summaryMsg })
      clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => {
        if (!isMountedRef.current) return
        setSuccessFlash(null)
        setConfirmAction(null)
        requestAnimationFrame(() => lastFocusedElRef.current?.focus?.())
      }, SUCCESS_FLASH_MS)

      load('refresh')
      showToast(summaryMsg, 'success')
    } catch (err) {
      if (!isMountedRef.current) return
      rollback()
      const classified = classifyError(err)
      setActionError(classified)
      if (classified.type === 'network') showToast(classified.message, 'error')
      load('refresh')
    } finally {
      clearTimeout(timeoutId)
      if (isMountedRef.current) {
        setActioning(false)
        setActionPhase('')
      }
    }
  }

  function exportCsv() {
    const headers = ['Report #', 'Bank', 'Branch', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'Stale bucket', '2307 Attached', 'Submitted by', 'Submitted at']
    const rows = [headers]
    visibleGroups.forEach((g) => {
      g.items.forEach((c) => {
        rows.push([
          g.reportNumber,
          normalizeBank(c.bank),
          normalizeBranch(c.pickup_branch),
          c.check_no || '',
          c.payee || '',
          c.payor || '',
          c.check_date || '',
          c.amount ?? '',
          getStaleBucket(c.check_date) === STALE_BUCKETS.STALE ? 'Stale' : 'Nearing stale',
          attachment2307State(c.form_2307_attached),
          c.submitted_by_name || '',
          c.submitted_at || '',
        ])
      })
    })
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `stale-report-approvals-${slugify(effectiveBranch)}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const activeSortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label || 'Sort'
  const hasActiveFilter = Boolean(search.trim()) || activeFilterCount > 0
  const loadedCount = groups.reduce((sum, g) => sum + g.items.length, 0)

  if (profileLoading) return <div className="flex min-h-[40vh] items-center justify-center text-sm text-ink-300">Loading…</div>
  if (profileError) return <ProfileLoadError error={profileError} />
  if (!authorized) return <AccessDenied />
  if (!canQuery) return myBranchUnmapped ? <UnmappedBranch code={myBranchCode} /> : <NoBranchAssigned />

  return (
    <div className="pb-20 sm:pb-0">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-amber-400/40 bg-amber-400/10 text-amber-700">
            <FileClock className="h-4.5 w-4.5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-amber-700/80">Staled check reports</p>
              <BranchScopeBadge branch={effectiveBranch} locked={branchLocked} />
            </div>
            <h1 className="font-display text-2xl font-semibold text-ink-900">Pending stale approvals</h1>
            <p className="mt-1 text-sm text-ink-400">
              {name ? `Signed in as ${name}. ` : ''}Confirm each stale check's disposition, or return it to the pool if it doesn't belong on this report. Nothing here is released to a
              collector.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && <span className="hidden font-mono text-[11px] text-ink-300 sm:inline">Updated {Math.max(0, Math.round((now - lastUpdated) / 1000))}s ago</span>}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-2.5 py-2 text-xs font-medium text-ink-600 transition hover:bg-ink-50"
            title={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
          >
            {autoRefresh ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{autoRefresh ? 'Live' : 'Paused'}</span>
          </button>
          <button
            onClick={() => load('refresh')}
            disabled={refreshing || loading}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 transition hover:bg-ink-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {!loading && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <LedgerStatCard icon={Layers} label="Reports" value={summary.reports} />
          <LedgerStatCard icon={Hash} label="Checks loaded" value={summary.checks} />
          <LedgerStatCard icon={AlertTriangle} label="Stale" value={summary.staleCount} accent={summary.staleCount > 0 ? 'danger' : undefined} />
          <LedgerStatCard icon={Hourglass} label="Nearing stale" value={summary.nearingCount} accent={summary.nearingCount > 0 ? 'warning' : undefined} />
          <LedgerStatCard icon={Landmark} label="Banks" value={summary.uniqueBanks} />
          <LedgerStatCard icon={Building2} label="Branches" value={summary.uniqueBranches} />
          <LedgerStatCard icon={ShieldAlert} label="Avg. wait" value={formatMinutesDuration(summary.avgWaitMinutes)} />
        </div>
      )}

      {!loading && totalCount > loadedCount && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-700">
          <Info className="h-4 w-4 shrink-0" />
          Showing {loadedCount} of {totalCount} pending checks in scope. Load more below, or narrow with search and filters.
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
              placeholder="Search report #, bank, branch, check #, payee, or payor... (press /)"
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
              className="flex w-full items-center justify-between gap-2 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 transition hover:bg-ink-50 sm:w-auto"
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
              'flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-ink-50',
              activeFilterCount > 0 ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-ink-200 text-ink-600'
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Filters</span>
            {activeFilterCount > 0 && <span className="rounded-full bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">{activeFilterCount}</span>}
            {showAdvancedFilters ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        <button
          onClick={exportCsv}
          disabled={visibleGroups.length === 0}
          className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-xs font-medium text-ink-600 transition hover:bg-ink-50 disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      {showAdvancedFilters && (
        <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ink-100 bg-ink-50/50 p-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {isAdmin && (
            <FilterSelect
              label="Branch"
              value={branchScopeFilter}
              onChange={setBranchScopeFilter}
              options={[{ value: 'all', label: 'All branches' }, ...branchOptions.map((b) => ({ value: b, label: b }))]}
            />
          )}
          <FilterSelect label="Bank" value={bankFilter} onChange={setBankFilter} options={[{ value: 'all', label: 'All banks' }, ...bankOptions.map((b) => ({ value: b, label: b }))]} />
          <FilterSelect label="Stale bucket" value={bucketFilter} onChange={setBucketFilter} options={BUCKET_FILTER_OPTIONS} />
          <FilterSelect label="2307 attached" value={attachmentFilter} onChange={setAttachmentFilter} options={ATTACHMENT_FILTER_OPTIONS} />
          <div>
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-ink-400">Min amount</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amountMin}
              onChange={(e) => setAmountMin(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 transition focus:outline-none focus:ring-1 focus:ring-teal-500"
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
              placeholder="No limit"
              className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 transition focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>
          <div className="flex items-end sm:col-span-2 lg:col-span-2 lg:justify-end">
            <button onClick={clearAdvancedFilters} disabled={activeFilterCount === 0} className="rounded-md border border-ink-200 px-3.5 py-1.5 text-xs font-medium text-ink-500 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40">
              Clear filters
            </button>
          </div>
        </div>
      )}

      {loadError && (
        <div
          className={cn(
            'mb-4 flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm',
            loadError.type === 'network' ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-red-200 bg-red-50 text-red-700'
          )}
        >
          <span className="flex items-center gap-2">
            {loadError.type === 'network' ? <WifiOff className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
            {loadError.message}
          </span>
          <button onClick={() => load(loading ? 'initial' : 'refresh')} className="shrink-0 rounded-md border border-current px-3 py-1 text-xs font-medium hover:bg-white/50">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <ListSkeleton />
      ) : visibleGroups.length === 0 ? (
        <EmptyState hasFilter={hasActiveFilter} branchLabel={effectiveBranch || 'your branch'} />
      ) : (
        <>
          <div className="space-y-2.5">
            {visibleGroups.map((g) => (
              <ReportGroupRow
                key={g.reportNumber}
                group={g}
                waitingLabel={formatWaiting(g.submittedAtMs)}
                expanded={expandedIds.has(g.reportNumber)}
                onToggleExpand={() => toggleExpand(g.reportNumber)}
                selectedCheckIds={selectedCheckIds}
                onToggleSelectCheck={toggleSelectCheck}
                onToggleSelectAll={() => toggleSelectAllInGroup(g)}
                onReview={() => openReviewForGroup(g)}
              />
            ))}
          </div>

          {hasMore && !hasActiveFilter && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={() => load('loadMore')}
                disabled={loadingMore}
                className="flex items-center gap-2 rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 transition hover:bg-ink-50 disabled:opacity-50"
              >
                {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronsDown className="h-3.5 w-3.5" />}
                {loadingMore ? 'Loading…' : `Load more (${Math.max(totalCount - loadedCount, 0)} remaining)`}
              </button>
            </div>
          )}

          {hasMore && hasActiveFilter && (
            <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-ink-400">
              <Info className="h-3.5 w-3.5 shrink-0" />
              Clear search and filters to load more — results are matched only against what's currently loaded.
            </p>
          )}
        </>
      )}

      {confirmAction && <ReviewModal action={confirmAction} onCancel={closeConfirm} onConfirm={runDecision} loading={actioning} phase={actionPhase} error={actionError} successFlash={successFlash} />}

      {toast && <Toast message={toast.message} variant={toast.variant} />}
    </div>
  )
}

function ReportGroupRow({ group, waitingLabel, expanded, onToggleExpand, selectedCheckIds, onToggleSelectCheck, onToggleSelectAll, onReview }) {
  const items = group.items
  const total = orderTotal(items)
  const allSelected = items.every((c) => selectedCheckIds.has(c.checkId))
  const someSelected = items.some((c) => selectedCheckIds.has(c.checkId))
  const staleCount = items.filter((c) => getStaleBucket(c.check_date) === STALE_BUCKETS.STALE).length

  const [sortKey, setSortKey] = useState('default')
  const [sortDir, setSortDir] = useState('asc')

  const distinctBanks = useMemo(() => [...new Set(items.map((c) => normalizeBank(c.bank)))], [items])
  const distinctBranches = useMemo(() => [...new Set(items.map((c) => normalizeBranch(c.pickup_branch)))], [items])

  const sortedItems = useMemo(() => {
    if (sortKey === 'default') return items
    const factor = sortDir === 'asc' ? 1 : -1
    return [...items].sort((a, b) => {
      if (sortKey === 'amount') return ((Number(a.amount) || 0) - (Number(b.amount) || 0)) * factor
      if (sortKey === 'checkdate') return (new Date(a.check_date).getTime() - new Date(b.check_date).getTime()) * factor
      return 0
    })
  }, [items, sortKey, sortDir])

  const truncated = sortedItems.length > MAX_ROWS_PER_REPORT
  const visibleItems = truncated ? sortedItems.slice(0, MAX_ROWS_PER_REPORT) : sortedItems

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

  function SortHeader({ label, sortField, className }) {
    const active = sortKey === sortField
    return (
      <th className={cn('px-2 py-2 font-medium', className)}>
        <button onClick={() => toggleSort(sortField)} className={cn('flex items-center gap-1 hover:text-ink-700', active && 'text-teal-700')}>
          {label}
          {active ? sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-30" />}
        </button>
      </th>
    )
  }

  return (
    <Card className="overflow-hidden border-ink-100 p-0 transition-shadow hover:shadow-sm">
      <div className="flex items-start gap-2.5 border-b border-dashed border-ink-100 bg-ink-50/40 px-3 py-3 sm:px-4">
        <button onClick={onToggleSelectAll} className="mt-0.5 shrink-0 text-ink-300 transition hover:text-teal-600" aria-label={allSelected ? 'Deselect all checks in this report' : 'Select all checks in this report'}>
          {allSelected ? <CheckSquare className="h-4.5 w-4.5 text-teal-600" /> : someSelected ? <MinusSquare className="h-4.5 w-4.5 text-teal-600" /> : <Square className="h-4.5 w-4.5" />}
        </button>

        <button onClick={onToggleExpand} className="flex min-w-0 flex-1 flex-col gap-2 text-left">
          <div className="flex min-w-0 items-center gap-2">
            <FileClock className="h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <span className="truncate font-display font-medium text-ink-900">Report {group.reportNumber}</span>
              {items[0]?.submitted_by_name && <p className="truncate font-mono text-xs text-ink-400">Submitted by {items[0].submitted_by_name}</p>}
            </div>
            <span className="ml-auto shrink-0 font-mono font-semibold text-ink-800">{formatCurrency(total)}</span>
            {expanded ? <ChevronUp className="h-4 w-4 shrink-0 text-ink-300" /> : <ChevronDown className="h-4 w-4 shrink-0 text-ink-300" />}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pl-6 text-xs text-ink-500">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ledger-amber/15 px-2 py-0.5 font-medium text-ledger-amber">
              <Layers className="h-3 w-3" />
              {items.length} checks
            </span>
            {staleCount > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">
                <AlertTriangle className="h-3 w-3" />
                {staleCount} stale
              </span>
            )}
            {distinctBranches.length <= 2 ? (
              distinctBranches.map((b) => (
                <span key={b} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700" title={b}>
                  <Building2 className="h-3 w-3 shrink-0" />
                  <span className="max-w-[110px] truncate">{b}</span>
                </span>
              ))
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500" title={distinctBranches.join(', ')}>
                <Building2 className="h-3 w-3" />
                {distinctBranches.length} branches
              </span>
            )}
            {distinctBanks.length <= 2 ? (
              distinctBanks.map((b) => <BankBadge key={b} bank={b} />)
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500" title={distinctBanks.join(', ')}>
                <Landmark className="h-3 w-3" />
                {distinctBanks.length} banks
              </span>
            )}
            <span className="inline-flex shrink-0 items-center gap-1 font-mono font-medium text-ink-500">
              <Hourglass className="h-3.5 w-3.5" />
              Waiting {waitingLabel}
            </span>
          </div>
        </button>
      </div>

      {expanded && (
        <>
          {truncated && (
            <div className="flex items-center gap-2 border-b border-dashed border-ink-100 bg-amber-50 px-4 py-2 text-xs text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Showing the first {MAX_ROWS_PER_REPORT} of {sortedItems.length} checks on this report.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-dashed border-ink-100 text-left font-mono text-[11px] uppercase tracking-wide text-ink-400">
                  <th className="px-4 py-2 font-medium"></th>
                  <th className="px-2 py-2 font-medium">Check no.</th>
                  <th className="px-2 py-2 font-medium">Bank</th>
                  <th className="px-2 py-2 font-medium">Branch</th>
                  <th className="px-2 py-2 font-medium">Payee</th>
                  <SortHeader label="Check date" sortField="checkdate" />
                  <SortHeader label="Amount" sortField="amount" className="text-right" />
                  <th className="px-2 py-2 font-medium">Bucket</th>
                  <th className="px-2 py-2 font-medium">2307</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dashed divide-ink-50">
                {visibleItems.map((c, idx) => (
                  <tr key={c.checkId ?? idx} className="transition-colors hover:bg-ink-50/60">
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
                    <td className="px-2 py-2.5">
                      <BankBadge bank={c.bank} />
                    </td>
                    <td className="px-2 py-2.5">
                      {c.pickup_branch ? (
                        <span className="inline-flex max-w-[130px] items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700" title={c.pickup_branch}>
                          <Building2 className="h-3 w-3 shrink-0" />
                          <span className="truncate">{c.pickup_branch}</span>
                        </span>
                      ) : (
                        <span className="text-ink-300">—</span>
                      )}
                    </td>
                    <td className="max-w-[140px] truncate px-2 py-2.5 font-medium text-ink-900" title={c.payee || undefined}>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-dashed border-ink-100 bg-ink-50/40 px-4 py-3">
            <button onClick={onReview} className="flex items-center gap-1.5 rounded-md bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-700">
              <ShieldCheck className="h-3.5 w-3.5" />
              Review this report
            </button>
          </div>
        </>
      )}
    </Card>
  )
}

// A Staled Check Report is generated and submitted as one unit, so it is
// decided as one unit: either every check on it is confirmed stale, or the
// whole report is handed back to the pool. There is no per-check split here
// — if a subset of checks doesn't belong, the report is returned and a
// corrected one is generated fresh, rather than editing this one check by
// check.
function ReviewModal({ action, onCancel, onConfirm, loading, phase, error, successFlash }) {
  const allChecks = action.checks
  const total = orderTotal(allChecks)
  const staleCount = allChecks.filter((c) => getStaleBucket(c.check_date) === STALE_BUCKETS.STALE).length
  const dialogRef = useRef(null)
  const cancelButtonRef = useRef(null)
  const remarksRef = useRef(null)

  const initial = useMemo(() => buildInitialBatchDecision(), [])
  const [decision, setDecision] = useState(initial.decision)
  const [remarks, setRemarks] = useState(initial.remarks)
  const [showValidation, setShowValidation] = useState(false)

  const requiresReason = decision === 'return'
  const missingReason = requiresReason && !remarks.trim()
  const complete = !missingReason

  function selectDecision(next) {
    setDecision(next)
    setShowValidation(false)
    if (next === 'return') requestAnimationFrame(() => remarksRef.current?.focus())
  }

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
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null)
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
    if (!complete) {
      setShowValidation(true)
      remarksRef.current?.focus()
      remarksRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }
    onConfirm({ decision, remarks: remarks.trim() })
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink-900/50 p-3 py-6 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading && !successFlash) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stale-review-modal-title"
        className="relative flex max-h-[65vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-ink-100 px-5 py-3.5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700">
              <Stamp className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <h2 id="stale-review-modal-title" className="truncate font-display text-lg font-semibold leading-tight text-ink-900">
                Report {action.reportNumber}
              </h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] uppercase tracking-wide text-ink-400">
                <span>
                  {allChecks.length} check{allChecks.length === 1 ? '' : 's'}
                </span>
                <span className="text-ink-200">·</span>
                <span className="font-semibold text-ink-600">{formatCurrency(total)}</span>
                {staleCount > 0 && (
                  <>
                    <span className="text-ink-200">·</span>
                    <span className="text-amber-700">{staleCount} stale</span>
                  </>
                )}
              </p>
            </div>
          </div>
          <button onClick={onCancel} disabled={loading} className="shrink-0 rounded-md p-1 text-ink-300 transition hover:bg-ink-50 hover:text-ink-600 disabled:opacity-40" aria-label="Close">
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3.5">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Decided as a whole</p>

              <div className="mt-2 flex flex-col gap-2">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => selectDecision('approve')}
                  aria-pressed={decision === 'approve'}
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl border-2 p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                    decision === 'approve' ? 'border-teal-600 bg-teal-50/70 shadow-sm' : 'border-ink-100 hover:border-teal-200 hover:bg-teal-50/30'
                  )}
                >
                  <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', decision === 'approve' ? 'bg-teal-600 text-white' : 'bg-ink-100 text-ink-400')}>
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink-900">Confirm stale</span>
                    <span className="mt-0.5 block text-xs text-ink-500">All {allChecks.length} checks confirmed. No reason needed.</span>
                  </span>
                </button>

                <button
                  type="button"
                  disabled={loading}
                  onClick={() => selectDecision('return')}
                  aria-pressed={decision === 'return'}
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl border-2 p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                    decision === 'return' ? 'border-orange-500 bg-orange-50/70 shadow-sm' : 'border-ink-100 hover:border-orange-200 hover:bg-orange-50/30'
                  )}
                >
                  <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', decision === 'return' ? 'bg-orange-500 text-white' : 'bg-ink-100 text-ink-400')}>
                    <RotateCcw className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink-900">Return entire report</span>
                    <span className="mt-0.5 block text-xs text-ink-500">All {allChecks.length} checks go back to the pool.</span>
                  </span>
                </button>
              </div>

              {requiresReason && (
                <div className="mt-3">
                  <label htmlFor="stale-return-reason" className="mb-1 flex items-center justify-between text-xs font-medium text-ink-600">
                    <span>Reason for returning</span>
                    <span className="font-mono text-[11px] font-normal text-ink-300">
                      {remarks.length}/{REMARKS_MAX_LEN}
                    </span>
                  </label>
                  <textarea
                    id="stale-return-reason"
                    ref={remarksRef}
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value.slice(0, REMARKS_MAX_LEN))}
                    onBlur={(e) => setRemarks(e.target.value.trim())}
                    placeholder="e.g. several checks were already picked up"
                    maxLength={REMARKS_MAX_LEN}
                    rows={2}
                    required
                    aria-required="true"
                    aria-invalid={showValidation && missingReason}
                    disabled={loading}
                    className={cn(
                      'w-full resize-none rounded-lg border px-3 py-2 text-sm text-ink-800 transition focus:outline-none focus:ring-1 focus:ring-orange-500 disabled:cursor-not-allowed disabled:opacity-60',
                      showValidation && missingReason ? 'border-orange-500' : 'border-ink-200'
                    )}
                  />
                  {showValidation && missingReason && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-orange-600">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      Enter a reason before confirming.
                    </p>
                  )}
                  <div className="mt-2 flex items-start gap-2 rounded-md bg-orange-50 px-3 py-2 text-xs text-orange-700">
                    <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    This report closes out — a corrected report is generated fresh from what's still stale.
                  </div>
                </div>
              )}

              {error && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-orange-200 bg-orange-50 px-3 py-2.5 text-sm text-orange-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <p className="font-medium">{error.type === 'network' ? 'Connection problem' : error.type === 'conflict' ? 'This report changed' : 'Could not submit'}</p>
                    <p className="mt-0.5">{error.message}</p>
                    {error.type === 'conflict' && <p className="mt-1 text-xs opacity-80">Close and reopen this report to review the latest data.</p>}
                  </div>
                </div>
              )}
            </div>

            <div className="lg:col-span-3">
              <div className="overflow-hidden rounded-lg border border-ink-100">
                <div className="flex items-center justify-between border-b border-ink-100 bg-ink-50/60 px-3 py-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-wide text-ink-400">Checks on this report</span>
                  <span className="font-mono text-[11px] text-ink-400">{allChecks.length}</span>
                </div>
                <div className="max-h-[30vh] divide-y divide-dashed divide-ink-50 overflow-y-auto">
                  {allChecks.map((c, idx) => {
                    const isStale = getStaleBucket(c.check_date) === STALE_BUCKETS.STALE
                    return (
                      <div key={c.checkId ?? idx} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', isStale ? 'bg-orange-500' : 'bg-teal-500')} title={isStale ? 'Stale' : 'Nearing stale'} />
                        <span className="w-16 shrink-0 truncate font-mono text-xs text-ink-600">{c.check_no ?? '—'}</span>
                        <span className="min-w-0 flex-1 truncate font-medium text-ink-800" title={c.payee || undefined}>
                          {c.payee || '—'}
                        </span>
                        <span className="hidden shrink-0 truncate text-xs text-ink-400 sm:block sm:max-w-[110px]" title={c.bank || undefined}>
                          {normalizeBank(c.bank)}
                        </span>
                        <span className="shrink-0 font-mono text-xs font-medium text-ink-700">{safeCurrency(c.amount)}</span>
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center justify-between border-t border-ink-100 bg-ink-50/60 px-3 py-2">
                  <span className="text-xs font-medium text-ink-500">Total</span>
                  <span className="font-mono text-sm font-semibold text-ink-900">{formatCurrency(total)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-ink-100 px-5 py-3">
          <span className="text-xs text-ink-400">{loading && phase ? PHASE_LABELS[phase] : ''}</span>
          <div className="flex items-center gap-2">
            <button ref={cancelButtonRef} onClick={onCancel} disabled={loading} className="rounded-md border border-ink-200 px-3.5 py-2 text-sm font-medium text-ink-600 transition hover:bg-ink-50 disabled:opacity-40">
              Cancel
            </button>
            <button
              onClick={handleConfirmClick}
              disabled={loading}
              className={cn(
                'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60',
                decision === 'return' ? 'bg-orange-500 hover:bg-orange-600' : 'bg-teal-600 hover:bg-teal-700'
              )}
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading
                ? phase === 'verifying'
                  ? 'Verifying…'
                  : 'Submitting…'
                : decision === 'return'
                  ? `Return ${allChecks.length} check${allChecks.length === 1 ? '' : 's'}`
                  : `Confirm ${allChecks.length} check${allChecks.length === 1 ? '' : 's'} as stale`}
            </button>
          </div>
        </div>

        {successFlash && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 backdrop-blur-sm">
            <div className={cn('flex h-14 w-14 items-center justify-center rounded-full', decision === 'return' ? 'bg-orange-100' : 'bg-teal-100')}>
              <Check className={cn('h-7 w-7', decision === 'return' ? 'text-orange-600' : 'text-teal-600')} strokeWidth={3} />
            </div>
            <p className="text-sm font-semibold text-ink-800">{successFlash.message}</p>
          </div>
        )}
      </div>
    </div>
  )
}