import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  PackageCheck,
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
  Users,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Dialog } from '../../components/ui/dialog'
import { useToast } from '../../components/ui/toast'
import { formatCurrency, formatDate, cn } from '../../lib/utils'

const PAGE_SIZE_OPTIONS = [25, 50, 100]
const SORTABLE_COLUMNS = ['payee', 'check_date', 'amount', 'uploaded_at']
const DEBOUNCE_MS = 300

export default function AdminChecks() {
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
  const [stats, setStats] = useState({ available: null, pickedUp: null })

  const [activeRow, setActiveRow] = useState(null)
  const [collectorName, setCollectorName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pickupError, setPickupError] = useState('')
  const [undoingIds, setUndoingIds] = useState(() => new Set())

  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkAction, setBulkAction] = useState(null) // 'pickup' | 'undo' | null
  const [bulkCollectorName, setBulkCollectorName] = useState('')
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [bulkError, setBulkError] = useState('')

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
        supabase.from('checks').select('picked_up_by').not('picked_up_by', 'is', null).limit(1000),
      ])
      if (!batchesRes.error) setFileOptions(batchesRes.data || [])
      if (!collectorsRes.error) {
        const distinct = [...new Set((collectorsRes.data || []).map((r) => r.picked_up_by).filter(Boolean))].sort()
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
      if (collectorFilter) r = r.eq('picked_up_by', collectorFilter)
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
            'id, row_number, payee, payor, check_no, check_date, amount, status, picked_up_by, picked_up_at, upload_batches(file_name, uploaded_at)',
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

  // Head-only counts (no rows fetched) so the available/picked-up split
  // stays cheap regardless of table size, and reflects every filter except
  // status itself so the split is always meaningful.
  const loadStats = useCallback(async () => {
    try {
      const [availableRes, pickedUpRes] = await Promise.all([
        applyCommonFilters(supabase.from('checks').select('id', { count: 'exact', head: true })).eq(
          'status',
          'available',
        ),
        applyCommonFilters(supabase.from('checks').select('id', { count: 'exact', head: true })).eq(
          'status',
          'picked_up',
        ),
      ])
      if (!isMountedRef.current) return
      setStats({
        available: availableRes.error ? null : availableRes.count ?? 0,
        pickedUp: pickedUpRes.error ? null : pickedUpRes.count ?? 0,
      })
    } catch {
      if (isMountedRef.current) setStats({ available: null, pickedUp: null })
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

  const activeChips = useMemo(() => {
    const chips = []
    if (status !== 'all') chips.push({ key: 'status', label: `Status: ${status === 'available' ? 'Available' : 'Picked up'}`, clear: () => setStatus('all') })
    if (dateFrom || dateTo) chips.push({ key: 'dates', label: `Date: ${dateFrom || '…'} → ${dateTo || '…'}`, clear: () => { setDateFrom(''); setDateTo('') } })
    if (amountMin || amountMax) chips.push({ key: 'amount', label: `Amount: ${amountMin || '0'} - ${amountMax || '∞'}`, clear: () => { setAmountMin(''); setAmountMax('') } })
    if (fileFilter) {
      const f = fileOptions.find((o) => String(o.id) === String(fileFilter))
      chips.push({ key: 'file', label: `File: ${f?.file_name || fileFilter}`, clear: () => setFileFilter('') })
    }
    if (collectorFilter) chips.push({ key: 'collector', label: `Collector: ${collectorFilter}`, clear: () => setCollectorFilter('') })
    return chips
  }, [status, dateFrom, dateTo, amountMin, amountMax, fileFilter, collectorFilter, fileOptions])

  function openPickup(row) {
    setActiveRow(row)
    setCollectorName('')
    setPickupError('')
  }

  function closePickup() {
    if (submitting) return
    setActiveRow(null)
    setPickupError('')
  }

  async function confirmPickup() {
    if (!collectorName.trim() || !activeRow || submitting) return
    setSubmitting(true)
    setPickupError('')

    try {
      const { error } = await supabase
        .from('checks')
        .update({
          status: 'picked_up',
          picked_up_by: collectorName.trim(),
          picked_up_at: new Date().toISOString(),
        })
        .eq('id', activeRow.id)

      if (error) {
        setPickupError(error.message || 'Something went wrong. Please try again.')
        push({ variant: 'error', title: 'Update failed', description: error.message })
        return
      }

      push({
        variant: 'success',
        title: 'Marked as picked up',
        description: `${activeRow.payee} — ${collectorName.trim()}`,
      })
      setActiveRow(null)
      load(page)
      loadStats()
    } catch (err) {
      const message = err?.message || 'Something went wrong. Please try again.'
      setPickupError(message)
      push({ variant: 'error', title: 'Update failed', description: message })
    } finally {
      setSubmitting(false)
    }
  }

  async function undoPickup(row) {
    if (undoingIds.has(row.id)) return
    setUndoingIds((prev) => new Set(prev).add(row.id))

    try {
      const { error } = await supabase
        .from('checks')
        .update({ status: 'available', picked_up_by: null, picked_up_at: null })
        .eq('id', row.id)

      if (error) {
        push({ variant: 'error', title: 'Could not undo', description: error.message })
        return
      }
      push({ variant: 'info', title: 'Reverted to available', description: row.payee })
      load(page)
      loadStats()
    } catch (err) {
      push({ variant: 'error', title: 'Could not undo', description: err?.message || 'Please try again.' })
    } finally {
      setUndoingIds((prev) => {
        const next = new Set(prev)
        next.delete(row.id)
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
  const selectedPickedUp = rows.filter((r) => selectedIds.has(r.id) && r.status === 'picked_up')

  function openBulkPickup() {
    setBulkAction('pickup')
    setBulkCollectorName('')
    setBulkError('')
  }

  function openBulkUndo() {
    setBulkAction('undo')
    setBulkError('')
  }

  function closeBulkDialog() {
    if (bulkSubmitting) return
    setBulkAction(null)
    setBulkError('')
  }

  async function confirmBulkPickup() {
    if (!bulkCollectorName.trim() || selectedAvailable.length === 0 || bulkSubmitting) return
    setBulkSubmitting(true)
    setBulkError('')
    try {
      const ids = selectedAvailable.map((r) => r.id)
      const { error } = await supabase
        .from('checks')
        .update({ status: 'picked_up', picked_up_by: bulkCollectorName.trim(), picked_up_at: new Date().toISOString() })
        .in('id', ids)

      if (error) {
        setBulkError(error.message || 'Something went wrong. Please try again.')
        push({ variant: 'error', title: 'Bulk update failed', description: error.message })
        return
      }

      push({
        variant: 'success',
        title: 'Marked as picked up',
        description: `${ids.length} check${ids.length === 1 ? '' : 's'} — ${bulkCollectorName.trim()}`,
      })
      setBulkAction(null)
      setSelectedIds(new Set())
      load(page)
      loadStats()
    } catch (err) {
      const message = err?.message || 'Something went wrong. Please try again.'
      setBulkError(message)
      push({ variant: 'error', title: 'Bulk update failed', description: message })
    } finally {
      setBulkSubmitting(false)
    }
  }

  async function confirmBulkUndo() {
    if (selectedPickedUp.length === 0 || bulkSubmitting) return
    setBulkSubmitting(true)
    setBulkError('')
    try {
      const ids = selectedPickedUp.map((r) => r.id)
      const { error } = await supabase
        .from('checks')
        .update({ status: 'available', picked_up_by: null, picked_up_at: null })
        .in('id', ids)

      if (error) {
        setBulkError(error.message || 'Something went wrong. Please try again.')
        push({ variant: 'error', title: 'Bulk undo failed', description: error.message })
        return
      }

      push({ variant: 'info', title: 'Reverted to available', description: `${ids.length} check${ids.length === 1 ? '' : 's'}` })
      setBulkAction(null)
      setSelectedIds(new Set())
      load(page)
      loadStats()
    } catch (err) {
      const message = err?.message || 'Something went wrong. Please try again.'
      setBulkError(message)
      push({ variant: 'error', title: 'Bulk undo failed', description: message })
    } finally {
      setBulkSubmitting(false)
    }
  }

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
            Search every uploaded check, sort any column, mark pickups, and undo mistakes.
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
                <span>{stats.pickedUp ?? '—'} picked up</span>
              </p>
            </div>
          )}
        </div>
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
            <label className="mb-1 block text-xs font-medium text-ink-500">Collected by</label>
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
              <Button size="sm" variant="stamp" onClick={openBulkPickup} disabled={selectedAvailable.length === 0}>
                <PackageCheck className="h-3.5 w-3.5" /> Mark picked up ({selectedAvailable.length})
              </Button>
              <Button size="sm" variant="ghost" onClick={openBulkUndo} disabled={selectedPickedUp.length === 0}>
                <RotateCcw className="h-3.5 w-3.5" /> Undo ({selectedPickedUp.length})
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
                    ) : (
                      <Badge variant="pickedup">Picked up by {row.picked_up_by || 'unknown'}</Badge>
                    )}
                  </td>
                  <td className={cn(cellPad, 'text-right')}>
                    {row.status === 'available' ? (
                      <Button size="sm" variant="stamp" onClick={() => openPickup(row)}>
                        <PackageCheck className="h-3.5 w-3.5" /> Mark picked up
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => undoPickup(row)}
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

      <Dialog
        open={!!activeRow}
        onClose={closePickup}
        title="Mark check as picked up"
        description={activeRow ? `${activeRow.payee} · Check #${activeRow.check_no}` : ''}
      >
        <label className="mb-1 block text-xs font-medium text-ink-500">Collector name</label>
        <Input
          value={collectorName}
          onChange={(e) => setCollectorName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              confirmPickup()
            }
          }}
          placeholder="Full name of the person picking up"
          autoFocus
        />
        {pickupError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {pickupError}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={closePickup} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="stamp" disabled={!collectorName.trim() || submitting} onClick={confirmPickup}>
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {submitting ? 'Saving…' : 'Confirm pickup'}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={bulkAction === 'pickup'}
        onClose={closeBulkDialog}
        title="Mark selected checks as picked up"
        description={`${selectedAvailable.length} available check${selectedAvailable.length === 1 ? '' : 's'} selected`}
      >
        <label className="mb-1 block text-xs font-medium text-ink-500">Collector name</label>
        <Input
          value={bulkCollectorName}
          onChange={(e) => setBulkCollectorName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              confirmBulkPickup()
            }
          }}
          placeholder="Full name of the person picking up"
          autoFocus
        />
        {bulkError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {bulkError}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={closeBulkDialog} disabled={bulkSubmitting}>
            Cancel
          </Button>
          <Button
            variant="stamp"
            disabled={!bulkCollectorName.trim() || selectedAvailable.length === 0 || bulkSubmitting}
            onClick={confirmBulkPickup}
          >
            {bulkSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {bulkSubmitting ? 'Saving…' : `Confirm for ${selectedAvailable.length}`}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={bulkAction === 'undo'}
        onClose={closeBulkDialog}
        title="Undo pickup for selected checks"
        description={`${selectedPickedUp.length} picked-up check${selectedPickedUp.length === 1 ? '' : 's'} selected — this reverts them to Available.`}
      >
        {bulkError && (
          <p className="mb-2 flex items-center gap-1.5 text-xs text-red-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {bulkError}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" onClick={closeBulkDialog} disabled={bulkSubmitting}>
            Cancel
          </Button>
          <Button variant="stamp" disabled={selectedPickedUp.length === 0 || bulkSubmitting} onClick={confirmBulkUndo}>
            {bulkSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {bulkSubmitting ? 'Reverting…' : `Undo ${selectedPickedUp.length}`}
          </Button>
        </div>
      </Dialog>
    </div>
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
