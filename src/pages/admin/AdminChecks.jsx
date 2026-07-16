import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

const PAGE_SIZE_OPTIONS = [25, 50, 100]
const SORTABLE_COLUMNS = ['payee', 'check_date', 'amount', 'uploaded_at']
const DEBOUNCE_MS = 300

export default function AdminChecks() {
  const { name: adminName } = useProfile()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')
  const [fileFilter, setFileFilter] = useState('')
  const [collectorFilter, setCollectorFilter] = useState('')

  const [fileOptions, setFileOptions] = useState([])
  const [collectorOptions, setCollectorOptions] = useState([])

  const [sortKey, setSortKey] = useState('created_at')
  const [sortAsc, setSortAsc] = useState(false)

  const [pageSize, setPageSize] = useState(25)
  const [density, setDensity] = useState('comfortable') // 'comfortable' | 'compact'

  const [rows, setRows] = useState([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Lightweight status breakdown for the current filters (head-only counts,
  // so this stays cheap no matter how large the underlying table gets).
  // Also powers the KPI cards at the top of the page.
  const [stats, setStats] = useState({ available: null, pendingApproval: null, pickedUp: null })

  // Submit-for-approval modal. `submitTargets` is null when the modal is
  // closed, or the array of check rows it's acting on (one row for a
  // single-check submission, several for a bulk one) when it's open. The
  // modal itself owns the collector-name and per-check field state; this
  // component only owns the network call and its in-flight/error state so
  // both the single-row and bulk entry points can share one code path.
  const [submitTargets, setSubmitTargets] = useState(null)
  const [submitSubmitting, setSubmitSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  // Cancelling a pending submission (back to 'available') and undoing a
  // finalized pickup (also back to 'available') are both simple, uniform
  // updates, so a single row id or many share the same in-flight tracking
  // set and the same bulk-capable function.
  const [cancelingIds, setCancelingIds] = useState(() => new Set())
  const [undoingIds, setUndoingIds] = useState(() => new Set())

  const [selectedIds, setSelectedIds] = useState(() => new Set())

  const { push } = useToast()

  const isMountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const searchInputRef = useRef(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Focus the search box with "/" from anywhere on the page, unless the
  // user is already typing in a field.
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

  useEffect(() => {
    loadFilterOptions()
  }, [])

  async function loadFilterOptions() {
    try {
      const [batchesRes, collectorsRes] = await Promise.all([
        supabase.from('upload_batches').select('id, file_name').order('uploaded_at', { ascending: false }).limit(200),
        // Collector suggestions pool together everyone who has ever
        // finished a pickup (picked_up_by) and everyone currently waiting
        // on approval (submitted_by_name), so the dropdown covers both.
       supabase
  .from('checks')
  .select('picked_up_by, collector_name')
  .or('picked_up_by.not.is.null,collector_name.not.is.null')
  .limit(1000),
      ])
      if (!batchesRes.error) setFileOptions(batchesRes.data || [])
      if (!collectorsRes.error) {
        const distinct = [
          ...new Set(
            (collectorsRes.data || [])
              .flatMap((r) => [r.picked_up_by, r.collector_name])
              .filter(Boolean),
          ),
        ].sort()
        setCollectorOptions(distinct)
      }
    } catch {
      // Filter suggestions are a convenience only — ignore failures here.
    }
  }

  const filters = useMemo(
    () => ({
      query,
      status,
      dateFrom,
      dateTo,
      amountMin,
      amountMax,
      fileFilter,
      collectorFilter,
      sortKey,
      sortAsc,
      pageSize,
    }),
    [query, status, dateFrom, dateTo, amountMin, amountMax, fileFilter, collectorFilter, sortKey, sortAsc, pageSize],
  )

  // Any real filter change (not a page change) always jumps back to page 0,
  // so results never show "page 3 of 1".
  useEffect(() => {
    setPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  // Single debounced fetch driven by filters + page together. Using one
  // effect (rather than a separate filters-effect and page-effect that each
  // called load) avoids firing two overlapping requests on mount / on every
  // filter change, which could previously race and show stale results.
  useEffect(() => {
    const t = setTimeout(() => {
      load(page)
      loadStats()
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page])

  // Selection only ever refers to the currently loaded page, so it's
  // cleared whenever that page's data changes underneath it.
  useEffect(() => {
    setSelectedIds(new Set())
  }, [rows])

  // Applies every filter except status and pagination/sort — shared between
  // the main list query and the lightweight status-count queries so the two
  // can never drift apart.
  const applyCommonFilters = useCallback(
    (req) => {
      let r = req
      if (query.trim()) {
        const s = query.trim().toLowerCase()
        r = r.or(`payee.ilike.%${s}%,payor.ilike.%${s}%,check_no.ilike.%${s}%`)
      }
      if (dateFrom) r = r.gte('check_date', dateFrom)
      if (dateTo) r = r.lte('check_date', dateTo)
      if (amountMin) r = r.gte('amount', Number(amountMin))
      if (amountMax) r = r.lte('amount', Number(amountMax))
      if (fileFilter) r = r.eq('upload_batch_id', fileFilter)
      // A collector can show up as either the person who submitted a check
      // for approval or the person it was ultimately logged as picked up
      // by, so match either column. This is a second, independent `.or()`
      // call — supabase-js ANDs separate `.or()` groups together, so this
      // combines correctly with the search clause above rather than
      // replacing it.
   if (collectorFilter) {
  r = r.or(`picked_up_by.eq.${collectorFilter},collector_name.eq.${collectorFilter}`)
}
      return r
    },
    [query, dateFrom, dateTo, amountMin, amountMax, fileFilter, collectorFilter],
  )

  const load = useCallback(
    async (pageIndex) => {
      const requestId = ++requestIdRef.current
      setLoading(true)
      setLoadError('')

      try {
        let req = supabase
          .from('checks')
         .select(
  'id, row_number, payee, payor, check_no, check_date, amount, status, picked_up_by, picked_up_at, or_no, ar_collected, remarks, collector_name, submitted_by_name, submitted_at, upload_batches(file_name, uploaded_at)',
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

        // Drop stale responses — a faster later request may have already
        // resolved (e.g. rapid filter typing outrunning the network).
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
        if (isMountedRef.current && requestId === requestIdRef.current) {
          setLoading(false)
        }
      }
    },
    [status, sortKey, sortAsc, pageSize, applyCommonFilters],
  )

  // Head-only counts (no rows fetched) so the available / pending / picked-up
  // split stays cheap regardless of table size, and reflects every filter
  // except status itself so the split is always meaningful. This also
  // feeds the KPI cards at the top of the page.
  const loadStats = useCallback(async () => {
    try {
      const [availableRes, pendingRes, pickedUpRes] = await Promise.all([
        applyCommonFilters(supabase.from('checks').select('id', { count: 'exact', head: true })).eq(
          'status',
          'available',
        ),
        applyCommonFilters(supabase.from('checks').select('id', { count: 'exact', head: true })).eq(
          'status',
          'pending_approval',
        ),
        applyCommonFilters(supabase.from('checks').select('id', { count: 'exact', head: true })).eq(
          'status',
          'picked_up',
        ),
      ])
      if (!isMountedRef.current) return
      setStats({
        available: availableRes.error ? null : availableRes.count ?? 0,
        pendingApproval: pendingRes.error ? null : pendingRes.count ?? 0,
        pickedUp: pickedUpRes.error ? null : pickedUpRes.count ?? 0,
      })
    } catch {
      if (isMountedRef.current) setStats({ available: null, pendingApproval: null, pickedUp: null })
    }
  }, [applyCommonFilters])

  function toggleSort(key) {
    if (sortKey === key) {
      setSortAsc((a) => !a)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  function clearAdvancedFilters() {
    setDateFrom('')
    setDateTo('')
    setAmountMin('')
    setAmountMax('')
    setFileFilter('')
    setCollectorFilter('')
  }

  function resetAllFilters() {
    setQuery('')
    setStatus('all')
    clearAdvancedFilters()
    setSortKey('created_at')
    setSortAsc(false)
  }

  const hasAdvancedFilters = !!(dateFrom || dateTo || amountMin || amountMax || fileFilter || collectorFilter)
  const hasAnyFilters = hasAdvancedFilters || !!query.trim() || status !== 'all'

  const statusLabel = (s) => (s === 'available' ? 'Available' : s === 'pending_approval' ? 'Pending approval' : 'Picked up')

  const activeChips = useMemo(() => {
    const chips = []
    if (status !== 'all') chips.push({ key: 'status', label: `Status: ${statusLabel(status)}`, clear: () => setStatus('all') })
    if (dateFrom || dateTo) chips.push({ key: 'dates', label: `Date: ${dateFrom || '…'} → ${dateTo || '…'}`, clear: () => { setDateFrom(''); setDateTo('') } })
    if (amountMin || amountMax) chips.push({ key: 'amount', label: `Amount: ${amountMin || '0'} - ${amountMax || '∞'}`, clear: () => { setAmountMin(''); setAmountMax('') } })
    if (fileFilter) {
      const f = fileOptions.find((o) => String(o.id) === String(fileFilter))
      chips.push({ key: 'file', label: `File: ${f?.file_name || fileFilter}`, clear: () => setFileFilter('') })
    }
    if (collectorFilter) chips.push({ key: 'collector', label: `Collector: ${collectorFilter}`, clear: () => setCollectorFilter('') })
    return chips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, dateFrom, dateTo, amountMin, amountMax, fileFilter, collectorFilter, fileOptions])

  // ---------------------------------------------------------------------
  // Submit for approval (available -> pending_approval)
  // ---------------------------------------------------------------------

  function openSubmitModal(targetRows) {
    if (!targetRows || targetRows.length === 0) return
    setSubmitError('')
    setSubmitTargets(targetRows)
  }

  function closeSubmitModal() {
    if (submitSubmitting) return
    setSubmitTargets(null)
    setSubmitError('')
  }

  // Called by the modal once the admin has entered a collector name and a
  // complete OR no. / AR-collected / remarks entry for every included
  // check. Re-validates everything server-side-of-the-UI before writing,
  // since the modal's own validation only gates its button — it doesn't
  // guarantee the data reaching this function is still valid.
async function confirmSubmitForApproval(collectorName, entries) {
    if (!submitTargets || submitSubmitting) return

    const trimmedName = collectorName.trim()
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
      const orNo = entry.orNo?.trim() ?? ''
      if (!orNo || entry.collected === null || entry.collected === undefined) {
        setSubmitError('Enter an OR number and AR-collected status for every check being submitted.')
        return
      }
      if (entry.collected === false && !entry.remarks?.trim()) {
        setSubmitError('Enter a reason for every check where AR was not collected.')
        return
      }
      const key = orNo.toLowerCase()
      if (seenOrNos.has(key)) {
        setSubmitError("Each check needs its own unique OR number — duplicates were found.")
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
      // Creating the pickup_reservations row and stamping checks with its
      // id has to happen through a SECURITY DEFINER RPC — the admin's own
      // role doesn't have RLS permission to INSERT into
      // pickup_reservations directly (that's what caused the 403). This
      // mirrors admin_submit_for_approval / approver_decide, which are
      // RPCs for the same reason.
      //
      // Pass a plain array/object, not JSON.stringify() — supabase-js
      // already serializes this for the jsonb param, and double-encoding
      // it makes Postgres receive a jsonb *string* instead of a jsonb
      // *array*.
      const p_check_outcomes = included.map((r) => {
        const entry = entries[r.id]
        return {
          check_id: r.id,
          or_no: entry.orNo.trim(),
          ar_collected: entry.collected,
          remarks: entry.collected === false ? entry.remarks.trim() : null,
        }
      })

      const { data: reservationId, error } = await supabase.rpc(
        'admin_submit_available_checks_for_approval',
        {
          p_collector_name: trimmedName,
          p_admin_name: trimmedAdminName,
          p_check_outcomes,
        },
      )

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
    } catch (err) {
      if (!isMountedRef.current) return
      setSubmitError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      if (isMountedRef.current) setSubmitSubmitting(false)
    }
  }

  // ---------------------------------------------------------------------
  // Cancel a pending submission (pending_approval -> available), and undo a
  // finalized pickup (picked_up -> available). Both are uniform updates
  // across however many ids are involved, so a single `.in('id', ids)`
  // call covers the single-row and bulk cases alike.
  // ---------------------------------------------------------------------

  async function cancelSubmissions(ids, label) {
    if (ids.length === 0) return
    setCancelingIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
    try {
      const { error } = await supabase
        .from('checks')
       .update({ status: 'available', or_no: null, ar_collected: null, remarks: null, collector_name: null, submitted_by_name: null, submitted_at: null })
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
  }

  async function undoPickups(ids, label) {
    if (ids.length === 0) return
    setUndoingIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
    try {
      const { error } = await supabase
        .from('checks')
        .update({ status: 'available', picked_up_by: null, picked_up_at: null })
        .in('id', ids)

      if (error) {
        push({ variant: 'error', title: 'Could not undo', description: error.message })
        return
      }
      push({
        variant: 'info',
        title: 'Reverted to available',
        description: label || `${ids.length} check${ids.length === 1 ? '' : 's'}`,
      })
      setSelectedIds(new Set())
      load(page)
      loadStats()
    } catch (err) {
      push({ variant: 'error', title: 'Could not undo', description: err?.message || 'Please try again.' })
    } finally {
      setUndoingIds((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.delete(id))
        return next
      })
    }
  }

  function toggleRowSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
  const selectedPickedUp = rows.filter((r) => selectedIds.has(r.id) && r.status === 'picked_up')
  const cancelingSelected = selectedPendingApproval.some((r) => cancelingIds.has(r.id))
  const undoingSelected = selectedPickedUp.some((r) => undoingIds.has(r.id))

  const totalPages = Math.max(1, Math.ceil(count / pageSize))
  const rangeStart = count === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min(count, page * pageSize + pageSize)
  const cellPad = density === 'compact' ? 'px-3 py-1.5' : 'px-4 py-3'

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-900">Checks register</h1>
          <p className="mt-1 text-sm text-ink-400">
            Search every uploaded check, sort any column, submit pickups for approval, and undo mistakes.
          </p>
        </div>
        <div className="flex items-center gap-3 text-right">
          {!loading && !loadError && (
            <div className="text-xs text-ink-400">
              <p className="font-mono">
                {rangeStart}–{rangeEnd} of {count.toLocaleString()}
              </p>
              <p className="mt-0.5 flex items-center gap-2 font-mono">
                <span className="text-ledger-stamp">{stats.available ?? '—'} available</span>
                <span className="text-ink-300">·</span>
                <span className="text-amber-600">{stats.pendingApproval ?? '—'} pending</span>
                <span className="text-ink-300">·</span>
                <span>{stats.pickedUp ?? '—'} picked up</span>
              </p>
            </div>
          )}
        </div>
      </div>

      {/* KPI summary row — mirrors the dashboard's KpiCard pattern so both
          pages feel consistent. Fed entirely by `stats` and `count`, which
          are already fetched by loadStats()/load() above, so this adds no
          extra network calls. Numbers update live as filters change since
          `stats` respects every active filter except status itself. */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          icon={Layers}
          label="Matching filters"
          value={loading ? null : count}
          secondary={loading ? null : count === 0 ? 'No results' : `${rangeStart}–${rangeEnd} shown`}
          accent="lightTeal"
        />
        <KpiCard
          icon={Wallet}
          label="Available"
          value={loading ? null : stats.available}
          secondary="Ready for pickup"
          accent="teal"
        />
        <KpiCard
          icon={Hourglass}
          label="Pending approval"
          value={loading ? null : stats.pendingApproval}
          secondary="Awaiting approver review"
          accent="orange"
        />
        <KpiCard
          icon={CircleCheckBig}
          label="Picked up"
          value={loading ? null : stats.pickedUp}
          secondary="Completed pickups"
          accent="teal"
        />
      </div>

      <div className="mb-3 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300" />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search payee, payor, or check no... (press / to focus)"
            className="pl-10 pr-9"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-48">
          <option value="all">All statuses</option>
          <option value="available">Available</option>
          <option value="pending_approval">Pending approval</option>
          <option value="picked_up">Picked up</option>
        </Select>
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
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Check date to</label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Min amount</label>
            <Input
              type="number"
              inputMode="decimal"
              value={amountMin}
              onChange={(e) => setAmountMin(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Max amount</label>
            <Input
              type="number"
              inputMode="decimal"
              value={amountMax}
              onChange={(e) => setAmountMax(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Source file</label>
            <Select value={fileFilter} onChange={(e) => setFileFilter(e.target.value)}>
              <option value="">All files</option>
              {fileOptions.map((f) => (
                <option key={f.id} value={f.id}>{f.file_name}</option>
              ))}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Collector (submitted or picked up)</label>
            <Select value={collectorFilter} onChange={(e) => setCollectorFilter(e.target.value)}>
              <option value="">Anyone</option>
              {collectorOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button variant="ghost" size="sm" onClick={clearAdvancedFilters} disabled={!hasAdvancedFilters}>
              Clear advanced filters
            </Button>
          </div>
        </div>
      )}

      {/* Table toolbar: page size + density, and bulk action bar when rows are selected */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-ledger-stamp/30 bg-ledger-stamp/5 px-3 py-1.5 text-xs">
              <span className="font-medium text-ink-700">{selectedIds.size} selected</span>
              <Button
                size="sm"
                variant="stamp"
                onClick={() => openSubmitModal(selectedAvailable)}
                disabled={selectedAvailable.length === 0}
              >
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  undoPickups(
                    selectedPickedUp.map((r) => r.id),
                    `${selectedPickedUp.length} check${selectedPickedUp.length === 1 ? '' : 's'}`,
                  )
                }
                disabled={selectedPickedUp.length === 0 || undoingSelected}
              >
                {undoingSelected ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Undo pickup ({selectedPickedUp.length})
              </Button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-ink-400 hover:text-ink-700"
                aria-label="Clear selection"
              >
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
              className={cn(
                'flex items-center gap-1 px-2 py-1.5 text-xs',
                density === 'comfortable' ? 'bg-ink-100 text-ink-800' : 'text-ink-400 hover:text-ink-600',
              )}
              aria-label="Comfortable row height"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
            <button
              onClick={() => setDensity('compact')}
              className={cn(
                'flex items-center gap-1 border-l border-ink-200 px-2 py-1.5 text-xs',
                density === 'compact' ? 'bg-ink-100 text-ink-800' : 'text-ink-400 hover:text-ink-600',
              )}
              aria-label="Compact row height"
            >
              <Minimize2 className="h-3 w-3" />
            </button>
          </div>
          <Select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="w-auto">
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>{size} / page</option>
            ))}
          </Select>
        </div>
      </div>

      {loadError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {loadError}
          </span>
          <button
            onClick={() => load(page)}
            className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      )}

      <div className="overflow-auto rounded-lg border border-ink-100 bg-white" style={{ maxHeight: 640 }}>
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-ink-50 text-xs uppercase tracking-wide text-ink-400">
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
                <td colSpan={10} className="px-4 py-14">
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
                <tr key={row.id} className={cn('hover:bg-ink-50/40', selectedIds.has(row.id) && 'bg-ledger-stamp/5')}>
                  <td className={cellPad}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.id)}
                      onChange={() => toggleRowSelected(row.id)}
                      className="h-3.5 w-3.5 accent-ledger-stamp"
                      aria-label={`Select ${row.payee}`}
                    />
                  </td>
                  <td className={cn(cellPad, 'font-mono text-xs text-ink-400')}>
                    {row.upload_batches?.file_name || '—'}
                    <br />
                    Row {row.row_number}
                  </td>
                  <td className={cn(cellPad, 'font-medium text-ink-800')}>{row.payee || '—'}</td>
                  <td className={cn(cellPad, 'text-ink-600')}>{row.payor || '—'}</td>
                  <td className={cn(cellPad, 'font-mono text-ink-600')}>
                    <CopyableCheckNo value={row.check_no} />
                  </td>
                  <td className={cn(cellPad, 'text-ink-600')}>
                    {row.check_date ? formatDate(row.check_date) : '—'}
                  </td>
                  <td className={cn(cellPad, 'font-mono text-ink-800')}>{formatCurrency(row.amount)}</td>
                  {/* ── Uploaded-date column ── shows when the source file was imported */}
                  <td className={cn(cellPad, 'text-ink-500')}>
                    {row.upload_batches?.uploaded_at ? formatDate(row.upload_batches.uploaded_at) : '—'}
                  </td>
                  <td className={cellPad}>
                    {row.status === 'available' ? (
                      <Badge variant="available">Available</Badge>
                    ) : row.status === 'pending_approval' ? (
                      <PendingApprovalBadge row={row} />
                    ) : (
                      <Badge variant="pickedup">Picked up by {row.picked_up_by || 'unknown'}</Badge>
                    )}
                  </td>
                  <td className={cn(cellPad, 'text-right')}>
                    {row.status === 'available' ? (
                      <Button size="sm" variant="stamp" onClick={() => openSubmitModal([row])}>
                        <Send className="h-3.5 w-3.5" /> Submit for approval
                      </Button>
                    ) : row.status === 'pending_approval' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => cancelSubmissions([row.id], row.payee)}
                        disabled={cancelingIds.has(row.id)}
                      >
                        {cancelingIds.has(row.id) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        {cancelingIds.has(row.id) ? 'Cancelling…' : 'Cancel submission'}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => undoPickups([row.id], row.payee)}
                        disabled={undoingIds.has(row.id)}
                      >
                        {undoingIds.has(row.id) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        {undoingIds.has(row.id) ? 'Undoing…' : 'Undo'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!loading && totalPages > 1 && (
        <div className="mt-5 flex items-center justify-center gap-2 font-mono text-xs text-ink-400">
          <button
            disabled={page === 0}
            onClick={() => setPage(0)}
            className="rounded border border-ink-200 px-3 py-1.5 disabled:opacity-40"
          >
            First
          </button>
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded border border-ink-200 px-3 py-1.5 disabled:opacity-40"
          >
            Prev
          </button>
          <span>
            Page {page + 1} of {totalPages}
          </span>
          <button
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="rounded border border-ink-200 px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
          <button
            disabled={page + 1 >= totalPages}
            onClick={() => setPage(totalPages - 1)}
            className="rounded border border-ink-200 px-3 py-1.5 disabled:opacity-40"
          >
            Last
          </button>
        </div>
      )}

      {submitTargets && (
        <SubmitApprovalModal
          rows={submitTargets}
          onCancel={closeSubmitModal}
          onConfirm={confirmSubmitForApproval}
          submitting={submitSubmitting}
          error={submitError}
        />
      )}
    </div>
  )
}

// Compact stat card reused from the admin dashboard's KPI pattern, so the
// register and the dashboard feel like one product. Color usage follows
// the brand palette: teal (`ledger-stamp`) for healthy/actionable states,
// light teal for the neutral aggregate total, and orange (`ledger-amber`)
// for anything sitting in a review queue — matching the semantics already
// used by <Badge> and <PendingApprovalBadge> elsewhere on this page.
function KpiCard({ icon: Icon, label, value, secondary, accent = 'teal', loading }) {
  const accents = {
    teal: { badge: 'bg-ledger-stamp/10 text-ledger-stampDark', ring: 'border-ledger-stamp/30' },
    lightTeal: { badge: 'bg-teal-50 text-teal-600', ring: 'border-teal-200' },
    orange: { badge: 'bg-ledger-amber/10 text-ledger-amber', ring: 'border-ledger-amber/30' },
    ink: { badge: 'bg-ink-50 text-ink-700', ring: 'border-ink-100' },
  }
  const style = accents[accent] || accents.teal
  const isLoading = loading || value === null || value === undefined

  return (
    <Card>
      <CardContent className="relative overflow-hidden p-4">
        <div
          className={cn(
            'pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed',
            style.ring,
          )}
          aria-hidden="true"
        />
        <div className="relative flex items-start gap-3">
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', style.badge)}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <div className="h-6 w-14 animate-pulse rounded bg-ink-100" />
            ) : (
              <p className="truncate font-display text-lg font-semibold text-ink-900">
                {typeof value === 'number' ? value.toLocaleString() : value}
              </p>
            )}
            <p className="truncate text-xs text-ink-400">{label}</p>
            {!isLoading && secondary && (
              <p className="mt-0.5 truncate font-mono text-xs text-ink-500">{secondary}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function SortableHeader({ label, sortKeyName, currentKey, asc, onClick, cellPad }) {
  const isActive = currentKey === sortKeyName
  const Icon = isActive ? (asc ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th className={cn(cellPad, 'font-medium', isActive && 'bg-ledger-stamp/5')}>
      <button
        onClick={() => onClick(sortKeyName)}
        className={`flex items-center gap-1 hover:text-ink-700 ${isActive ? 'text-ledger-stamp' : ''}`}
      >
        {label}
        <Icon className="h-3 w-3" />
      </button>
    </th>
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
    } catch {
      // Clipboard access can be blocked by the browser — fail silently,
      // the check number is still visible to copy manually.
    }
  }

  return (
    <button onClick={handleCopy} className="group inline-flex items-center gap-1 hover:text-ink-900" title="Copy check number">
      {value}
      {copied ? (
        <Check className="h-3 w-3 text-ledger-stamp" />
      ) : (
        <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />
      )}
    </button>
  )
}

// Compact badge for a check awaiting approver review. The full OR no. / AR
// collected / remarks trail is available on hover via the title attribute
// rather than as extra table columns, so the register stays scannable.
function PendingApprovalBadge({ row }) {
  const details = [
    row.or_no ? `OR #${row.or_no}` : null,
    row.ar_collected === null || row.ar_collected === undefined
      ? null
      : row.ar_collected
      ? 'AR collected'
      : `AR not collected${row.remarks ? ` — ${row.remarks}` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ')

 const title = [
  row.collector_name ? `Collector: ${row.collector_name}` : null,
  row.submitted_by_name ? `Submitted by ${row.submitted_by_name}` : null,
  details || null,
  'Awaiting approver review',
].filter(Boolean).join(' — ')

  return (
    <span className="inline-flex flex-col items-start gap-0.5" title={title}>
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        <Hourglass className="h-3 w-3" />
        Pending approval
      </span>
     {row.collector_name && <span className="text-[11px] text-ink-400">for {row.collector_name}</span>}
    </span>
  )
}

// Every check starts "included" (assumed being submitted) with an empty OR
// number and no AR-collected answer, so the admin's default action is to
// fill in details for everything selected — they only need to exclude rows
// they change their mind about.
function buildInitialSubmitEntries(rowsList) {
  const initial = {}
  rowsList.forEach((r) => {
    initial[r.id] = { include: true, orNo: '', collected: null, remarks: '' }
  })
  return initial
}

function SubmitApprovalModal({ rows, onCancel, onConfirm, submitting, error }) {
  const [collectorName, setCollectorName] = useState('')
  const [entries, setEntries] = useState(() => buildInitialSubmitEntries(rows))
  const dialogRef = useRef(null)
  const cancelButtonRef = useRef(null)
  const nameInputRef = useRef(null)

  // Focuses the collector-name field on open (it's always the first thing
  // to fill in) and restores focus to whatever was focused before the
  // modal opened once it closes. Deliberately an empty dependency array —
  // this must run once on mount only.
  useEffect(() => {
    const previouslyFocused = document.activeElement
    nameInputRef.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape-to-close and a light focus trap so keyboard users aren't
  // dropped out of the modal into the page behind it.
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && !submitting) {
        onCancel()
        return
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
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
        include: value,
        orNo: value ? prev[id]?.orNo || '' : '',
        collected: value ? prev[id]?.collected ?? null : null,
        remarks: value ? prev[id]?.remarks || '' : '',
      },
    }))
  }, [])

  const updateOrNo = useCallback((id, value) => {
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], orNo: value } }))
  }, [])

  const updateCollected = useCallback((id, value) => {
    setEntries((prev) => ({
      ...prev,
      [id]: { ...prev[id], collected: value, remarks: value === true ? '' : prev[id]?.remarks || '' },
    }))
  }, [])

  const updateRemarks = useCallback((id, value) => {
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], remarks: value } }))
  }, [])

  const trimmedName = collectorName.trim()
  const nameEntered = trimmedName.length > 0

  // How many included checks currently have a complete outcome, and
  // whether any entered OR numbers collide.
  const { completedCount, duplicateOrNos, includeCount } = useMemo(() => {
    const seenCounts = {}
    let completed = 0
    let included = 0
    rows.forEach((r) => {
      const entry = entries[r.id]
      if (!entry?.include) return
      included += 1
      const orNo = entry.orNo?.trim() ?? ''
      const reasonOk = entry.collected !== false || !!entry.remarks?.trim()
      if (orNo && entry.collected !== null && entry.collected !== undefined && reasonOk) completed += 1
      if (orNo) {
        const key = orNo.toLowerCase()
        seenCounts[key] = (seenCounts[key] || 0) + 1
      }
    })
    const duplicates = new Set(
      Object.entries(seenCounts)
        .filter(([, c]) => c > 1)
        .map(([k]) => k),
    )
    return { completedCount: completed, duplicateOrNos: duplicates, includeCount: included }
  }, [entries, rows])

  const hasDuplicates = duplicateOrNos.size > 0
  const allComplete = includeCount > 0 && completedCount === includeCount && !hasDuplicates
  const canSubmit = nameEntered && allComplete && !submitting

  function handleConfirm() {
    if (!canSubmit) return
    onConfirm(collectorName, entries)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="submit-approval-title"
        className="relative w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
          <h2 id="submit-approval-title" className="text-lg font-semibold text-ink-900">
            Submit for approval
          </h2>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="text-ink-300 hover:text-ink-600 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto px-5 py-4">
          <p className="text-sm text-ink-600">
            {rows.length === 1 ? (
              <>
                Enter who is collecting <span className="font-medium text-ink-900">{rows[0].payee}</span>'s check,
                then confirm the OR number and AR status. It goes to an approver for verification before it's marked
                picked up.
              </>
            ) : (
              <>
                Enter who is collecting these {rows.length} checks, then confirm the OR number and AR status for
                each. They go to an approver for verification before they're marked picked up.
              </>
            )}
          </p>

          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-ink-500">Collector name</label>
            <Input
              ref={nameInputRef}
              value={collectorName}
              onChange={(e) => setCollectorName(e.target.value)}
              placeholder="Full name of the person picking up"
            />
          </div>

          {nameEntered && (
            <div className="mt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-ink-500">Per-check details</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-ledger-stamp/10 px-2 py-0.5 text-[11px] font-medium text-ledger-stamp">
                    {includeCount} to submit
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      allComplete ? 'bg-ledger-stamp/10 text-ledger-stamp' : 'bg-orange-100 text-orange-700',
                    )}
                  >
                    {completedCount} of {includeCount} entered
                  </span>
                </div>
              </div>

              <div className="max-h-[22rem] overflow-y-auto rounded-md border border-ink-100">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ink-50">
                    <tr className="text-left uppercase tracking-wide text-ink-400">
                      <th className="px-3 py-1.5 font-medium">Include</th>
                      <th className="px-3 py-1.5 font-medium">Check no.</th>
                      <th className="px-3 py-1.5 font-medium">Payee</th>
                      <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                      <th className="px-3 py-1.5 font-medium">OR no.</th>
                      <th className="px-3 py-1.5 font-medium">AR collected</th>
                      <th className="px-3 py-1.5 font-medium">Remarks</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-50">
                    {rows.map((r, idx) => {
                      const entry = entries[r.id] || { include: true, orNo: '', collected: null, remarks: '' }
                      const trimmedOrNo = entry.orNo?.trim() ?? ''
                      const isDuplicate = entry.include && trimmedOrNo && duplicateOrNos.has(trimmedOrNo.toLowerCase())
                      const needsReason = entry.include && entry.collected === false
                      const missingReason = needsReason && !entry.remarks?.trim()
                      const rowIncomplete =
                        entry.include &&
                        (!trimmedOrNo || entry.collected === null || entry.collected === undefined || missingReason)

                      return (
                        <tr
                          key={r.id}
                          className={cn(
                            !entry.include && 'bg-slate-50/70',
                            entry.include && isDuplicate && 'bg-red-50/70',
                            entry.include && !isDuplicate && rowIncomplete && 'bg-amber-50/50',
                          )}
                        >
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => updateInclude(r.id, !entry.include)}
                              aria-pressed={entry.include}
                              aria-label={
                                entry.include
                                  ? `Exclude check ${r.check_no || idx + 1}`
                                  : `Include check ${r.check_no || idx + 1}`
                              }
                              className={entry.include ? 'text-ledger-stamp' : 'text-ink-300 hover:text-ink-500'}
                            >
                              {entry.include ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                            </button>
                          </td>
                          <td className="px-3 py-2 font-mono text-ink-700">{r.check_no || '—'}</td>
                          <td className="max-w-[110px] truncate px-3 py-2 text-ink-900">{r.payee || '—'}</td>
                          <td className="px-3 py-2 text-right font-mono text-ink-700">{formatCurrency(r.amount)}</td>
                          <td className="px-2 py-1.5">
                            {entry.include ? (
                              <>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={entry.orNo}
                                  onChange={(e) => updateOrNo(r.id, e.target.value)}
                                  onBlur={(e) => updateOrNo(r.id, e.target.value.trim())}
                                  placeholder="OR no."
                                  maxLength={40}
                                  aria-label={`OR number for check ${r.check_no || idx + 1}`}
                                  className={cn(
                                    'w-24 rounded border px-2 py-1 text-xs text-ink-800 focus:outline-none focus:ring-1 focus:ring-ledger-stamp',
                                    isDuplicate ? 'border-red-400' : 'border-ink-200',
                                  )}
                                />
                                {isDuplicate && (
                                  <p className="mt-0.5 text-[10px] leading-tight text-red-600">Duplicate</p>
                                )}
                              </>
                            ) : (
                              <span className="text-ink-300">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {entry.include ? (
                              <div
                                className="flex gap-1"
                                role="group"
                                aria-label={`AR collected for check ${r.check_no || idx + 1}`}
                              >
                                <button
                                  type="button"
                                  onClick={() => updateCollected(r.id, true)}
                                  aria-pressed={entry.collected === true}
                                  className={cn(
                                    'rounded border px-2 py-1 text-[11px] font-medium transition',
                                    entry.collected === true
                                      ? 'border-ledger-stamp bg-ledger-stamp text-white'
                                      : 'border-ink-200 text-ink-500 hover:bg-ink-50',
                                  )}
                                >
                                  Yes
                                </button>
                                <button
                                  type="button"
                                  onClick={() => updateCollected(r.id, false)}
                                  aria-pressed={entry.collected === false}
                                  className={cn(
                                    'rounded border px-2 py-1 text-[11px] font-medium transition',
                                    entry.collected === false
                                      ? 'border-ink-700 bg-ink-700 text-white'
                                      : 'border-ink-200 text-ink-500 hover:bg-ink-50',
                                  )}
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <span className="text-ink-300">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {needsReason ? (
                              <input
                                type="text"
                                value={entry.remarks}
                                onChange={(e) => updateRemarks(r.id, e.target.value)}
                                placeholder="Why wasn't AR collected?"
                                maxLength={200}
                                aria-label={`Remarks for check ${r.check_no || idx + 1}`}
                                className={cn(
                                  'w-40 rounded border px-2 py-1 text-xs text-ink-800 focus:outline-none focus:ring-1 focus:ring-ledger-stamp',
                                  missingReason ? 'border-orange-400' : 'border-ink-200',
                                )}
                              />
                            ) : (
                              <span className="text-ink-300">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {!allComplete && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-orange-600">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {includeCount === 0
                    ? 'Include at least one check to submit.'
                    : hasDuplicates
                    ? 'Each check needs its own unique OR number.'
                    : "Every included check needs an OR number and AR-collected status (plus a reason if AR wasn't collected)."}
                </p>
              )}
            </div>
          )}

          {error && (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-100 px-5 py-4">
          <button
            ref={cancelButtonRef}
            onClick={onCancel}
            disabled={submitting}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canSubmit}
            title={!canSubmit && nameEntered ? 'Every included check needs complete details before submitting' : undefined}
            className="flex items-center gap-2 rounded-md bg-ledger-stamp px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? 'Submitting…' : includeCount > 1 ? `Submit ${includeCount} for approval` : 'Submit for approval'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SkeletonRows({ count, cellPad }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: 10 }).map((__, j) => (
            <td key={j} className={cellPad}>
              <div className="h-3.5 w-full max-w-[7rem] animate-pulse rounded bg-ink-100" />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
