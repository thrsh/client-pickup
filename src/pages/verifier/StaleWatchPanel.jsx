import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Landmark,
  Building2,
  ChevronDown,
  ChevronRight,
  CheckSquare,
  Square,
  AlertTriangle,
  Loader2,
  FileSpreadsheet,
  Send,
  Search,
  Inbox,
  ClipboardCheck,
  RefreshCw,
  Info,
  X,
  Download,
  Filter,
  ArrowUpDown,
  BadgeCheck,
  BadgeX,
  BadgeHelp,
  CalendarClock,
  Check,
  ArrowRight,
  FileCheck2,
} from 'lucide-react'
import { useProfile } from '../../context/ProfileContext'
import { supabase } from '../../lib/supabaseClient'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { useToast } from '../../components/ui/toast'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import {
  STALE_BUCKETS,
  STALE_FIXED_MONTHS,
  WARNING_WINDOW_DAYS,
  getStaleBucket,
  warningCutoffDateInputValue,
} from '../../lib/staleChecks'
// Report rendering (PDF + Excel) now lives in one shared module so this
// panel's "just generated" export and StaleReportHistory's "reopen a
// past report" export can never drift apart. Also brings in the
// one-bank-per-branch rule this panel's selection UI is expected to
// enforce before a report is ever generated.
import {
  buildStaleCheckReportPdf,
  buildStaleCheckReportWorkbook,
  findMixedBankBranch,
} from '../../lib/staleCheckReportDocument'

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function setsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

const UNSPECIFIED_BRANCH = 'No branch on file'
const UNSPECIFIED_BANK = 'Unspecified bank'

// Sort comparators available for the rows within each bank group. Kept
// as a lookup table (rather than a chain of if/else at the call site) so
// adding a new sort option later is a one-line addition here plus one
// entry in SORT_OPTIONS below — nothing else needs to change.
const ROW_COMPARATORS = {
  check_date_asc: (a, b) => new Date(a.check_date) - new Date(b.check_date),
  check_date_desc: (a, b) => new Date(b.check_date) - new Date(a.check_date),
  amount_desc: (a, b) => Number(b.amount || 0) - Number(a.amount || 0),
  amount_asc: (a, b) => Number(a.amount || 0) - Number(b.amount || 0),
  payee_asc: (a, b) => String(a.payee || '').localeCompare(String(b.payee || '')),
}
const DEFAULT_SORT = 'check_date_asc'
const SORT_OPTIONS = [
  { value: 'check_date_asc', label: 'Check date — oldest first' },
  { value: 'check_date_desc', label: 'Check date — newest first' },
  { value: 'amount_desc', label: 'Amount — high to low' },
  { value: 'amount_asc', label: 'Amount — low to high' },
  { value: 'payee_asc', label: 'Payee — A to Z' },
]

// Collapses whatever's stored in `checks.form_2307_attached` (which
// should already be normalized to 'Y'/'N' by the upload pipeline, but
// this stays defensive against blanks, nulls, or anything unexpected
// that slips through) down to one of three UI-facing states.
function attachment2307State(raw) {
  const value = String(raw ?? '').trim().toUpperCase()
  if (value === 'Y') return 'yes'
  if (value === 'N') return 'no'
  return 'unset'
}

// Groups flat rows into [{ branch, banks: [{ bank, rows[] }] }], both
// levels sorted alphabetically ("No branch" / "Unspecified" sorted
// last), rows within a bank sorted per `sortBy`. This stays two-level
// (branch -> bank) because it only drives the on-screen selection list,
// where a branch briefly having checks from more than one bank is a
// normal, visible-and-fixable state — the one-bank-per-branch rule is
// enforced separately, right before a report is actually generated (see
// mixedBankBranchWarning below).
function groupByBranchThenBank(rows, sortBy = DEFAULT_SORT) {
  const comparator = ROW_COMPARATORS[sortBy] || ROW_COMPARATORS[DEFAULT_SORT]
  const byBranch = new Map()
  for (const row of rows) {
    const branch = row.pickup_branch || UNSPECIFIED_BRANCH
    const bank = row.bank || UNSPECIFIED_BANK
    if (!byBranch.has(branch)) byBranch.set(branch, new Map())
    const byBank = byBranch.get(branch)
    if (!byBank.has(bank)) byBank.set(bank, [])
    byBank.get(bank).push(row)
  }

  const sortKey = (k) => (k.startsWith('No branch') || k.startsWith('Unspecified') ? `\uffff${k}` : k)

  const branches = [...byBranch.keys()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  return branches.map((branch) => {
    const byBank = byBranch.get(branch)
    const banks = [...byBank.keys()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    return {
      branch,
      banks: banks.map((bank) => ({
        bank,
        rows: byBank.get(bank).slice().sort(comparator),
      })),
    }
  })
}

// Aggregates rows by a single key (branch or bank), for the "Summary by
// ..." breakdown in the confirm dialog. Kept generic (keyFn) rather
// than two near-duplicate functions.
function summarizeBy(rows, keyFn, fallbackLabel) {
  const map = new Map()
  for (const row of rows) {
    const key = keyFn(row) || fallbackLabel
    if (!map.has(key)) map.set(key, { key, count: 0, amount: 0 })
    const entry = map.get(key)
    entry.count += 1
    entry.amount += Number(row.amount || 0)
  }
  const sortKey = (k) => (k.startsWith('No branch') || k.startsWith('Unspecified') ? `\uffff${k}` : k)
  return [...map.values()].sort((a, b) => sortKey(a.key).localeCompare(sortKey(b.key)))
}

// Single source of truth for "what does this set of rows add up to" —
// used by the confirm dialog and the preview header. Deliberately takes
// a plain rows array (not ids + a lookup) so it's a pure function of
// exactly what's being reported.
function computeReportSummary(rows) {
  let totalAmount = 0
  let staleCount = 0
  let staleAmount = 0
  let warningCount = 0
  let warningAmount = 0
  for (const row of rows) {
    const amount = Number(row.amount || 0)
    totalAmount += amount
    if (getStaleBucket(row.check_date) === STALE_BUCKETS.STALE) {
      staleCount += 1
      staleAmount += amount
    } else {
      warningCount += 1
      warningAmount += amount
    }
  }
  return {
    totalCount: rows.length,
    totalAmount,
    staleCount,
    staleAmount,
    warningCount,
    warningAmount,
    byBranch: summarizeBy(rows, (r) => r.pickup_branch, UNSPECIFIED_BRANCH),
    byBank: summarizeBy(rows, (r) => r.bank, UNSPECIFIED_BANK),
  }
}

// ---------------------------------------------------------------------
// Filter bar sub-components
// ---------------------------------------------------------------------

// Generic checkbox-list dropdown used for the Bank and Branch filters.
// Self-contained (owns its own open/closed state and closes on an
// outside click) so the parent only ever deals with a plain Set of
// selected values.
function FilterMultiSelect({ label, icon: Icon, options, selected, onChange, emptyLabel = 'All' }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => {
    function handleOutsideClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [])

  function toggleOption(opt) {
    const next = new Set(selected)
    if (next.has(opt)) next.delete(opt)
    else next.add(opt)
    onChange(next)
  }

  const summary = selected.size === 0 ? emptyLabel : selected.size === 1 ? [...selected][0] : `${selected.size} selected`

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
          selected.size > 0
            ? 'border-ledger-stamp/40 bg-ledger-stamp/5 text-ledger-stampDark'
            : 'border-ink-200 text-ink-500 hover:bg-ink-50',
        )}
      >
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}: <span className="max-w-[9rem] truncate font-semibold">{summary}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-20 mt-1 max-h-64 w-60 overflow-y-auto rounded-md border border-ink-200 bg-white p-1.5 shadow-lg"
        >
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-ink-300">No options available</p>
          ) : (
            <>
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={() => onChange(new Set())}
                  className="mb-1 w-full rounded px-2 py-1 text-left text-[11px] font-medium text-ledger-stamp hover:bg-ledger-stamp/5"
                >
                  Clear selection
                </button>
              )}
              {options.map((opt) => {
                const checked = selected.has(opt)
                return (
                  <button
                    key={opt}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggleOption(opt)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-ink-700 hover:bg-ink-50"
                  >
                    {checked ? (
                      <CheckSquare className="h-3.5 w-3.5 shrink-0 text-ledger-stamp" />
                    ) : (
                      <Square className="h-3.5 w-3.5 shrink-0 text-ink-300" />
                    )}
                    <span className="truncate">{opt}</span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Small badge for the 2307 Attached column — three distinct visual
// states (yes / no / unset) rather than collapsing "no" and "unset"
// together, since those mean different things operationally (confirmed
// not attached vs. simply never recorded).
function Attachment2307Badge({ value }) {
  const state = attachment2307State(value)
  if (state === 'yes') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-medium text-emerald-700">
        <BadgeCheck className="h-2.5 w-2.5" />
        2307 attached
      </span>
    )
  }
  if (state === 'no') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[9px] font-medium text-ink-500">
        <BadgeX className="h-2.5 w-2.5" />
        Not attached
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink-50 px-2 py-0.5 text-[9px] font-medium text-ink-400">
      <BadgeHelp className="h-2.5 w-2.5" />
      Not set
    </span>
  )
}

// Three-stage progress indicator for the overall workflow: select checks
// -> generate the transmittal report -> submit for approval. Purely
// informational (no click-through) — it exists so a verifier always
// knows where they stand before opening the transmittal modal, not as
// another set of controls to manage.
function WorkflowStepper({ activeStep }) {
  const steps = [
    { n: 1, label: 'Select checks' },
    { n: 2, label: 'Generate transmittal report' },
    { n: 3, label: 'Submit for approval' },
  ]
  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg border border-ink-100 bg-white px-4 py-3">
      {steps.map((s, idx) => {
        const state = s.n < activeStep ? 'done' : s.n === activeStep ? 'active' : 'upcoming'
        return (
          <React.Fragment key={s.n}>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors',
                  state === 'done' && 'bg-ledger-stamp text-white',
                  state === 'active' && 'bg-ledger-stamp/15 text-ledger-stampDark ring-2 ring-ledger-stamp/40',
                  state === 'upcoming' && 'bg-ink-100 text-ink-400',
                )}
              >
                {state === 'done' ? <Check className="h-3.5 w-3.5" /> : s.n}
              </span>
              <span className={cn('hidden text-xs font-medium sm:inline', state === 'upcoming' ? 'text-ink-400' : 'text-ink-800')}>
                {s.label}
              </span>
            </div>
            {idx < steps.length - 1 && (
              <div className={cn('h-px flex-1 transition-colors', s.n < activeStep ? 'bg-ledger-stamp/40' : 'bg-ink-100')} />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------

export default function StaleWatchPanel({ onSubmitted }) {
  const {
    name: adminName,
    // Canonical checks.pickup_branch value for this verifier (already
    // translated from profiles.branch by ProfileContext), and whether
    // they're allowed to see every branch (admins, or profiles.branch =
    // 'all_branches'). Every query and UI affordance below is scoped
    // off these two — never off the raw `branch` enum value directly.
    pickupBranch,
    isAllBranches,
    loading: profileLoading,
    error: profileError,
  } = useProfile()
  const { push } = useToast()

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // -- filters -----------------------------------------------------------
  const [searchTerm, setSearchTerm] = useState('')
  // Off by default: the report is meant to cover checks that ARE stale.
  // Nearing-stale checks are an opt-in early-warning inclusion, never an
  // accidental one — see reportableRows below, which is the ONE place
  // that decides what's actually selectable/reportable at any moment.
  const [includeNearingStale, setIncludeNearingStale] = useState(false)
  const [bankFilter, setBankFilter] = useState(() => new Set()) // empty = all banks
  const [branchFilter, setBranchFilter] = useState(() => new Set()) // empty = all branches
  const [attachment2307Filter, setAttachment2307Filter] = useState('all') // all | yes | no | unset
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [sortBy, setSortBy] = useState(DEFAULT_SORT)
  const [showFilters, setShowFilters] = useState(true)

  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [collapsedBranches, setCollapsedBranches] = useState(() => new Set())
  // Bank-level collapse, keyed by `${branch}::${bank}` so the same bank
  // name appearing under two different branches collapses independently.
  const [collapsedBanks, setCollapsedBanks] = useState(() => new Set())

  // reportLock: { reportNumber, checkIds: Set } | null. Set only right
  // after a report has actually been generated (server-recorded via
  // verifier_record_staled_check_report). Cleared the instant the
  // selection changes to anything other than exactly what was locked —
  // see the effect below. Submission is blocked in the UI unless this
  // is present AND still matches selectedIds; the RPC re-checks this
  // server-side regardless (see migration 002).
  const [reportLock, setReportLock] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // A single modal now carries the ENTIRE transmittal flow — review the
  // selection, generate + lock the report number, preview the rendered
  // PDF/Excel, and submit for approval — instead of a confirm dialog and
  // a separate preview dialog with the actual "Submit" action living
  // outside both of them in the page's sticky bar. `step` drives which
  // face of the same modal is showing:
  //   'confirm' -> summary + "Generate & lock report" (no server call yet)
  //   'preview' -> rendered report + "Submit for approval" (the report
  //                number is already locked server-side at this point)
  // `open` can be false while `step`/`reportNumber`/etc. remain populated
  // — that's what lets "Continue to submission" reopen directly on the
  // preview step without regenerating anything.
  const [reportModal, setReportModal] = useState({
    open: false,
    step: 'confirm',
    summary: null,
    reportNumber: '',
    selectedRows: [],
    xlsxBlob: null,
    pdfDoc: null,
    pdfUrl: '',
  })

  const loadStaleChecks = useCallback(async () => {
    // Never query before we know whether/how to scope by branch — the
    // profile row (and its branch) is still resolving.
    if (profileLoading) return

    // A branch-scoped verifier whose profile has no resolvable
    // pickupBranch (misconfigured or unmapped `profiles.branch`) must
    // NEVER fall through to an unfiltered query — that would silently
    // show every branch's checks to someone who isn't supposed to see
    // them. Fail closed: show nothing and let the render layer surface
    // an explicit configuration error instead.
    if (!isAllBranches && !pickupBranch) {
      setRows([])
      setLoadError('')
      setLoading(false)
      return
    }

    setLoading(true)
    setLoadError('')
    try {
      // Fetches everything through the WARNING cutoff (stale + nearing
      // stale) in one query. The nearing-stale toggle below then filters
      // client-side, so switching it on/off is instant and never needs a
      // refetch.
      const cutoff = warningCutoffDateInputValue()
      let query = supabase
        .from('checks')
        .select(
          'id, bank, pickup_branch, payee, payor, check_no, check_date, amount, status, created_at, form_2307_attached',
        )
        .eq('status', 'available')
        .lte('check_date', cutoff)

      // Branch scoping — the actual data-reduction step this panel exists
      // to enforce. 'all_branches' verifiers (and admins) get every
      // branch, including checks with no pickup_branch on file. Everyone
      // else is scoped to their exact pickup_branch value via `.eq(...)`,
      // which — being a plain SQL equality check — also naturally
      // excludes NULL pickup_branch rows for them (NULL never equals
      // anything in SQL). That's intentional: an unassigned check should
      // only surface to someone who can already see every branch, not be
      // guessed into a specific one.
      //
      // NOTE: this is a UX/query-efficiency filter, not the access-control
      // boundary — it trims what's fetched for a verifier who is already
      // only supposed to see their branch. The actual boundary belongs in
      // a Postgres RLS policy on `checks` (see migration
      // 002_checks_branch_rls.sql) so the restriction holds even if a
      // client bypasses this component entirely.
      if (!isAllBranches) {
        query = query.eq('pickup_branch', pickupBranch)
      }

      const { data, error } = await query.order('check_date', { ascending: true })

      if (error) {
        setLoadError(error.message || 'Failed to load stale checks. Please try again.')
        return
      }
      setRows(data || [])
    } catch (err) {
      setLoadError(err?.message || 'Failed to load stale checks. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [profileLoading, isAllBranches, pickupBranch])

  useEffect(() => {
    loadStaleChecks()
  }, [loadStaleChecks])

  // Every check that's actually stale right now — independent of the
  // toggle — used for the always-visible summary line so a verifier can
  // see there's a growing nearing-stale pile even while the toggle is
  // off and those rows are hidden from the list below. Already scoped to
  // the verifier's branch, since `rows` itself is.
  const overallStats = useMemo(() => {
    let staleCount = 0
    let staleAmount = 0
    let warningCount = 0
    let warningAmount = 0
    for (const r of rows) {
      const amount = Number(r.amount || 0)
      if (getStaleBucket(r.check_date) === STALE_BUCKETS.STALE) {
        staleCount += 1
        staleAmount += amount
      } else {
        warningCount += 1
        warningAmount += amount
      }
    }
    return { staleCount, staleAmount, warningCount, warningAmount }
  }, [rows])

  // THE gate for what's selectable/reportable at any given moment. With
  // the toggle off, nearing-stale rows are excluded entirely — not just
  // visually dimmed — so they can never end up in a report by accident.
  // This is intentionally kept separate from the view-only filters below
  // (search/bank/branch/2307/amount/sort): those only change what's
  // VISIBLE, never what's eligible for selection or reporting.
  const reportableRows = useMemo(() => {
    if (includeNearingStale) return rows
    return rows.filter((r) => getStaleBucket(r.check_date) === STALE_BUCKETS.STALE)
  }, [rows, includeNearingStale])

  // Drops any selected id that's no longer reportable — whether because
  // it disappeared from the underlying data on refresh (someone else
  // actioned it, or it fell outside the verifier's branch scope) or
  // because the nearing-stale toggle just excluded it. View-only filters
  // deliberately do NOT trigger this — a selection made before filtering
  // should survive the filter changing.
  useEffect(() => {
    const allowedIds = new Set(reportableRows.map((r) => r.id))
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => allowedIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [reportableRows])

  useEffect(() => {
    if (!reportLock) return
    if (!setsEqual(reportLock.checkIds, selectedIds)) {
      setReportLock(null)
    }
  }, [selectedIds, reportLock])

  // Revoke the preview PDF's blob URL on unmount, so closing the tab
  // mid-review doesn't leak memory.
  useEffect(() => {
    return () => {
      if (reportModal.pdfUrl) URL.revokeObjectURL(reportModal.pdfUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportModal.pdfUrl])

  // Options for the Bank / Branch filter dropdowns — derived from
  // whatever's currently reportable (respecting the nearing-stale
  // toggle), so a verifier never sees a bank/branch filter option with
  // zero possible matches. For a branch-scoped verifier this will only
  // ever contain their one branch, which is why the Branch filter control
  // itself is hidden for them below (see `isAllBranches` in the render).
  const availableBanks = useMemo(() => {
    return [...new Set(reportableRows.map((r) => r.bank || UNSPECIFIED_BANK))].sort()
  }, [reportableRows])

  const availableBranches = useMemo(() => {
    return [...new Set(reportableRows.map((r) => r.pickup_branch || UNSPECIFIED_BRANCH))].sort()
  }, [reportableRows])

  const minAmountValue = minAmount.trim() === '' ? null : Number(minAmount)
  const maxAmountValue = maxAmount.trim() === '' ? null : Number(maxAmount)
  const minAmountInvalid = minAmount.trim() !== '' && Number.isNaN(minAmountValue)
  const maxAmountInvalid = maxAmount.trim() !== '' && Number.isNaN(maxAmountValue)

  // All view-only filters composed into one pass. Order doesn't matter
  // functionally (every check is a plain AND), but search is checked
  // first since it's the filter most likely to eliminate a row quickly.
  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return reportableRows.filter((r) => {
      if (term) {
        const haystack = [r.payee, r.payor, r.check_no, r.bank, r.pickup_branch]
        if (!haystack.some((v) => String(v || '').toLowerCase().includes(term))) return false
      }
      if (bankFilter.size > 0 && !bankFilter.has(r.bank || UNSPECIFIED_BANK)) return false
      if (branchFilter.size > 0 && !branchFilter.has(r.pickup_branch || UNSPECIFIED_BRANCH)) return false
      if (attachment2307Filter !== 'all' && attachment2307State(r.form_2307_attached) !== attachment2307Filter) {
        return false
      }
      if (minAmountValue !== null && !Number.isNaN(minAmountValue) && Number(r.amount || 0) < minAmountValue) {
        return false
      }
      if (maxAmountValue !== null && !Number.isNaN(maxAmountValue) && Number(r.amount || 0) > maxAmountValue) {
        return false
      }
      return true
    })
  }, [reportableRows, searchTerm, bankFilter, branchFilter, attachment2307Filter, minAmountValue, maxAmountValue])

  const grouped = useMemo(() => groupByBranchThenBank(filteredRows, sortBy), [filteredRows, sortBy])

  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  const activeFilterCount = useMemo(() => {
    let count = 0
    if (searchTerm.trim()) count += 1
    if (bankFilter.size > 0) count += 1
    if (branchFilter.size > 0) count += 1
    if (attachment2307Filter !== 'all') count += 1
    if (minAmount.trim() !== '') count += 1
    if (maxAmount.trim() !== '') count += 1
    return count
  }, [searchTerm, bankFilter, branchFilter, attachment2307Filter, minAmount, maxAmount])

  function clearAllFilters() {
    setSearchTerm('')
    setBankFilter(new Set())
    setBranchFilter(new Set())
    setAttachment2307Filter('all')
    setMinAmount('')
    setMaxAmount('')
  }

  const selectionSummary = useMemo(() => {
    let count = 0
    let amount = 0
    let staleCount = 0
    let warningCount = 0
    for (const id of selectedIds) {
      const r = rowsById.get(id)
      if (!r) continue
      count += 1
      amount += Number(r.amount || 0)
      if (getStaleBucket(r.check_date) === STALE_BUCKETS.STALE) staleCount += 1
      else warningCount += 1
    }
    return { count, amount, staleCount, warningCount }
  }, [selectedIds, rowsById])

  // How many currently-selected checks are hidden by the active view
  // filters. Selection is never silently dropped by a filter (see the
  // effect above), but a verifier should still know some of what they've
  // selected isn't currently on screen, in case that's a mistake.
  const hiddenSelectedCount = useMemo(() => {
    if (selectedIds.size === 0) return 0
    const visibleIds = new Set(filteredRows.map((r) => r.id))
    let hidden = 0
    for (const id of selectedIds) {
      if (rowsById.has(id) && !visibleIds.has(id)) hidden += 1
    }
    return hidden
  }, [selectedIds, filteredRows, rowsById])

  // The one-bank-per-branch rule, checked live against the current
  // selection. The Staled Check Report groups strictly by branch, and
  // each branch section returns to exactly one bank — so a selection
  // spanning two banks within the same branch can never be turned into
  // a valid report. Surfacing this as the selection changes (rather
  // than only after "Generate" is clicked) lets a verifier fix it
  // before they even open the confirm dialog.
  const mixedBankBranchWarning = useMemo(() => {
    if (selectionSummary.count === 0) return null
    const selectedRows = [...selectedIds].map((id) => rowsById.get(id)).filter(Boolean)
    return findMixedBankBranch(selectedRows)
  }, [selectedIds, selectionSummary.count, rowsById])

  const reportLockValid = !!reportLock && selectionSummary.count > 0 && setsEqual(reportLock.checkIds, selectedIds)

  const activeStep = reportLockValid ? 3 : selectionSummary.count > 0 ? 2 : 1

  // -- selection toggles ------------------------------------------------

  const toggleOne = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleBank = useCallback((bankRows) => {
    const ids = bankRows.map((r) => r.id)
    setSelectedIds((prev) => {
      const allSelected = ids.every((id) => prev.has(id))
      const next = new Set(prev)
      ids.forEach((id) => (allSelected ? next.delete(id) : next.add(id)))
      return next
    })
  }, [])

  // Cascades selection down through every bank in the branch, and — by
  // extension — every row in each of those banks. This is the "banks
  // cascade the checks" behavior: selecting a branch selects all of its
  // banks' checks in one action, same as selecting a bank selects all of
  // its checks.
  const toggleBranch = useCallback((branchGroup) => {
    const ids = branchGroup.banks.flatMap((b) => b.rows.map((r) => r.id))
    setSelectedIds((prev) => {
      const allSelected = ids.every((id) => prev.has(id))
      const next = new Set(prev)
      ids.forEach((id) => (allSelected ? next.delete(id) : next.add(id)))
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    const ids = filteredRows.map((r) => r.id)
    setSelectedIds((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id))
      return allSelected ? new Set() : new Set(ids)
    })
  }, [filteredRows])

  const toggleCollapsedBranch = useCallback((branch) => {
    setCollapsedBranches((prev) => {
      const next = new Set(prev)
      if (next.has(branch)) next.delete(branch)
      else next.add(branch)
      return next
    })
  }, [])

  // Bank-level collapse cascades visually the same way branch collapse
  // does — collapsing a bank hides its check rows while leaving its
  // sibling banks (and the branch header) untouched, so a verifier can
  // drill into just the bank they're reviewing.
  const toggleCollapsedBank = useCallback((branch, bank) => {
    const key = `${branch}::${bank}`
    setCollapsedBanks((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const allVisibleSelected = filteredRows.length > 0 && filteredRows.every((r) => selectedIds.has(r.id))

  // -- transmittal report flow --------------------------------------------
  //
  // Document rendering itself (PDF + Excel, portrait, one section per
  // branch) lives in lib/staleCheckReportDocument.js and is shared with
  // StaleReportHistory.jsx, so a report reopened later looks identical
  // to what was produced here at generation time.

  // Opens the transmittal modal on its 'confirm' face, with a snapshot of
  // the current selection. No server call yet —
  // verifier_record_staled_check_report burns a report number the
  // moment it's called, so we only call it once the verifier has
  // explicitly confirmed what they're locking in.
  function handleRequestGenerate() {
    if (selectionSummary.count === 0) {
      push({ variant: 'error', title: 'Nothing selected', description: 'Select at least one check to include in the report.' })
      return
    }
    const snapshot = [...selectedIds].map((id) => rowsById.get(id)).filter(Boolean)
    const mixedBankError = findMixedBankBranch(snapshot)
    if (mixedBankError) {
      push({ variant: 'error', title: 'One bank per branch required', description: mixedBankError })
      return
    }
    setReportModal((prev) => ({ ...prev, open: true, step: 'confirm', summary: computeReportSummary(snapshot) }))
  }

  // Closes the modal while on the 'confirm' face — nothing has been
  // generated or locked yet, so this fully discards the pending summary
  // rather than leaving stale data around for next time.
  function cancelConfirm() {
    if (generating) return
    setReportModal((prev) => ({ ...prev, open: false, step: 'confirm', summary: null }))
  }

  async function handleConfirmGenerate() {
    const trimmedAdminName = (adminName || '').trim()
    if (!trimmedAdminName) {
      push({ variant: 'error', title: 'Could not identify verifier', description: 'Please refresh and try again.' })
      setReportModal((prev) => ({ ...prev, open: false, step: 'confirm', summary: null }))
      return
    }

    const idList = [...selectedIds]
    const precheckRows = idList.map((id) => rowsById.get(id)).filter(Boolean)
    const mixedBankError = findMixedBankBranch(precheckRows)
    if (mixedBankError) {
      // Re-checked here (not just at modal-open time) since the
      // selection is live and could theoretically change while the
      // modal is open.
      push({ variant: 'error', title: 'One bank per branch required', description: mixedBankError })
      setReportModal((prev) => ({ ...prev, open: false, step: 'confirm', summary: null }))
      return
    }

    setGenerating(true)
    try {
      // Server-side record FIRST — this is what migration 002 checks
      // against at submission time, not the files we're about to build.
      const { data: reportNumber, error } = await supabase.rpc('verifier_record_staled_check_report', {
        p_check_ids: idList,
        p_admin_name: trimmedAdminName,
      })
      if (error || !reportNumber) {
        push({ variant: 'error', title: 'Could not generate transmittal report', description: error?.message || 'Please try again.' })
        return
      }

      const selectedRows = idList.map((id) => rowsById.get(id)).filter(Boolean)
      const summary = computeReportSummary(selectedRows)
      const generatedAt = new Date().toISOString()

      const docArgs = {
        reportNumber,
        generatedAt,
        generatedByName: trimmedAdminName,
        submittedAt: null,
        submittedByName: null,
        status: 'generated',
        rows: selectedRows,
      }

      const workbook = await buildStaleCheckReportWorkbook(docArgs)
      const buffer = await workbook.xlsx.writeBuffer()
      const xlsxBlob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })

      const pdfDoc = await buildStaleCheckReportPdf(docArgs)
      const pdfUrl = pdfDoc.output('bloburl')

      // Single state transition: same modal, same open dialog, just
      // swaps from the confirm face to the preview face — this is what
      // keeps generation and submission inside one continuous flow
      // instead of handing off between two separate dialogs.
      setReportModal((prev) => {
        if (prev.pdfUrl) URL.revokeObjectURL(prev.pdfUrl)
        return { open: true, step: 'preview', summary, reportNumber, selectedRows, xlsxBlob, pdfDoc, pdfUrl }
      })

      setReportLock({ reportNumber, checkIds: new Set(idList) })
      push({
        variant: 'success',
        title: 'Transmittal report generated',
        description: `${reportNumber} — ${idList.length} check${idList.length === 1 ? '' : 's'}. Review it below, then submit for approval.`,
      })
    } catch (err) {
      push({ variant: 'error', title: 'Could not generate transmittal report', description: err?.message || 'Please try again.' })
    } finally {
      setGenerating(false)
    }
  }

  function handleDownloadExcelFromPreview() {
    if (!reportModal.xlsxBlob) return
    const url = URL.createObjectURL(reportModal.xlsxBlob)
    const link = document.createElement('a')
    link.href = url
    link.download = `staled-check-report-${reportModal.reportNumber}.xlsx`
    link.click()
    URL.revokeObjectURL(url)
  }

  function handleDownloadPdfFromPreview() {
    if (!reportModal.pdfDoc) return
    reportModal.pdfDoc.save(`staled-check-report-${reportModal.reportNumber}.pdf`)
  }

  // Closes the modal while KEEPING the preview data (report is already
  // locked server-side) — this is what "Continue to submission" below
  // reopens straight back into, without regenerating anything.
  function closePreview() {
    setReportModal((prev) => ({ ...prev, open: false }))
  }

  function reopenPreview() {
    if (reportModal.step !== 'preview') return
    setReportModal((prev) => ({ ...prev, open: true }))
  }

  // Fully discards the generated report artifacts. Call this only when
  // the report is truly done being useful — after a successful submit —
  // so the blob URL gets freed instead of lingering until the next
  // generate/unmount.
  function discardPreview() {
    setReportModal((prev) => {
      if (prev.pdfUrl) URL.revokeObjectURL(prev.pdfUrl)
      return { open: false, step: 'confirm', summary: null, reportNumber: '', selectedRows: [], xlsxBlob: null, pdfDoc: null, pdfUrl: '' }
    })
  }

  async function handleSubmit() {
    if (!reportLockValid) return
    const trimmedAdminName = (adminName || '').trim()
    if (!trimmedAdminName) {
      push({ variant: 'error', title: 'Could not identify verifier', description: 'Please refresh and try again.' })
      return
    }

    setSubmitting(true)
    try {
      const { data: updatedCount, error } = await supabase.rpc('verifier_submit_stale_checks_for_approval', {
        p_check_ids: [...reportLock.checkIds],
        p_admin_name: trimmedAdminName,
        p_report_number: reportLock.reportNumber,
      })

      if (error) {
        push({ variant: 'error', title: 'Submission failed', description: error.message || 'Please try again.' })
        return
      }

      push({
        variant: 'success',
        title: 'Submitted for approval',
        description: `${updatedCount} check${updatedCount === 1 ? '' : 's'} sent via transmittal report ${reportLock.reportNumber}.`,
      })

      setSelectedIds(new Set())
      setReportLock(null)
      discardPreview()
      await loadStaleChecks()
      onSubmitted?.()
    } catch (err) {
      push({ variant: 'error', title: 'Submission failed', description: err?.message || 'Please try again.' })
    } finally {
      setSubmitting(false)
    }
  }

  // -- render --------------------------------------------------------

  // Profile itself failed to load — nothing below is trustworthy without
  // it (we wouldn't even know what branch to scope to), so stop here
  // rather than rendering a panel that might be silently unscoped.
  if (profileError) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Could not load your profile: {profileError}
      </div>
    )
  }

  // Profile loaded, but a non-'all_branches' verifier has no mappable
  // branch on file. This is a data problem (their `profiles.branch` is
  // NULL, or set to a value BRANCH_TO_PICKUP_BRANCH doesn't recognize),
  // not something the UI should paper over — surfacing it clearly beats
  // either an unfiltered fetch or an unexplained empty list.
  if (!profileLoading && !isAllBranches && !pickupBranch) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Your account isn't assigned to a branch, so Stale Watch can't determine which checks to show you.
        Please ask an admin to set your branch in your profile.
      </div>
    )
  }

  return (
    <div>
      <WorkflowStepper activeStep={activeStep} />

      {/* Nearing-stale inclusion toggle. Off by default: the report
          covers checks that ARE stale unless the verifier explicitly
          opts in. Kept separate from the view-only filter bar below,
          since this one changes what's ELIGIBLE for reporting, not just
          what's currently visible. */}
      <div className="mb-3 flex items-center gap-3 rounded-lg border border-ink-100 bg-white px-4 py-3">
        <div className="flex-1">
          <p className="text-xs font-semibold text-ink-700">Include nearing-stale checks</p>
          <p className="mt-0.5 text-[11px] text-ink-400">
            Checks within {WARNING_WINDOW_DAYS} days of crossing the {STALE_FIXED_MONTHS}-month stale threshold.
            Off by default so the report only covers checks that are already stale — turn this on to fold
            upcoming ones into the same report, clearly tagged as "Nearing stale."
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={includeNearingStale}
          onClick={() => setIncludeNearingStale((v) => !v)}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
            includeNearingStale ? 'bg-ledger-stamp' : 'bg-ink-200',
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
              includeNearingStale ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {/* Filter bar */}
      <div className="mb-3 rounded-lg border border-ink-100 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search payee, payor, check no, bank, or branch..."
              className="pl-8"
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
            aria-pressed={showFilters}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
              showFilters || activeFilterCount > 0
                ? 'border-ledger-stamp/40 bg-ledger-stamp/5 text-ledger-stampDark'
                : 'border-ink-200 text-ink-500 hover:bg-ink-50',
            )}
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {activeFilterCount > 0 && (
              <span className="flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-ledger-stamp px-1 text-[10px] font-semibold text-white">
                {activeFilterCount}
              </span>
            )}
            {showFilters ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>

          <Button variant="outline" onClick={loadStaleChecks} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>

        {showFilters && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
            <FilterMultiSelect
              label="Bank"
              icon={Landmark}
              options={availableBanks}
              selected={bankFilter}
              onChange={setBankFilter}
            />
            {/* Branch filter only makes sense for verifiers who can see
                more than one branch — a scoped verifier's data is already
                limited to exactly one branch at the query level, so this
                control would only ever offer a single, pre-selected-by-
                definition option. Hiding it avoids clutter without
                changing any actual access behavior. */}
            {isAllBranches && (
              <FilterMultiSelect
                label="Branch"
                icon={Building2}
                options={availableBranches}
                selected={branchFilter}
                onChange={setBranchFilter}
              />
            )}

            <select
              value={attachment2307Filter}
              onChange={(e) => setAttachment2307Filter(e.target.value)}
              className={cn(
                'rounded-md border px-2.5 py-1.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-ledger-stamp',
                attachment2307Filter !== 'all'
                  ? 'border-ledger-stamp/40 bg-ledger-stamp/5 text-ledger-stampDark'
                  : 'border-ink-200 text-ink-600',
              )}
              aria-label="Filter by 2307 attachment status"
            >
              <option value="all">2307: All</option>
              <option value="yes">2307: Attached</option>
              <option value="no">2307: Not attached</option>
              <option value="unset">2307: Not set</option>
            </select>

            <div className="flex items-center gap-1">
              <input
                type="number"
                inputMode="decimal"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                placeholder="Min amount"
                className={cn(
                  'w-28 rounded-md border px-2.5 py-1.5 text-xs text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp',
                  minAmountInvalid ? 'border-red-300' : 'border-ink-200',
                )}
              />
              <span className="text-xs text-ink-300">–</span>
              <input
                type="number"
                inputMode="decimal"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                placeholder="Max amount"
                className={cn(
                  'w-28 rounded-md border px-2.5 py-1.5 text-xs text-ink-700 focus:outline-none focus:ring-1 focus:ring-ledger-stamp',
                  maxAmountInvalid ? 'border-red-300' : 'border-ink-200',
                )}
              />
            </div>

            <div className="flex items-center gap-1.5">
              <ArrowUpDown className="h-3.5 w-3.5 text-ink-300" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 focus:outline-none focus:ring-1 focus:ring-ledger-stamp"
                aria-label="Sort checks by"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-ink-400 hover:text-red-600"
              >
                <X className="h-3.5 w-3.5" />
                Clear filters
              </button>
            )}
          </div>
        )}

        {(minAmountInvalid || maxAmountInvalid) && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-red-600">
            <AlertTriangle className="h-3 w-3" />
            Amount filter must be a number.
          </p>
        )}
      </div>

      {loadError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {loadError}
          </span>
          <button
            onClick={loadStaleChecks}
            className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      )}

      {/* Sticky action bar — generation only. Submission now lives
          exclusively inside the transmittal modal (see reportModal
          below), so there's a single place a verifier ever clicks
          "Submit for approval" instead of two. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-100 bg-ink-50/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={toggleAll}
            disabled={filteredRows.length === 0}
            className="flex items-center gap-1.5 text-xs font-medium text-ink-600 hover:text-ink-900 disabled:opacity-40"
          >
            {allVisibleSelected ? <CheckSquare className="h-4 w-4 text-ledger-stamp" /> : <Square className="h-4 w-4" />}
            {allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
          </button>
          <span className="text-xs text-ink-400">
            {selectionSummary.count} selected
            {selectionSummary.count > 0 && (
              <>
                {' '}
                ({selectionSummary.staleCount} stale, {selectionSummary.warningCount} nearing) ·{' '}
                {formatCurrency(selectionSummary.amount)}
              </>
            )}
          </span>
          {hiddenSelectedCount > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              <Info className="h-3 w-3" />
              {hiddenSelectedCount} selected {hiddenSelectedCount === 1 ? 'check is' : 'checks are'} hidden by filters
              {activeFilterCount > 0 && (
                <button onClick={clearAllFilters} className="ml-1 font-semibold underline">
                  clear filters
                </button>
              )}
            </span>
          )}
        </div>

        <Button
          variant="outline"
          onClick={handleRequestGenerate}
          disabled={generating || selectionSummary.count === 0 || !!mixedBankBranchWarning}
          title={
            selectionSummary.count === 0
              ? 'Select at least one check first'
              : mixedBankBranchWarning || undefined
          }
        >
          {generating ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileSpreadsheet className="mr-2 h-3.5 w-3.5" />
          )}
          {generating ? 'Generating…' : 'Generate Transmittal Report'}
        </Button>
      </div>

      {mixedBankBranchWarning && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {mixedBankBranchWarning}
        </div>
      )}
      {reportLock && !reportLockValid && selectionSummary.count > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <Info className="h-3.5 w-3.5 shrink-0" />
          Your selection changed after the transmittal report was generated — generate a new one before submitting.
        </div>
      )}

      {/* Premium "ready to submit" card — the primary way back into the
          modal once a verifier has closed it without submitting. Distinct
          from a plain text link so this reads as an actionable next step,
          not incidental status text. */}
      {reportLockValid && !reportModal.open && (
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-ledger-stamp/30 bg-gradient-to-r from-ledger-stamp/5 via-white to-white px-4 py-3.5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ledger-stamp/10 text-ledger-stamp">
              <FileCheck2 className="h-4.5 w-4.5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink-900">Transmittal report {reportLock.reportNumber} is ready</p>
              <p className="text-xs text-ink-400">This exact selection is locked in — submit it for approval whenever you're ready.</p>
            </div>
          </div>
          <Button variant="stamp" onClick={reopenPreview} className="shrink-0">
            Continue to submission
            <ArrowRight className="ml-2 h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Grouped list */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-ink-300">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-ink-200 text-ink-300">
            <Inbox className="h-5 w-5" />
          </span>
          <p className="mt-3 text-sm font-medium text-ink-600">
            {rows.length === 0
              ? !isAllBranches && pickupBranch
                ? `No checks are stale or nearing stale for ${pickupBranch}`
                : 'No checks are stale or nearing stale'
              : reportableRows.length === 0
              ? `No checks are currently stale — ${overallStats.warningCount} nearing stale`
              : activeFilterCount > 0
              ? 'No checks match your filters'
              : 'No checks match your search'}
          </p>
          {rows.length > 0 && reportableRows.length === 0 && !includeNearingStale && (
            <button
              onClick={() => setIncludeNearingStale(true)}
              className="mt-2 text-xs font-medium text-ledger-stamp hover:underline"
            >
              Include nearing-stale checks
            </button>
          )}
          {reportableRows.length > 0 && activeFilterCount > 0 && (
            <button onClick={clearAllFilters} className="mt-2 text-xs font-medium text-ledger-stamp hover:underline">
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map((branchGroup) => {
            const branchIds = branchGroup.banks.flatMap((b) => b.rows.map((r) => r.id))
            const branchAllSelected = branchIds.every((id) => selectedIds.has(id))
            const branchSomeSelected = branchIds.some((id) => selectedIds.has(id))
            const branchCollapsed = collapsedBranches.has(branchGroup.branch)
            const branchHasMixedSelection =
              findMixedBankBranch(branchIds.filter((id) => selectedIds.has(id)).map((id) => rowsById.get(id)).filter(Boolean)) !== null

            return (
              <div key={branchGroup.branch} className="overflow-hidden rounded-lg border border-ink-100 bg-white">
                <div className="flex items-center gap-2 border-b border-ink-100 bg-indigo-50/40 px-4 py-2.5">
                  <button
                    onClick={() => toggleCollapsedBranch(branchGroup.branch)}
                    className="text-ink-400 hover:text-ink-700"
                    aria-label={branchCollapsed ? `Expand ${branchGroup.branch}` : `Collapse ${branchGroup.branch}`}
                  >
                    {branchCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => toggleBranch(branchGroup)}
                    className="flex items-center gap-1.5"
                    aria-label={`Select all checks in ${branchGroup.branch}`}
                  >
                    {branchAllSelected ? (
                      <CheckSquare className="h-4 w-4 text-ledger-stamp" />
                    ) : branchSomeSelected ? (
                      <CheckSquare className="h-4 w-4 text-ink-300" />
                    ) : (
                      <Square className="h-4 w-4 text-ink-300" />
                    )}
                  </button>
                  <Building2 className="h-3.5 w-3.5 text-indigo-500" />
                  <span className="text-sm font-semibold text-ink-800">{branchGroup.branch}</span>
                  <span className="text-xs text-ink-400">
                    {branchIds.length} check{branchIds.length === 1 ? '' : 's'}
                  </span>
                  {branchGroup.banks.length > 1 && (
                    <span
                      className={cn(
                        'ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-medium',
                        branchHasMixedSelection ? 'bg-red-100 text-red-700' : 'bg-ink-100 text-ink-500',
                      )}
                      title="This branch has checks from more than one bank — select from only one bank to include it in a report."
                    >
                      {branchGroup.banks.length} banks here
                    </span>
                  )}
                </div>

                {!branchCollapsed &&
                  branchGroup.banks.map((bankGroup) => {
                    const bankIds = bankGroup.rows.map((r) => r.id)
                    const bankAllSelected = bankIds.every((id) => selectedIds.has(id))
                    const bankSomeSelected = bankIds.some((id) => selectedIds.has(id))
                    const bankKey = `${branchGroup.branch}::${bankGroup.bank}`
                    const bankCollapsed = collapsedBanks.has(bankKey)

                    return (
                      <div key={bankGroup.bank} className="border-b border-ink-50 last:border-b-0">
                        <div className="flex items-center gap-2 bg-teal-50/40 px-4 py-2 pl-9">
                          <button
                            onClick={() => toggleCollapsedBank(branchGroup.branch, bankGroup.bank)}
                            className="text-ink-400 hover:text-ink-700"
                            aria-label={bankCollapsed ? `Expand ${bankGroup.bank}` : `Collapse ${bankGroup.bank}`}
                          >
                            {bankCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            onClick={() => toggleBank(bankGroup.rows)}
                            className="flex items-center gap-1.5"
                            aria-label={`Select all checks for ${bankGroup.bank}`}
                          >
                            {bankAllSelected ? (
                              <CheckSquare className="h-3.5 w-3.5 text-ledger-stamp" />
                            ) : bankSomeSelected ? (
                              <CheckSquare className="h-3.5 w-3.5 text-ink-300" />
                            ) : (
                              <Square className="h-3.5 w-3.5 text-ink-300" />
                            )}
                          </button>
                          <Landmark className="h-3 w-3 text-teal-600" />
                          <span className="text-xs font-semibold text-ink-700">{bankGroup.bank}</span>
                          <span className="text-[10px] text-ink-400">
                            {bankIds.length} check{bankIds.length === 1 ? '' : 's'} ·{' '}
                            {formatCurrency(bankGroup.rows.reduce((s, r) => s + Number(r.amount || 0), 0))}
                          </span>
                        </div>

                        {!bankCollapsed && (
                          <table className="w-full text-left text-[11px]">
                            <thead>
                              <tr className="text-[9px] uppercase tracking-wide text-ink-300">
                                <th className="w-8 py-1 pl-14 font-medium" />
                                <th className="py-1 pr-3 font-medium">Payee</th>
                                <th className="py-1 pr-3 font-medium">Payor</th>
                                <th className="py-1 pr-3 font-medium">Check No</th>
                                <th className="py-1 pr-3 font-medium">Check Date</th>
                                <th className="py-1 pr-3 font-medium">Status</th>
                                <th className="py-1 pr-3 font-medium">2307</th>
                                <th className="py-1 pr-3 font-medium">Uploaded</th>
                                <th className="py-1 pr-4 text-right font-medium">Amount</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-ink-50">
                              {bankGroup.rows.map((row) => {
                                const bucket = getStaleBucket(row.check_date)
                                const isStale = bucket === STALE_BUCKETS.STALE
                                return (
                                  <tr
                                    key={row.id}
                                    className={cn('hover:bg-ink-50/40', selectedIds.has(row.id) && 'bg-ledger-stamp/5')}
                                  >
                                    <td className="w-8 py-1.5 pl-14">
                                      <input
                                        type="checkbox"
                                        checked={selectedIds.has(row.id)}
                                        onChange={() => toggleOne(row.id)}
                                        className="h-3.5 w-3.5 accent-ledger-stamp"
                                        aria-label={`Select ${row.payee}`}
                                      />
                                    </td>
                                    <td className="py-1.5 pr-3 font-medium text-ink-800">{row.payee || '—'}</td>
                                    <td className="py-1.5 pr-3 text-ink-500">{row.payor || '—'}</td>
                                    <td className="py-1.5 pr-3 font-mono text-ink-600">{row.check_no || '—'}</td>
                                    <td className="py-1.5 pr-3 text-ink-600">
                                      {row.check_date ? formatDate(row.check_date) : '—'}
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      <span
                                        className={cn(
                                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-medium',
                                          isStale ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700',
                                        )}
                                      >
                                        <AlertTriangle className="h-2.5 w-2.5" />
                                        {isStale ? 'Stale' : 'Nearing stale'}
                                      </span>
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      <Attachment2307Badge value={row.form_2307_attached} />
                                    </td>
                                    <td className="py-1.5 pr-3 text-ink-500">
                                      <span className="inline-flex items-center gap-1">
                                        <CalendarClock className="h-2.5 w-2.5 text-ink-300" />
                                        {row.created_at ? formatDate(row.created_at) : '—'}
                                      </span>
                                    </td>
                                    <td className="py-1.5 pr-4 text-right font-mono text-ink-800">
                                      {formatCurrency(row.amount)}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )
                  })}
              </div>
            )
          })}
        </div>
      )}

      {/* Unified transmittal modal — review, generate, preview, and
          submit all live here. `reportModal.step` decides which face is
          showing; the dialog itself never closes and reopens between
          those two stages, so there's no jarring hand-off and the
          "Submit for approval" action is always reachable from wherever
          the flow currently is. */}
      {reportModal.open && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/50 p-4 backdrop-blur-[2px]"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (reportModal.step === 'confirm' && !generating) cancelConfirm()
            if (reportModal.step === 'preview' && !submitting) closePreview()
          }}
        >
          <div
            className={cn(
              'flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl',
              reportModal.step === 'confirm' ? 'max-w-md' : 'max-w-2xl',
            )}
          >
            {/* Header: shared across both faces, with a 2-step progress
                indicator so it's visually obvious this is one continuous
                flow rather than two unrelated dialogs. */}
            <div className="flex items-center justify-between gap-3 border-b border-ink-100 bg-gradient-to-br from-ledger-stamp/5 to-white px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ledger-stamp/10 text-ledger-stamp shadow-sm">
                  {reportModal.step === 'confirm' ? <FileSpreadsheet className="h-5 w-5" /> : <ClipboardCheck className="h-5 w-5" />}
                </div>
                <div>
                  <h2 className="text-base font-semibold text-ink-900">
                    {reportModal.step === 'confirm' ? 'Generate transmittal report' : `Transmittal report ${reportModal.reportNumber}`}
                  </h2>
               <p className="text-xs text-ink-400">
  {reportModal.step === 'confirm'
    ? "Review what will be locked in before it's generated."
    : `${reportModal.selectedRows.length} check${reportModal.selectedRows.length === 1 ? '' : 's'} · ${formatCurrency(reportModal.summary?.totalAmount || 0)} — ready to submit`}
</p>
                </div>
              </div>

              <div className="hidden items-center gap-1.5 sm:flex">
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold',
                    reportModal.step === 'preview' ? 'bg-ledger-stamp text-white' : 'bg-ledger-stamp/15 text-ledger-stampDark ring-2 ring-ledger-stamp/40',
                  )}
                >
                  {reportModal.step === 'preview' ? <Check className="h-3.5 w-3.5" /> : 1}
                </span>
                <span className={cn('h-px w-6', reportModal.step === 'preview' ? 'bg-ledger-stamp/40' : 'bg-ink-100')} />
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold',
                    reportModal.step === 'preview' ? 'bg-ledger-stamp/15 text-ledger-stampDark ring-2 ring-ledger-stamp/40' : 'bg-ink-100 text-ink-400',
                  )}
                >
                  2
                </span>
              </div>

              <button
                onClick={() => {
                  if (reportModal.step === 'confirm' && !generating) cancelConfirm()
                  if (reportModal.step === 'preview' && !submitting) closePreview()
                }}
                disabled={reportModal.step === 'confirm' ? generating : submitting}
                className="rounded-full p-1.5 text-ink-300 hover:bg-ink-50 hover:text-ink-600 disabled:opacity-40"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Face 1: confirm + summary */}
            {reportModal.step === 'confirm' && reportModal.summary && (
              <>
                <div className="overflow-y-auto px-6 py-5">
                  <p className="text-xs text-ink-400">
                    This locks a report number to the exact checks below. Once generated, you'll review the rendered
                    PDF/Excel and submit for approval from this same window — if the selection changes afterward,
                    you'll need to generate a new transmittal report before submitting.
                  </p>

                  <div className="mt-4 space-y-1.5 rounded-lg border border-ink-100 bg-ink-50/60 p-3 text-xs text-ink-600">
                    <p className="flex justify-between">
                      <span>Total checks</span>
                      <span className="font-semibold text-ink-800">{reportModal.summary.totalCount}</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Stale</span>
                      <span className="font-semibold text-red-600">
                        {reportModal.summary.staleCount} · {formatCurrency(reportModal.summary.staleAmount)}
                      </span>
                    </p>
                    {reportModal.summary.warningCount > 0 && (
                      <p className="flex justify-between">
                        <span>Nearing stale</span>
                        <span className="font-semibold text-amber-600">
                          {reportModal.summary.warningCount} · {formatCurrency(reportModal.summary.warningAmount)}
                        </span>
                      </p>
                    )}
                    <p className="flex justify-between border-t border-ink-200 pt-1.5">
                      <span className="font-medium text-ink-700">Total amount</span>
                      <span className="font-semibold text-ink-900">{formatCurrency(reportModal.summary.totalAmount)}</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Branches</span>
                      <span className="font-semibold text-ink-800">{reportModal.summary.byBranch.length}</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Banks</span>
                      <span className="font-semibold text-ink-800">{reportModal.summary.byBank.length}</span>
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 justify-end gap-2 border-t border-dashed border-ink-100 px-6 py-4">
                  <button
                    onClick={cancelConfirm}
                    disabled={generating}
                    className="rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmGenerate}
                    disabled={generating}
                    className="flex items-center gap-2 rounded-md bg-ledger-stamp px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-60"
                  >
                    {generating && <Loader2 className="h-4 w-4 animate-spin" />}
                    {generating ? 'Generating…' : 'Generate & lock report'}
                  </button>
                </div>
              </>
            )}

            {/* Face 2: rendered preview + the actual submission action */}
            {reportModal.step === 'preview' && (
              <>
                <div className="flex items-center justify-end gap-2 border-b border-dashed border-ink-100 px-5 py-2.5">
                  <Button size="sm" variant="outline" onClick={handleDownloadExcelFromPreview}>
                    <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" /> Excel
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleDownloadPdfFromPreview}>
                    <Download className="mr-1.5 h-3.5 w-3.5" /> PDF
                  </Button>
                </div>
                <iframe title="Transmittal report preview" src={reportModal.pdfUrl} className="min-h-[50vh] flex-1" />
                <div className="flex shrink-0 flex-col gap-3 border-t border-dashed border-ink-100 bg-ink-50/40 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="flex items-center gap-1.5 text-xs text-ink-400">
                    <Info className="h-3.5 w-3.5 shrink-0" />
                    Not ready yet? You can close this and submit later — the report stays locked to this selection.
                  </p>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={closePreview}
                      disabled={submitting}
                      className="rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
                    >
                      Close — submit later
                    </button>
                    <button
                      onClick={handleSubmit}
                      disabled={!reportLockValid || submitting}
                      className="flex items-center gap-2 rounded-md bg-ledger-stamp px-5 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-60"
                    >
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      {submitting ? 'Submitting…' : 'Submit for approval'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}