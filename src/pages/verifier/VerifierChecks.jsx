import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  Search,
  RotateCcw,
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  X,
  AlertTriangle,
  Loader2,
  Inbox,
  Copy,
  Check,
  Minimize2,
  Maximize2,
  Send,
  Hourglass,
  CheckSquare,
  Square,
  Layers,
  Wallet,
  CircleCheckBig,
  Clock,
  Landmark,
  Building2,
  UserRound,
  ClipboardList,
  ReceiptText,
  ListChecks,
  CalendarClock,
} from 'lucide-react'
import { useProfile } from '../../context/ProfileContext'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent } from '../../components/ui/card'
import { useToast } from '../../components/ui/toast'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import CollectorNameInput from '../../components/CollectorNameInput'
import StaleWatchPanel from './StaleWatchPanel'
import StaleReportHistory from './StaleReportHistory'
import VerifierStaleApprovals from './VerifierStaleApprovals'
import {
  STALE_BUCKETS,
  getStaleBucket,
  staleCutoffDateInputValue,
  warningCutoffDateInputValue,
  normalizeCollectorName,
  dedupeCollectorNames,
} from '../../lib/staleChecks'

const PAGE_SIZE_OPTIONS = [25, 50, 100]
const SORTABLE_COLUMNS = ['payee', 'check_date', 'amount', 'uploaded_at', 'bank', 'pickup_branch']
const DEBOUNCE_MS = 300
const RECEIPT_TYPES = ['PR', 'AR', 'OR']

const STATUS_CONFIG = Object.freeze({
  available: { value: 'available', label: 'Available', icon: Wallet, secondary: 'Ready for pickup', accent: 'teal', summaryClass: 'text-ledger-stamp' },
  reserved: { value: 'reserved', label: 'Reserved', icon: Clock, secondary: 'Held by a collector', accent: 'sky', summaryClass: 'text-sky-600' },
  pending_approval: { value: 'pending_approval', label: 'Pending approval', icon: Hourglass, secondary: 'Awaiting approver review', accent: 'orange', summaryClass: 'text-amber-600' },
  returned: { value: 'returned', label: 'Returned', icon: RotateCcw, secondary: 'Sent back for correction', accent: 'amber', summaryClass: 'text-orange-600' },
  picked_up: { value: 'picked_up', label: 'Picked up', icon: CircleCheckBig, secondary: 'Completed pickups', accent: 'teal', summaryClass: '' },
})
const STATUS_ORDER = Object.freeze(['available', 'reserved', 'pending_approval', 'returned', 'picked_up'])

function statusLabel(s) {
  return STATUS_CONFIG[s]?.label || s || 'Unknown'
}

function composeReceiptNo(entry) {
  const type = entry?.receiptType || ''
  const no = entry?.receiptNo?.trim() || ''
  if (!type || !no) return ''
  return `${type}-${no}`
}

function formatDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const INITIAL_FILTER_STATE = Object.freeze({
  query: '',
  status: 'all',
  dateFrom: '',
  dateTo: '',
  uploadedFrom: '',
  uploadedTo: '',
  amountMin: '',
  amountMax: '',
  fileFilter: '',
  collectorFilter: '',
  bankFilter: '',
  branchFilter: '',
})

function filtersReducer(state, action) {
  switch (action.type) {
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value }
    case 'CLEAR_ADVANCED':
      return {
        ...state,
        dateFrom: '', dateTo: '', uploadedFrom: '', uploadedTo: '',
        amountMin: '', amountMax: '', fileFilter: '', collectorFilter: '',
        bankFilter: '', branchFilter: '',
      }
    case 'RESET_ALL':
      return INITIAL_FILTER_STATE
    default:
      return state
  }
}

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

export default function VerifierChecks() {
  const {
    name: adminName,
    pickupBranch,
    isAllBranches,
    loading: profileLoading,
  } = useProfile()

  // Non-admin, non-all-branches profiles are hard-locked to their own
  // branch. Every query in this component is gated on this being true —
  // if a profile has no resolvable branch, no request is ever fired, so
  // a missing assignment can never silently fall through to an unscoped
  // (all-branches) query.
  const hasUsableScope = isAllBranches || !!pickupBranch

  const [activeTab, setActiveTab] = useState('register')

  const [filterState, dispatchFilter] = useReducer(filtersReducer, INITIAL_FILTER_STATE)
  const {
    query, status, dateFrom, dateTo, uploadedFrom, uploadedTo,
    amountMin, amountMax, fileFilter, collectorFilter, bankFilter, branchFilter,
  } = filterState

  const setField = useCallback((field, value) => dispatchFilter({ type: 'SET_FIELD', field, value }), [])
  const clearAdvancedFilters = useCallback(() => dispatchFilter({ type: 'CLEAR_ADVANCED' }), [])
  const resetAllFilters = useCallback(() => {
    dispatchFilter({ type: 'RESET_ALL' })
    setSortKey('created_at')
    setSortAsc(false)
  }, [])

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [fileOptions, setFileOptions] = useState([])
  const [collectorOptions, setCollectorOptions] = useState([])
  const [bankOptions, setBankOptions] = useState([])
  const [branchOptions, setBranchOptions] = useState([])
  const [sortKey, setSortKey] = useState('created_at')
  const [sortAsc, setSortAsc] = useState(false)
  const [pageSize, setPageSize] = useState(25)
  const [density, setDensity] = useState('comfortable')
  const [rows, setRows] = useState([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [isPending, startTransition] = useTransition()
  const [stats, setStats] = useState(() => Object.fromEntries(STATUS_ORDER.map((s) => [s, null])))
  const [staleKpis, setStaleKpis] = useState({ stale: null, warning: null })
  const [submitTargets, setSubmitTargets] = useState(null)
  const [submitSubmitting, setSubmitSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [cancelingIds, setCancelingIds] = useState(() => new Set())
  const [selectedIds, setSelectedIds] = useState(() => new Set())

  const { push } = useToast()
  const isMountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const searchInputRef = useRef(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== '/') return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Applies the mandatory branch scope to any Supabase query builder for
  // `checks`. Every read in this component routes through this — there is
  // no code path that queries `checks` without it.
  const scopeToBranch = useCallback(
    (req) => (isAllBranches ? req : req.eq('pickup_branch', pickupBranch)),
    [isAllBranches, pickupBranch],
  )

  const loadFilterOptions = useCallback(async () => {
    if (!hasUsableScope) return
    try {
      const [batchesRes, collectorsRes, banksRes] = await Promise.all([
        supabase.from('upload_batches').select('id, file_name').order('uploaded_at', { ascending: false }).limit(200),
        scopeToBranch(
          supabase.from('checks').select('picked_up_by, collector_name').or('picked_up_by.not.is.null,collector_name.not.is.null'),
        ).limit(1000),
        scopeToBranch(supabase.from('checks').select('bank').not('bank', 'is', null)).limit(2000),
      ])

      if (!batchesRes.error) setFileOptions(batchesRes.data || [])

      if (!collectorsRes.error) {
        const rawNames = (collectorsRes.data || []).flatMap((r) => [r.picked_up_by, r.collector_name]).filter(Boolean)
        setCollectorOptions(dedupeCollectorNames(rawNames))
      }

      if (!banksRes.error) {
        setBankOptions([...new Set((banksRes.data || []).map((r) => r.bank).filter(Boolean))].sort())
      }

      if (isAllBranches) {
        const branchesRes = await supabase.from('checks').select('pickup_branch').not('pickup_branch', 'is', null).limit(2000)
        if (!branchesRes.error) {
          setBranchOptions([...new Set((branchesRes.data || []).map((r) => r.pickup_branch).filter(Boolean))].sort())
        }
      } else {
        setBranchOptions(pickupBranch ? [pickupBranch] : [])
      }
    } catch (err) {
      console.error('Failed to load filter options:', err)
    }
  }, [hasUsableScope, isAllBranches, pickupBranch, scopeToBranch])

  useEffect(() => {
    loadFilterOptions()
  }, [loadFilterOptions])

  const loadStaleKpis = useCallback(async () => {
    if (!hasUsableScope) {
      setStaleKpis({ stale: null, warning: null })
      return
    }
    try {
      const staleCutoff = staleCutoffDateInputValue()
      const warningCutoff = warningCutoffDateInputValue()
      const [staleRes, warningRes] = await Promise.all([
        scopeToBranch(
          supabase.from('checks').select('id', { count: 'exact', head: true }).eq('status', 'available').lte('check_date', staleCutoff),
        ),
        scopeToBranch(
          supabase
            .from('checks')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'available')
            .gt('check_date', staleCutoff)
            .lte('check_date', warningCutoff),
        ),
      ])
      if (!isMountedRef.current) return
      setStaleKpis({
        stale: staleRes.error ? null : staleRes.count ?? 0,
        warning: warningRes.error ? null : warningRes.count ?? 0,
      })
    } catch (err) {
      console.error('Failed to load stale KPIs:', err)
      if (isMountedRef.current) setStaleKpis({ stale: null, warning: null })
    }
  }, [hasUsableScope, scopeToBranch])

  useEffect(() => {
    loadStaleKpis()
  }, [loadStaleKpis])
    const [pendingDecisionCount, setPendingDecisionCount] = useState(null)

  const loadPendingDecisionCount = useCallback(async () => {
    if (!hasUsableScope) {
      setPendingDecisionCount(null)
      return
    }
    try {
      let q = supabase
        .from('staled_check_reports')
        .select('id', { count: 'exact', head: true })
        .not('submitted_at', 'is', null)
        .is('decided_at', null)
      if (!isAllBranches && pickupBranch) q = q.contains('branches', [pickupBranch])

      const { count, error } = await q
      if (!isMountedRef.current) return
      setPendingDecisionCount(error ? null : count ?? 0)
    } catch (err) {
      console.error('Failed to load pending decision count:', err)
      if (isMountedRef.current) setPendingDecisionCount(null)
    }
  }, [hasUsableScope, isAllBranches, pickupBranch])

  useEffect(() => {
    loadPendingDecisionCount()
    const interval = setInterval(loadPendingDecisionCount, 20000)
    return () => clearInterval(interval)
  }, [loadPendingDecisionCount])

  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS)
  const debouncedAmountMin = useDebouncedValue(amountMin, DEBOUNCE_MS)
  const debouncedAmountMax = useDebouncedValue(amountMax, DEBOUNCE_MS)

  const effectiveFilters = useMemo(
    () => ({
      query: debouncedQuery, status, dateFrom, dateTo, uploadedFrom, uploadedTo,
      amountMin: debouncedAmountMin, amountMax: debouncedAmountMax,
      fileFilter, collectorFilter, bankFilter, branchFilter, sortKey, sortAsc, pageSize,
    }),
    [debouncedQuery, status, dateFrom, dateTo, uploadedFrom, uploadedTo, debouncedAmountMin,
     debouncedAmountMax, fileFilter, collectorFilter, bankFilter, branchFilter, sortKey, sortAsc, pageSize],
  )

  useEffect(() => {
    setPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFilters])

  // applyCommonFilters — branch scope is enforced unconditionally here.
  // `branchFilter` (the dropdown) only narrows further for isAllBranches
  // profiles; for everyone else pickupBranch always wins regardless of
  // what branchFilter happens to hold.
  const applyCommonFilters = useCallback(
    (req) => {
      let r = req
      if (debouncedQuery.trim()) {
        const s = debouncedQuery.trim().toLowerCase()
        r = r.or(`payee.ilike.%${s}%,payor.ilike.%${s}%,check_no.ilike.%${s}%`)
      }
      if (dateFrom) r = r.gte('check_date', dateFrom)
      if (dateTo) r = r.lte('check_date', dateTo)
      if (uploadedFrom) r = r.gte('upload_batches.uploaded_at', `${uploadedFrom}T00:00:00`)
      if (uploadedTo) r = r.lte('upload_batches.uploaded_at', `${uploadedTo}T23:59:59`)
      if (debouncedAmountMin) r = r.gte('amount', Number(debouncedAmountMin))
      if (debouncedAmountMax) r = r.lte('amount', Number(debouncedAmountMax))
      if (fileFilter) r = r.eq('upload_batch_id', fileFilter)
      if (bankFilter) r = r.eq('bank', bankFilter)

      if (isAllBranches) {
        if (branchFilter) r = r.eq('pickup_branch', branchFilter)
      } else if (pickupBranch) {
        r = r.eq('pickup_branch', pickupBranch)
      }

      if (collectorFilter) {
        const normalized = normalizeCollectorName(collectorFilter)
        r = r.or(`picked_up_by.ilike.${normalized},collector_name.ilike.${normalized}`)
      }
      return r
    },
    [debouncedQuery, dateFrom, dateTo, uploadedFrom, uploadedTo, debouncedAmountMin,
     debouncedAmountMax, fileFilter, bankFilter, branchFilter, collectorFilter, isAllBranches, pickupBranch],
  )

  const load = useCallback(
    async (pageIndex) => {
      if (!hasUsableScope) return
      const requestId = ++requestIdRef.current
      setLoading(true)
      setLoadError('')

      try {
        const hasUploadDateFilter = !!(uploadedFrom || uploadedTo)
        const uploadBatchesSelect = hasUploadDateFilter
          ? 'upload_batches!inner(file_name, uploaded_at)'
          : 'upload_batches(file_name, uploaded_at)'

        let req = supabase
          .from('checks')
          .select(
            `id, row_number, bank, pickup_branch, payee, payor, check_no, check_date, amount, status, picked_up_by, picked_up_at, or_no, ar_collected, attached_2307, remarks, collector_name, submitted_by_name, submitted_at, return_reason, returned_at, returned_by_name, ${uploadBatchesSelect}`,
            { count: 'exact' },
          )
          .range(pageIndex * pageSize, pageIndex * pageSize + pageSize - 1)

        req = applyCommonFilters(req)
        if (status !== 'all') req = req.eq('status', status)

        if (sortKey === 'uploaded_at') {
          req = req.order('uploaded_at', { ascending: sortAsc, foreignTable: 'upload_batches' })
        } else if (SORTABLE_COLUMNS.includes(sortKey)) {
          req = req.order(sortKey, { ascending: sortAsc })
        } else {
          req = req.order('created_at', { ascending: false })
        }

        const { data, count: total, error } = await req
        if (!isMountedRef.current || requestId !== requestIdRef.current) return

        if (error) {
          setLoadError(error.message || 'Failed to load checks. Please try again.')
          return
        }

        setRows(data || [])
        setCount(total || 0)
      } catch (err) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) return
        setLoadError(err?.message || 'Failed to load checks. Please try again.')
      } finally {
        if (isMountedRef.current && requestId === requestIdRef.current) setLoading(false)
      }
    },
    [hasUsableScope, status, sortKey, sortAsc, pageSize, applyCommonFilters, uploadedFrom, uploadedTo],
  )

  const loadStats = useCallback(async () => {
    if (!hasUsableScope) return
    try {
      const hasUploadDateFilter = !!(uploadedFrom || uploadedTo)
      const results = await Promise.all(
        STATUS_ORDER.map((s) => {
          let q = supabase
            .from('checks')
            .select(hasUploadDateFilter ? 'id, upload_batches!inner(uploaded_at)' : 'id', { count: 'exact', head: true })
          q = applyCommonFilters(q)
          return q.eq('status', s)
        }),
      )
      if (!isMountedRef.current) return
      const next = {}
      STATUS_ORDER.forEach((s, i) => { next[s] = results[i].error ? null : results[i].count ?? 0 })
      setStats(next)
    } catch (err) {
      console.error('Failed to load stats:', err)
      if (isMountedRef.current) setStats(Object.fromEntries(STATUS_ORDER.map((s) => [s, null])))
    }
  }, [hasUsableScope, applyCommonFilters, uploadedFrom, uploadedTo])

  useEffect(() => {
    if (activeTab !== 'register' || !hasUsableScope) return
    startTransition(() => {
      load(page)
      loadStats()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFilters, page, activeTab, hasUsableScope])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [rows])

  function toggleSort(key) {
    if (sortKey === key) {
      setSortAsc((a) => !a)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const hasAdvancedFilters = !!(
    dateFrom || dateTo || uploadedFrom || uploadedTo || amountMin || amountMax ||
    fileFilter || collectorFilter || bankFilter || (isAllBranches && branchFilter)
  )
  const hasAnyFilters = hasAdvancedFilters || !!query.trim() || status !== 'all'

  const activeChips = useMemo(() => {
    const chips = []
    if (status !== 'all') chips.push({ key: 'status', label: `Status: ${statusLabel(status)}`, clear: () => setField('status', 'all') })
    if (bankFilter) chips.push({ key: 'bank', label: `Bank: ${bankFilter}`, clear: () => setField('bankFilter', '') })
    if (isAllBranches && branchFilter) {
      chips.push({ key: 'branch', label: `Branch: ${branchFilter}`, clear: () => setField('branchFilter', '') })
    }
    if (dateFrom || dateTo) {
      chips.push({
        key: 'dates', label: `Check date: ${dateFrom || '…'} → ${dateTo || '…'}`,
        clear: () => { setField('dateFrom', ''); setField('dateTo', '') },
      })
    }
    if (uploadedFrom || uploadedTo) {
      chips.push({
        key: 'uploadDates', label: `Uploaded: ${uploadedFrom || '…'} → ${uploadedTo || '…'}`,
        clear: () => { setField('uploadedFrom', ''); setField('uploadedTo', '') },
      })
    }
    if (amountMin || amountMax) {
      chips.push({
        key: 'amount', label: `Amount: ${amountMin || '0'} - ${amountMax || '∞'}`,
        clear: () => { setField('amountMin', ''); setField('amountMax', '') },
      })
    }
    if (fileFilter) {
      const f = fileOptions.find((o) => String(o.id) === String(fileFilter))
      chips.push({ key: 'file', label: `File: ${f?.file_name || fileFilter}`, clear: () => setField('fileFilter', '') })
    }
    if (collectorFilter) chips.push({ key: 'collector', label: `Collector: ${collectorFilter}`, clear: () => setField('collectorFilter', '') })
    return chips
  }, [status, bankFilter, branchFilter, isAllBranches, dateFrom, dateTo, uploadedFrom, uploadedTo, amountMin, amountMax, fileFilter, collectorFilter, fileOptions, setField])

  const openSubmitModal = useCallback((targetRows) => {
    if (!targetRows || targetRows.length === 0) return
    setSubmitError('')
    setSubmitTargets(targetRows)
  }, [])

  function closeSubmitModal() {
    if (submitSubmitting) return
    setSubmitTargets(null)
    setSubmitError('')
  }

  async function confirmSubmitForApproval(collectorName, entries) {
    if (!submitTargets || submitSubmitting) return

    const trimmedName = normalizeCollectorName(collectorName)
    if (!trimmedName) {
      setSubmitError("Enter the collector's full name.")
      return
    }

    const included = submitTargets.filter((r) => entries[r.id]?.include)
    if (included.length === 0) {
      setSubmitError('Include at least one check to submit.')
      return
    }

    const seenOrNos = new Map()
    for (const r of included) {
      const entry = entries[r.id]
      const orNo = composeReceiptNo(entry)
      if (
        !orNo ||
        entry.collected === null || entry.collected === undefined ||
        entry.attached2307 === null || entry.attached2307 === undefined
      ) {
        setSubmitError('Select a receipt type, enter its number, and set AR-collected and 2307 Attached status for every check being submitted.')
        return
      }
      if (entry.collected === false && !entry.remarks?.trim()) {
        setSubmitError('Enter a reason for every check where AR was not collected.')
        return
      }
      const key = orNo.toLowerCase()
      if (seenOrNos.has(key)) {
        setSubmitError('Each check needs its own unique receipt type + number — duplicates were found.')
        return
      }
      seenOrNos.set(key, r.id)
    }

    const trimmedAdminName = (adminName || '').trim()
    if (!trimmedAdminName) {
      setSubmitError('Could not identify the signed-in admin. Please refresh and try again.')
      return
    }

    setSubmitSubmitting(true)
    setSubmitError('')

    try {
      const p_check_outcomes = included.map((r) => {
        const entry = entries[r.id]
        return {
          check_id: r.id,
          or_no: composeReceiptNo(entry),
          ar_collected: entry.collected,
          attached_2307: entry.attached2307,
          remarks: entry.collected === false ? entry.remarks.trim() : null,
        }
      })

      const { data: reservationId, error } = await supabase.rpc('admin_submit_checks_for_approval', {
        p_collector_name: trimmedName,
        p_admin_name: trimmedAdminName,
        p_check_outcomes,
      })

      if (!isMountedRef.current) return

      if (error || !reservationId) {
        setSubmitError(error?.message || 'Could not submit the selected checks. Please try again.')
        return
      }

      setSubmitTargets(null)
      setSelectedIds(new Set())
      push({
        variant: 'success',
        title: 'Submitted for approval',
        description: `${included.length} check${included.length === 1 ? '' : 's'} — ${trimmedName}`,
      })
      load(page)
      loadStats()
      loadFilterOptions()
    } catch (err) {
      if (!isMountedRef.current) return
      setSubmitError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      if (isMountedRef.current) setSubmitSubmitting(false)
    }
  }

  const cancelSubmissions = useCallback(
    async (ids, label) => {
      if (ids.length === 0) return
      setCancelingIds((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.add(id))
        return next
      })
      try {
        const { error } = await supabase
          .from('checks')
          .update({
            status: 'available',
            or_no: null,
            ar_collected: null,
            attached_2307: null,
            remarks: null,
            collector_name: null,
            submitted_by_name: null,
            submitted_at: null,
          })
          .in('id', ids)

        if (error) {
          push({ variant: 'error', title: 'Could not cancel submission', description: error.message })
          return
        }
        push({
          variant: 'info',
          title: 'Submission cancelled',
          description: label || `${ids.length} check${ids.length === 1 ? '' : 's'}`,
        })
        setSelectedIds(new Set())
        load(page)
        loadStats()
      } catch (err) {
        push({ variant: 'error', title: 'Could not cancel submission', description: err?.message || 'Please try again.' })
      } finally {
        setCancelingIds((prev) => {
          const next = new Set(prev)
          ids.forEach((id) => next.delete(id))
          return next
        })
      }
    },
    [push, load, loadStats, page],
  )

  const toggleRowSelected = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id))
  const someOnPageSelected = rows.some((r) => selectedIds.has(r.id))

  function toggleSelectPage() {
    setSelectedIds((prev) => {
      if (allOnPageSelected) return new Set()
      const next = new Set(prev)
      rows.forEach((r) => next.add(r.id))
      return next
    })
  }

  const selectedAvailable = rows.filter((r) => selectedIds.has(r.id) && r.status === 'available')
  const selectedPendingApproval = rows.filter((r) => selectedIds.has(r.id) && r.status === 'pending_approval')
  const cancelingSelected = selectedPendingApproval.some((r) => cancelingIds.has(r.id))

  const totalPages = Math.max(1, Math.ceil(count / pageSize))
  const rangeStart = count === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min(count, page * pageSize + pageSize)
  const cellPad = density === 'compact' ? 'px-2 py-1' : 'px-3 py-2'
  const showBusy = loading || isPending

  if (profileLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-ink-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading your profile…
      </div>
    )
  }

  if (!hasUsableScope) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-6 py-16 text-center">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <p className="text-sm font-semibold text-amber-800">No branch assigned to your account</p>
        <p className="max-w-sm text-xs text-amber-700">
          Ask an admin to set a branch on your profile before you can view the checks register.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-display text-2xl font-semibold text-ink-900">Checks register</h1>
            <BranchScopeBadge isAllBranches={isAllBranches} branch={pickupBranch} />
          </div>
          <p className="mt-1 text-sm text-ink-400">
            Search every uploaded check, sort any column, submit pickups for approval, and track every
            status a check can move through — including stale checks due for return to the bank.
          </p>
        </div>
        <div className="flex items-center gap-3 text-right">
          {activeTab === 'register' && !loadError && (
            <div className="text-[10px] text-ink-400">
              <p className="font-mono">{rangeStart}–{rangeEnd} of {count.toLocaleString()}</p>
            
            </div>
          )}
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-8">
        <KpiCard
          icon={Layers}
          label="Matching filters"
          value={activeTab === 'register' && !showBusy ? count : null}
          secondary={activeTab === 'register' && !showBusy ? (count === 0 ? 'No results' : `${rangeStart}–${rangeEnd} shown`) : 'Switch to Register'}
          accent="lightTeal"
        />
        {STATUS_ORDER.map((s) => (
          <KpiCard
            key={s}
            icon={STATUS_CONFIG[s].icon}
            label={STATUS_CONFIG[s].label}
            value={activeTab === 'register' && !showBusy ? stats[s] : null}
            secondary={STATUS_CONFIG[s].secondary}
            accent={STATUS_CONFIG[s].accent}
          />
        ))}
        <button onClick={() => setActiveTab('stale')} className="text-left">
          <KpiCard icon={CalendarClock} label="Nearing stale (≤7d)" value={staleKpis.warning} secondary="Tap to review" accent="amber" />
        </button>
        <button onClick={() => setActiveTab('stale')} className="text-left">
          <KpiCard icon={AlertTriangle} label="Already stale" value={staleKpis.stale} secondary="Tap to review" accent="red" />
        </button>
      </div>

     <div className="mb-4 flex items-center gap-1 border-b border-ink-100">
  <TabButton active={activeTab === 'register'} onClick={() => setActiveTab('register')} icon={ListChecks} label="Check Register" />
  <TabButton
    active={activeTab === 'stale'}
    onClick={() => setActiveTab('stale')}
    icon={AlertTriangle}
    label="Stale Watch"
    badgeCount={(staleKpis.stale || 0) + (staleKpis.warning || 0)}
  />
  <TabButton
    active={activeTab === 'approvals'}
    onClick={() => setActiveTab('approvals')}
    icon={Hourglass}
    label="Pending Approvals"
    badgeCount={pendingDecisionCount || 0}
  />
  <TabButton active={activeTab === 'history'} onClick={() => setActiveTab('history')} icon={ClipboardList} label="Report History" />
</div>

     {activeTab === 'stale' ? (
  <StaleWatchPanel onSubmitted={() => { loadStaleKpis(); loadPendingDecisionCount() }} branchScope={isAllBranches ? null : pickupBranch} />
) : activeTab === 'approvals' ? (
  <VerifierStaleApprovals />
) : activeTab === 'history' ? (
  <StaleReportHistory branchScope={isAllBranches ? null : pickupBranch} />
) : (
        <>
          <div className="mb-3 flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300" />
              <Input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setField('query', e.target.value)}
                placeholder="Search payee, payor, or check no... (press / to focus)"
                className="pl-10 pr-9"
              />
              {query && (
                <button
                  onClick={() => setField('query', '')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Select value={status} onChange={(e) => setField('status', e.target.value)} className="sm:w-48">
              <option value="all">All statuses</option>
              {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>)}
            </Select>
            <Select value={bankFilter} onChange={(e) => setField('bankFilter', e.target.value)} className="sm:w-44">
              <option value="">All banks</option>
              {bankOptions.map((b) => <option key={b} value={b}>{b}</option>)}
            </Select>

            {isAllBranches ? (
              <Select value={branchFilter} onChange={(e) => setField('branchFilter', e.target.value)} className="sm:w-44">
                <option value="">All branches</option>
                {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
              </Select>
            ) : (
              <div
                className="flex items-center gap-1.5 rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-xs font-medium text-ink-500 sm:w-44"
                title="Your account is scoped to this branch"
              >
                <Building2 className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                <span className="truncate">{pickupBranch}</span>
              </div>
            )}

            <Button
              variant={showAdvanced ? 'stamp' : 'outline'}
              onClick={() => setShowAdvanced((v) => !v)}
              className="relative shrink-0"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" /> Advanced
              {hasAdvancedFilters && !showAdvanced && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-ledger-amber" aria-hidden="true" />
              )}
            </Button>
          </div>

          {activeChips.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {activeChips.map((chip) => (
                <span
                  key={chip.key}
                  className="inline-flex items-center gap-1 rounded-full border border-ink-200 bg-ink-50 px-2.5 py-1 text-xs text-ink-600"
                >
                  {chip.label}
                  <button onClick={chip.clear} aria-label={`Remove ${chip.label} filter`} className="text-ink-400 hover:text-ink-700">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <button onClick={resetAllFilters} className="text-xs font-medium text-ledger-stamp hover:underline">
                Clear all
              </button>
            </div>
          )}

          {showAdvanced && (
            <div className="mb-4 grid gap-3 rounded-md border border-ink-100 bg-ink-50/40 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-500">Check date from</label>
                <Input type="date" value={dateFrom} onChange={(e) => setField('dateFrom', e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-500">Check date to</label>
                <Input type="date" value={dateTo} onChange={(e) => setField('dateTo', e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-500">Upload date from</label>
                <Input type="date" value={uploadedFrom} onChange={(e) => setField('uploadedFrom', e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-500">Upload date to</label>
                <Input type="date" value={uploadedTo} onChange={(e) => setField('uploadedTo', e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-500">Min amount</label>
                <Input type="number" inputMode="decimal" value={amountMin} onChange={(e) => setField('amountMin', e.target.value)} placeholder="0.00" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-500">Max amount</label>
                <Input type="number" inputMode="decimal" value={amountMax} onChange={(e) => setField('amountMax', e.target.value)} placeholder="0.00" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-500">Source file</label>
                <Select value={fileFilter} onChange={(e) => setField('fileFilter', e.target.value)}>
                  <option value="">All files</option>
                  {fileOptions.map((f) => <option key={f.id} value={f.id}>{f.file_name}</option>)}
                </Select>
              </div>
              <div>
                <CollectorNameInput
                  label="Collector (reserved, submitted, or picked up)"
                  value={collectorFilter}
                  onChange={(v) => setField('collectorFilter', v)}
                  options={collectorOptions}
                  placeholder="Anyone — start typing to filter"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-4">
                <Button variant="ghost" size="sm" onClick={clearAdvancedFilters} disabled={!hasAdvancedFilters}>
                  Clear advanced filters
                </Button>
              </div>
            </div>
          )}

          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {selectedIds.size > 0 ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-ledger-stamp/30 bg-ledger-stamp/5 px-3 py-1.5 text-xs">
                  <span className="font-medium text-ink-700">{selectedIds.size} selected</span>
                  <Button size="sm" variant="stamp" onClick={() => openSubmitModal(selectedAvailable)} disabled={selectedAvailable.length === 0}>
                    <Send className="h-3.5 w-3.5" /> Submit for approval ({selectedAvailable.length})
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      cancelSubmissions(
                        selectedPendingApproval.map((r) => r.id),
                        `${selectedPendingApproval.length} check${selectedPendingApproval.length === 1 ? '' : 's'}`,
                      )
                    }
                    disabled={selectedPendingApproval.length === 0 || cancelingSelected}
                  >
                    {cancelingSelected ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Cancel submission ({selectedPendingApproval.length})
                  </Button>
                  <button onClick={() => setSelectedIds(new Set())} className="text-ink-400 hover:text-ink-700" aria-label="Clear selection">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <span className="text-xs text-ink-300">Select rows to act on several checks at once.</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center overflow-hidden rounded-md border border-ink-200">
                <button
                  onClick={() => setDensity('comfortable')}
                  className={cn('flex items-center gap-1 px-2 py-1.5 text-xs', density === 'comfortable' ? 'bg-ink-100 text-ink-800' : 'text-ink-400 hover:text-ink-600')}
                  aria-label="Comfortable row height"
                >
                  <Maximize2 className="h-3 w-3" />
                </button>
                <button
                  onClick={() => setDensity('compact')}
                  className={cn('flex items-center gap-1 border-l border-ink-200 px-2 py-1.5 text-xs', density === 'compact' ? 'bg-ink-100 text-ink-800' : 'text-ink-400 hover:text-ink-600')}
                  aria-label="Compact row height"
                >
                  <Minimize2 className="h-3 w-3" />
                </button>
              </div>
              <Select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="w-auto">
                {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} / page</option>)}
              </Select>
            </div>
          </div>

          {loadError && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {loadError}
              </span>
              <button onClick={() => load(page)} className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100">
                Retry
              </button>
            </div>
          )}

          <div className="overflow-auto rounded-lg border border-ink-100 bg-white" style={{ maxHeight: 640 }}>
            <table className="w-full min-w-[1160px] text-left text-[11px]">
              <thead className="sticky top-0 z-10 bg-ink-50 text-[9px] uppercase tracking-wide text-ink-400">
                <tr>
                  <th className={cellPad}>
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      ref={(el) => el && (el.indeterminate = someOnPageSelected && !allOnPageSelected)}
                      onChange={toggleSelectPage}
                      disabled={rows.length === 0}
                      className="h-3.5 w-3.5 accent-ledger-stamp"
                      aria-label="Select all rows on this page"
                    />
                  </th>
                  <th className={cn(cellPad, 'font-medium')}>File / Row</th>
                  <SortableHeader label="Bank" sortKeyName="bank" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} cellPad={cellPad} />
                  <SortableHeader label="Branch" sortKeyName="pickup_branch" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} cellPad={cellPad} />
                  <SortableHeader label="Payee" sortKeyName="payee" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} cellPad={cellPad} />
                  <th className={cn(cellPad, 'font-medium')}>Payor</th>
                  <th className={cn(cellPad, 'font-medium')}>Check No.</th>
                  <SortableHeader label="Check Date" sortKeyName="check_date" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} cellPad={cellPad} />
                  <SortableHeader label="Amount" sortKeyName="amount" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} cellPad={cellPad} />
                  <SortableHeader label="Uploaded" sortKeyName="uploaded_at" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} cellPad={cellPad} />
                  <th className={cn(cellPad, 'font-medium')}>Status</th>
                  <th className={cn(cellPad, 'text-right font-medium')}>Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {loading ? (
                  <SkeletonRows count={Math.min(pageSize, 10)} cellPad={cellPad} />
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-14">
                      <div className="flex flex-col items-center text-center">
                        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-ink-200 text-ink-300">
                          <Inbox className="h-5 w-5" />
                        </span>
                        <p className="mt-3 text-sm font-medium text-ink-600">No checks match your filters</p>
                        <p className="mt-1 text-xs text-ink-300">Try widening your search or clearing a filter.</p>
                        {hasAnyFilters && (
                          <button onClick={resetAllFilters} className="mt-3 text-xs font-medium text-ledger-stamp hover:underline">
                            Clear all filters
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <CheckRow
                      key={row.id}
                      row={row}
                      cellPad={cellPad}
                      selected={selectedIds.has(row.id)}
                      onToggleSelected={toggleRowSelected}
                      canceling={cancelingIds.has(row.id)}
                      onSubmit={openSubmitModal}
                      onCancel={cancelSubmissions}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {!loading && totalPages > 1 && (
            <div className="mt-5 flex items-center justify-center gap-2 font-mono text-xs text-ink-400">
              <button disabled={page === 0} onClick={() => setPage(0)} className="rounded border border-ink-200 px-3 py-1.5 disabled:opacity-40">
                First
              </button>
              <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="rounded border border-ink-200 px-3 py-1.5 disabled:opacity-40">
                Prev
              </button>
              <span>Page {page + 1} of {totalPages}</span>
              <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} className="rounded border border-ink-200 px-3 py-1.5 disabled:opacity-40">
                Next
              </button>
              <button disabled={page + 1 >= totalPages} onClick={() => setPage(totalPages - 1)} className="rounded border border-ink-200 px-3 py-1.5 disabled:opacity-40">
                Last
              </button>
            </div>
          )}
        </>
      )}

      {submitTargets && (
        <SubmitApprovalModal
          rows={submitTargets}
          collectorOptions={collectorOptions}
          onCancel={closeSubmitModal}
          onConfirm={confirmSubmitForApproval}
          submitting={submitSubmitting}
          error={submitError}
        />
      )}
    </div>
  )
}

function BranchScopeBadge({ isAllBranches, branch }) {
  if (isAllBranches) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-[10px] font-semibold text-indigo-700">
        <Building2 className="h-3 w-3" /> All branches
      </span>
    )
  }
  if (!branch) return null
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ledger-stamp/10 px-2.5 py-0.5 text-[10px] font-semibold text-ledger-stampDark">
      <Building2 className="h-3 w-3" /> {branch}
    </span>
  )
}

function TabButton({ active, onClick, icon: Icon, label, badgeCount }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
        active ? 'border-ledger-stamp text-ledger-stamp' : 'border-transparent text-ink-400 hover:text-ink-700',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
      {!!badgeCount && (
        <span className="ml-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
          {badgeCount}
        </span>
      )}
    </button>
  )
}

const KpiCard = React.memo(function KpiCard({ icon: Icon, label, value, secondary, accent = 'teal' }) {
  const accents = {
    teal: { badge: 'bg-ledger-stamp/10 text-ledger-stampDark', ring: 'border-ledger-stamp/30' },
    lightTeal: { badge: 'bg-teal-50 text-teal-600', ring: 'border-teal-200' },
    sky: { badge: 'bg-sky-50 text-sky-600', ring: 'border-sky-200' },
    orange: { badge: 'bg-ledger-amber/10 text-ledger-amber', ring: 'border-ledger-amber/30' },
    amber: { badge: 'bg-amber-100 text-amber-700', ring: 'border-amber-200' },
    red: { badge: 'bg-red-100 text-red-700', ring: 'border-red-200' },
    ink: { badge: 'bg-ink-50 text-ink-700', ring: 'border-ink-100' },
  }
  const style = accents[accent] || accents.teal
  const isLoading = value === null || value === undefined

  return (
    <Card>
      <CardContent className="relative overflow-hidden p-3">
        <div className={cn('pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed', style.ring)} aria-hidden="true" />
        <div className="relative flex items-start gap-2.5">
          <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', style.badge)}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <div className="h-5 w-12 animate-pulse rounded bg-ink-100" />
            ) : (
              <p className="truncate font-display text-sm font-semibold text-ink-900">
                {typeof value === 'number' ? value.toLocaleString() : value}
              </p>
            )}
            <p className="truncate text-[10px] text-ink-400">{label}</p>
            {!isLoading && secondary && <p className="mt-0.5 truncate font-mono text-[9px] text-ink-500">{secondary}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  )
})

const SortableHeader = React.memo(function SortableHeader({ label, sortKeyName, currentKey, asc, onClick, cellPad }) {
  const isActive = currentKey === sortKeyName
  const Icon = isActive ? (asc ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th className={cn(cellPad, 'font-medium', isActive && 'bg-ledger-stamp/5')}>
      <button onClick={() => onClick(sortKeyName)} className={`flex items-center gap-1 hover:text-ink-700 ${isActive ? 'text-ledger-stamp' : ''}`}>
        {label}
        <Icon className="h-2.5 w-2.5" />
      </button>
    </th>
  )
})

function EntityBadge({ icon: Icon, value, colorClass, emptyLabel = 'Unknown' }) {
  if (!value) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-ink-200 px-2 py-0.5 text-[9px] font-medium text-ink-400">
        <Icon className="h-2.5 w-2.5" />
        {emptyLabel}
      </span>
    )
  }
  return (
    <span className={cn('inline-flex max-w-[140px] items-center gap-1 truncate rounded-full px-2 py-0.5 text-[9px] font-medium', colorClass)} title={value}>
      <Icon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{value}</span>
    </span>
  )
}

function CopyableCheckNo({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return <>—</>

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('Clipboard write failed:', err)
    }
  }

  return (
    <button onClick={handleCopy} className="group inline-flex items-center gap-1 hover:text-ink-900" title="Copy check number">
      {value}
      {copied ? <Check className="h-3 w-3 text-ledger-stamp" /> : <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />}
    </button>
  )
}

function ReservedBadge({ row }) {
  return (
    <span className="inline-flex flex-col items-start gap-0.5" title={`Reserved by ${row.collector_name || 'an unknown collector'} — not yet submitted for approval`}>
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[9px] font-medium text-sky-700">
        <Clock className="h-3 w-3" />
        Reserved
      </span>
      {row.collector_name && <span className="text-[9px] text-ink-400">by {row.collector_name}</span>}
    </span>
  )
}

function ReturnedBadge({ row }) {
  const title = [
    row.collector_name ? `Reserved by ${row.collector_name}` : null,
    row.return_reason ? `Return reason: ${row.return_reason}` : 'No return reason given',
    row.returned_by_name ? `Returned by ${row.returned_by_name}` : null,
    row.returned_at ? `Returned ${formatDateTime(row.returned_at)}` : null,
  ].filter(Boolean).join(' — ')

  return (
    <span className="inline-flex flex-col items-start gap-0.5" title={title}>
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-medium text-amber-700">
        <RotateCcw className="h-3 w-3" />
        Returned for correction
      </span>
      {row.collector_name && <span className="text-[9px] text-ink-400">reserved by {row.collector_name}</span>}
    </span>
  )
}

function PendingApprovalBadge({ row }) {
  const hasCollected = row.ar_collected !== null && row.ar_collected !== undefined
  const hasAttached = row.attached_2307 !== null && row.attached_2307 !== undefined

  const title = [
    row.collector_name ? `Collector: ${row.collector_name}` : null,
    row.submitted_by_name ? `Submitted by ${row.submitted_by_name}` : null,
    'Awaiting approver review',
  ].filter(Boolean).join(' — ')

  return (
    <span className="inline-flex flex-col items-start gap-0.5" title={title}>
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-medium text-amber-700">
        <Hourglass className="h-3 w-3" />
        Pending approval
      </span>
      {row.collector_name && <span className="text-[9px] text-ink-400">for {row.collector_name}</span>}
      <span className="mt-0.5 flex flex-wrap items-center gap-1">
        {row.or_no && <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[9px] text-ink-600">Receipt {row.or_no}</span>}
        {hasCollected && (
          <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-medium', row.ar_collected ? 'bg-teal-100 text-teal-700' : 'bg-orange-100 text-orange-700')}>
            AR {row.ar_collected ? 'collected' : 'not collected'}
          </span>
        )}
        {hasAttached && (
          <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-medium', row.attached_2307 ? 'bg-teal-100 text-teal-700' : 'bg-orange-100 text-orange-700')}>
            2307 {row.attached_2307 ? 'Attached' : 'Not attached'}
          </span>
        )}
      </span>
      {row.ar_collected === false && row.remarks && (
        <span className="max-w-[170px] truncate text-[9px] text-ink-400" title={row.remarks}>
          {row.remarks}
        </span>
      )}
    </span>
  )
}

const CheckRow = React.memo(function CheckRow({ row, cellPad, selected, onToggleSelected, canceling, onSubmit, onCancel }) {
  const bucket = row.status === 'available' ? getStaleBucket(row.check_date) : STALE_BUCKETS.NORMAL
  return (
    <tr className={cn('hover:bg-ink-50/40', selected && 'bg-ledger-stamp/5')}>
      <td className={cellPad}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelected(row.id)}
          className="h-3.5 w-3.5 accent-ledger-stamp"
          aria-label={`Select ${row.payee}`}
        />
      </td>
      <td className={cn(cellPad, 'font-mono text-[10px] text-ink-400')}>
        {row.upload_batches?.file_name || '—'}
        <br />
        Row {row.row_number}
      </td>
      <td className={cn(cellPad, 'max-w-[150px]')}>
        <EntityBadge icon={Landmark} value={row.bank} colorClass="bg-teal-50 text-teal-700" emptyLabel="Unknown" />
      </td>
      <td className={cn(cellPad, 'max-w-[150px]')}>
        <EntityBadge icon={Building2} value={row.pickup_branch} colorClass="bg-indigo-50 text-indigo-700" emptyLabel="No branch" />
      </td>
      <td className={cn(cellPad, 'max-w-[180px] truncate font-medium text-ink-800')} title={row.payee || undefined}>
        {row.payee || '—'}
      </td>
      <td className={cn(cellPad, 'max-w-[140px] truncate text-ink-600')}>{row.payor || '—'}</td>
      <td className={cn(cellPad, 'font-mono text-ink-600')}>
        <CopyableCheckNo value={row.check_no} />
      </td>
      <td className={cn(cellPad, 'text-ink-600', bucket === STALE_BUCKETS.STALE && 'bg-red-50 font-medium text-red-700', bucket === STALE_BUCKETS.WARNING && 'bg-amber-50 font-medium text-amber-700')}>
        {row.check_date ? formatDate(row.check_date) : '—'}
      </td>
      <td className={cn(cellPad, 'font-mono text-ink-800')}>{formatCurrency(row.amount)}</td>
      <td className={cn(cellPad, 'text-[10px] text-ink-500')}>
        {row.upload_batches?.uploaded_at ? formatDate(row.upload_batches.uploaded_at) : '—'}
      </td>
      <td className={cn(cellPad, 'max-w-[190px]')}>
        {row.status === 'available' ? (
          <Badge variant="available">Available</Badge>
        ) : row.status === 'reserved' ? (
          <ReservedBadge row={row} />
        ) : row.status === 'pending_approval' ? (
          <PendingApprovalBadge row={row} />
        ) : row.status === 'returned' ? (
          <ReturnedBadge row={row} />
        ) : (
          <Badge variant="pickedup">Picked up by {row.picked_up_by || 'unknown'}</Badge>
        )}
      </td>
      <td className={cn(cellPad, 'text-right')}>
        {row.status === 'available' ? (
          <Button size="sm" variant="stamp" onClick={() => onSubmit([row])}>
            <Send className="h-3 w-3" /> Submit for approval
          </Button>
        ) : row.status === 'pending_approval' ? (
          <Button size="sm" variant="ghost" onClick={() => onCancel([row.id], row.payee)} disabled={canceling}>
            {canceling ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            {canceling ? 'Cancelling…' : 'Cancel submission'}
          </Button>
        ) : row.status === 'reserved' || row.status === 'returned' ? (
          <span className="text-[9px] italic text-ink-300">Manage in Pending Pickups</span>
        ) : (
          <span className="text-[9px] text-ink-300">Completed</span>
        )}
      </td>
    </tr>
  )
})

function buildInitialSubmitEntries(rowsList) {
  const initial = {}
  rowsList.forEach((r) => {
    initial[r.id] = { include: true, receiptType: '', receiptNo: '', collected: null, attached2307: null, remarks: '' }
  })
  return initial
}

function SubmitApprovalModal({ rows, collectorOptions, onCancel, onConfirm, submitting, error }) {
  const [collectorName, setCollectorName] = useState('')
  const [entries, setEntries] = useState(() => buildInitialSubmitEntries(rows))
  const dialogRef = useRef(null)
  const cancelButtonRef = useRef(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && !submitting) {
        onCancel()
        return
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
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
  }, [submitting, onCancel])

  const updateInclude = useCallback((id, value) => {
    setEntries((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        include: value,
        receiptType: value ? prev[id]?.receiptType || '' : '',
        receiptNo: value ? prev[id]?.receiptNo || '' : '',
        collected: value ? prev[id]?.collected ?? null : null,
        attached2307: value ? prev[id]?.attached2307 ?? null : null,
        remarks: value ? prev[id]?.remarks || '' : '',
      },
    }))
  }, [])

  const updateReceiptType = useCallback((id, value) => {
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], receiptType: value, receiptNo: '' } }))
  }, [])

  const updateReceiptNo = useCallback((id, value) => {
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], receiptNo: value } }))
  }, [])

  const updateCollected = useCallback((id, value) => {
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], collected: value, remarks: value === true ? '' : prev[id]?.remarks || '' } }))
  }, [])

  const updateAttached2307 = useCallback((id, value) => {
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], attached2307: value } }))
  }, [])

  const updateRemarks = useCallback((id, value) => {
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], remarks: value } }))
  }, [])

  const trimmedName = collectorName.trim()
  const nameEntered = trimmedName.length > 0

  const { completedCount, duplicateOrNos, includeCount } = useMemo(() => {
    const seenCounts = {}
    let completed = 0
    let included = 0
    rows.forEach((r) => {
      const entry = entries[r.id]
      if (!entry?.include) return
      included += 1
      const receiptNo = composeReceiptNo(entry)
      const reasonOk = entry.collected !== false || !!entry.remarks?.trim()
      const hasCollected = entry.collected !== null && entry.collected !== undefined
      const hasAttached = entry.attached2307 !== null && entry.attached2307 !== undefined
      if (receiptNo && hasCollected && hasAttached && reasonOk) completed += 1
      if (receiptNo) {
        const key = receiptNo.toLowerCase()
        seenCounts[key] = (seenCounts[key] || 0) + 1
      }
    })
    const duplicates = new Set(Object.entries(seenCounts).filter(([, c]) => c > 1).map(([k]) => k))
    return { completedCount: completed, duplicateOrNos: duplicates, includeCount: included }
  }, [entries, rows])

  const hasDuplicates = duplicateOrNos.size > 0
  const allComplete = includeCount > 0 && completedCount === includeCount && !hasDuplicates
  const canSubmit = nameEntered && allComplete && !submitting
  const totalAmount = useMemo(
    () => rows.reduce((sum, r) => (entries[r.id]?.include ? sum + (Number(r.amount) || 0) : sum), 0),
    [rows, entries],
  )

  function handleConfirm() {
    if (!canSubmit) return
    onConfirm(collectorName, entries)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/50 p-4 sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onCancel() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="submit-approval-title" className="relative flex max-h-[65vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-100 px-7 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ledger-stamp/10 text-ledger-stamp">
              <Send className="h-5 w-5" />
            </div>
            <div>
              <h2 id="submit-approval-title" className="text-lg font-semibold text-ink-900">Submit for approval</h2>
              <p className="mt-0.5 text-sm text-ink-400">
                {rows.length === 1
                  ? '1 check will be sent to an approver for review before it can be marked picked up.'
                  : `${rows.length} checks will be sent to an approver for review before they can be marked picked up.`}
              </p>
            </div>
          </div>
          <button onClick={onCancel} disabled={submitting} className="shrink-0 rounded-full p-1.5 text-ink-300 hover:bg-ink-50 hover:text-ink-600 disabled:opacity-40" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-ink-50/40 px-7 py-6">
          <div className="rounded-xl border border-ink-100 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex-1">
                <CollectorNameInput id="collector-name-input" autoFocus value={collectorName} onChange={setCollectorName} options={collectorOptions} placeholder="Full name of the person picking up" />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <SummaryPill label="checks to submit" value={includeCount} tone="neutral" />
                <SummaryPill label="details entered" value={`${completedCount}/${includeCount || 0}`} tone={allComplete ? 'positive' : 'warning'} />
                <SummaryPill label="total amount" value={formatCurrency(totalAmount)} tone="neutral" mono />
              </div>
            </div>
          </div>

          {nameEntered && (
            <div className="mt-5">
              <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <ClipboardList className="h-3.5 w-3.5" />
                Per-check details
              </div>

              <div className="flex flex-col gap-3">
                {rows.map((r, idx) => {
                  const entry = entries[r.id] || { include: true, receiptType: '', receiptNo: '', collected: null, attached2307: null, remarks: '' }
                  const composedReceipt = composeReceiptNo(entry)
                  const isDuplicate = entry.include && composedReceipt && duplicateOrNos.has(composedReceipt.toLowerCase())
                  const needsReason = entry.include && entry.collected === false
                  const missingReason = needsReason && !entry.remarks?.trim()
                  const rowIncomplete = entry.include && (!composedReceipt || entry.collected === null || entry.collected === undefined || entry.attached2307 === null || entry.attached2307 === undefined || missingReason)
                  const rowComplete = entry.include && !rowIncomplete && !isDuplicate

                  return (
                    <div
                      key={r.id}
                      className={cn(
                        'rounded-xl border bg-white shadow-sm transition-colors',
                        !entry.include && 'border-ink-100 opacity-60',
                        entry.include && isDuplicate && 'border-red-300 ring-1 ring-red-100',
                        entry.include && !isDuplicate && rowIncomplete && 'border-amber-200',
                        rowComplete && 'border-ledger-stamp/40',
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => updateInclude(r.id, !entry.include)}
                            aria-pressed={entry.include}
                            aria-label={entry.include ? `Exclude check ${r.check_no || idx + 1}` : `Include check ${r.check_no || idx + 1}`}
                            className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition', entry.include ? 'text-ledger-stamp hover:bg-ledger-stamp/5' : 'text-ink-300 hover:bg-ink-50 hover:text-ink-500')}
                          >
                            {entry.include ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                            {entry.include ? 'Included' : 'Excluded'}
                          </button>
                          <div className="h-6 w-px bg-ink-100" />
                          <div>
                            <p className="text-sm font-semibold text-ink-900">{r.payee || '—'}</p>
                            <p className="font-mono text-[11px] text-ink-400">
                              Check {r.check_no || '—'}
                              {r.payor ? ` · from ${r.payor}` : ''}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-semibold text-ink-800">{formatCurrency(r.amount)}</span>
                          {entry.include && (
                            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', isDuplicate ? 'bg-red-100 text-red-700' : rowComplete ? 'bg-ledger-stamp/10 text-ledger-stamp' : 'bg-amber-100 text-amber-700')}>
                              {isDuplicate ? (<><AlertTriangle className="h-3 w-3" /> Duplicate receipt</>) : rowComplete ? (<><Check className="h-3 w-3" /> Complete</>) : (<><AlertTriangle className="h-3 w-3" /> Incomplete</>)}
                            </span>
                          )}
                        </div>
                      </div>

                      {entry.include && (
                        <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
                          <div>
                            <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                              <ReceiptText className="h-3 w-3" />
                              Receipt
                            </label>
                            <div className="flex gap-1.5">
                              <select
                                value={entry.receiptType}
                                onChange={(e) => updateReceiptType(r.id, e.target.value)}
                                aria-label={`Receipt type for check ${r.check_no || idx + 1}`}
                                className="w-20 rounded-md border border-ink-200 px-2 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-ledger-stamp/40"
                              >
                                <option value="">Type</option>
                                {RECEIPT_TYPES.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
                              </select>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={entry.receiptNo}
                                onChange={(e) => updateReceiptNo(r.id, e.target.value)}
                                onBlur={(e) => updateReceiptNo(r.id, e.target.value.trim())}
                                placeholder="Number"
                                maxLength={40}
                                disabled={!entry.receiptType}
                                aria-label={`Receipt number for check ${r.check_no || idx + 1}`}
                                className={cn('min-w-0 flex-1 rounded-md border px-2 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-ledger-stamp/40 disabled:bg-ink-50 disabled:text-ink-300', isDuplicate ? 'border-red-400' : 'border-ink-200')}
                              />
                            </div>
                            {isDuplicate && <p className="mt-1 text-[10px] font-medium text-red-600">Already used above</p>}
                          </div>

                          <div>
                            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-400">AR collected</label>
                            <div className="flex gap-1.5" role="group" aria-label={`AR collected for check ${r.check_no || idx + 1}`}>
                              <YesNoButton active={entry.collected === true} onClick={() => updateCollected(r.id, true)} label="Yes" tone="positive" />
                              <YesNoButton active={entry.collected === false} onClick={() => updateCollected(r.id, false)} label="No" tone="neutral" />
                            </div>
                          </div>

                          <div>
                            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-400">2307 Attached</label>
                            <div className="flex gap-1.5" role="group" aria-label={`2307 Attached for check ${r.check_no || idx + 1}`}>
                              <YesNoButton active={entry.attached2307 === true} onClick={() => updateAttached2307(r.id, true)} label="Yes" tone="positive" />
                              <YesNoButton active={entry.attached2307 === false} onClick={() => updateAttached2307(r.id, false)} label="No" tone="neutral" />
                            </div>
                          </div>

                          <div>
                            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                              Remarks {needsReason && <span className="text-orange-500">(required)</span>}
                            </label>
                            {needsReason ? (
                              <input
                                type="text"
                                value={entry.remarks}
                                onChange={(e) => updateRemarks(r.id, e.target.value)}
                                placeholder="Why wasn't AR collected?"
                                maxLength={200}
                                aria-label={`Remarks for check ${r.check_no || idx + 1}`}
                                className={cn('w-full rounded-md border px-2 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-ledger-stamp/40', missingReason ? 'border-orange-400' : 'border-ink-200')}
                              />
                            ) : (
                              <p className="flex h-[34px] items-center text-xs text-ink-300">Not needed</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {!allComplete && (
                <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-700">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {includeCount === 0
                    ? 'Include at least one check to submit.'
                    : hasDuplicates
                    ? 'Each check needs its own unique receipt type + number.'
                    : "Every included check needs a receipt type & number, AR-collected status, and 2307 Attached status (plus a reason if AR wasn't collected)."}
                </p>
              )}
            </div>
          )}

          {!nameEntered && (
            <div className="mt-5 flex items-center gap-2 rounded-lg border border-dashed border-ink-200 bg-white px-4 py-3 text-xs text-ink-400">
              <UserRound className="h-4 w-4 shrink-0" />
              Enter the collector's name above to fill in per-check details.
            </div>
          )}

          {error && (
            <p className="mt-4 flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-ink-100 bg-white px-7 py-4">
          <p className="hidden text-xs text-ink-400 sm:block">
            {nameEntered ? `${completedCount} of ${includeCount || 0} checks ready · ${formatCurrency(totalAmount)} total` : 'Collector name required to continue'}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button ref={cancelButtonRef} onClick={onCancel} disabled={submitting} className="rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!canSubmit}
              title={!canSubmit && nameEntered ? 'Every included check needs complete details before submitting' : undefined}
              className="flex items-center gap-2 rounded-md bg-ledger-stamp px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? 'Submitting…' : includeCount > 1 ? `Submit ${includeCount} for approval` : 'Submit for approval'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SummaryPill({ label, value, tone = 'neutral', mono = false }) {
  const tones = { neutral: 'bg-ink-50 text-ink-700', positive: 'bg-ledger-stamp/10 text-ledger-stamp', warning: 'bg-amber-100 text-amber-700' }
  return (
    <div className={cn('rounded-lg px-3 py-2 text-right', tones[tone] || tones.neutral)}>
      <p className={cn('text-sm font-semibold leading-tight', mono && 'font-mono')}>{value}</p>
      <p className="text-[9px] uppercase tracking-wide opacity-70">{label}</p>
    </div>
  )
}

function YesNoButton({ active, onClick, label, tone }) {
  const activeClass = tone === 'positive' ? 'border-ledger-stamp bg-ledger-stamp text-white' : 'border-ink-700 bg-ink-700 text-white'
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cn('flex-1 rounded-md border px-2 py-2 text-xs font-medium transition', active ? activeClass : 'border-ink-200 text-ink-500 hover:bg-ink-50')}>
      {label}
    </button>
  )
}

function SkeletonRows({ count, cellPad }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: 12 }).map((__, j) => (
            <td key={j} className={cellPad}>
              <div className="h-3 w-full max-w-[7rem] animate-pulse rounded bg-ink-100" />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}