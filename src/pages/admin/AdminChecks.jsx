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
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Dialog } from '../../components/ui/dialog'
import { useToast } from '../../components/ui/toast'
import { formatCurrency, formatDate, cn } from '../../lib/utils'

const PAGE_SIZE = 20
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

  const [sortKey, setSortKey] = useState('created_at')
  const [sortAsc, setSortAsc] = useState(false)

  const [rows, setRows] = useState([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [activeRow, setActiveRow] = useState(null)
  const [collectorName, setCollectorName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pickupError, setPickupError] = useState('')
  const [undoingIds, setUndoingIds] = useState(() => new Set())

  const { push } = useToast()

  const isMountedRef = useRef(true)
  const requestIdRef = useRef(0)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const filters = useMemo(
    () => ({ query, status, dateFrom, dateTo, amountMin, amountMax, sortKey, sortAsc }),
    [query, status, dateFrom, dateTo, amountMin, amountMax, sortKey, sortAsc],
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
    const t = setTimeout(() => load(page), DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page])

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
          .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1)

        if (status !== 'all') req = req.eq('status', status)
        if (query.trim()) {
          const s = query.trim().toLowerCase()
          req = req.or(`payee.ilike.%${s}%,payor.ilike.%${s}%,check_no.ilike.%${s}%`)
        }
        if (dateFrom) req = req.gte('check_date', dateFrom)
        if (dateTo) req = req.lte('check_date', dateTo)
        if (amountMin) req = req.gte('amount', Number(amountMin))
        if (amountMax) req = req.lte('amount', Number(amountMax))

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, status, dateFrom, dateTo, amountMin, amountMax, sortKey, sortAsc],
  )

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
  }

  const hasAdvancedFilters = !!(dateFrom || dateTo || amountMin || amountMax)

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

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE))

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-900">Checks register</h1>
          <p className="mt-1 text-sm text-ink-400">
            Search every uploaded check, sort any column, mark pickups, and undo mistakes.
          </p>
        </div>
        {!loading && !loadError && (
          <p className="font-mono text-xs text-ink-400">
            {count} check{count === 1 ? '' : 's'} match{count === 1 ? 'es' : ''}
          </p>
        )}
      </div>

      <div className="mb-3 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search payee, payor, or check no..."
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
          <div className="sm:col-span-2 lg:col-span-4">
            <Button variant="ghost" size="sm" onClick={clearAdvancedFilters} disabled={!hasAdvancedFilters}>
              Clear advanced filters
            </Button>
          </div>
        </div>
      )}

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

      <div className="overflow-x-auto rounded-lg border border-ink-100 bg-white">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="bg-ink-50 text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3 font-medium">File / Row</th>
              <SortableHeader label="Payee" sortKeyName="payee" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} />
              <th className="px-4 py-3 font-medium">Payor</th>
              <th className="px-4 py-3 font-medium">Check No.</th>
              <SortableHeader label="Check Date" sortKeyName="check_date" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} />
              <SortableHeader label="Amount" sortKeyName="amount" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} />
              <SortableHeader label="Uploaded" sortKeyName="uploaded_at" currentKey={sortKey} asc={sortAsc} onClick={toggleSort} />
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {loading ? (
              <SkeletonRows />
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-14">
                  <div className="flex flex-col items-center text-center">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-ink-200 text-ink-300">
                      <Inbox className="h-5 w-5" />
                    </span>
                    <p className="mt-3 text-sm font-medium text-ink-600">No checks match your filters</p>
                    <p className="mt-1 text-xs text-ink-300">Try widening your search or clearing a filter.</p>
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="hover:bg-ink-50/40">
                  <td className="px-4 py-3 font-mono text-xs text-ink-400">
                    {row.upload_batches?.file_name || '—'}
                    <br />
                    Row {row.row_number}
                  </td>
                  <td className="px-4 py-3 font-medium text-ink-800">{row.payee || '—'}</td>
                  <td className="px-4 py-3 text-ink-600">{row.payor || '—'}</td>
                  <td className="px-4 py-3 font-mono text-ink-600">{row.check_no || '—'}</td>
                  <td className="px-4 py-3 text-ink-600">
                    {row.check_date ? formatDate(row.check_date) : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-ink-800">{formatCurrency(row.amount)}</td>
                  {/* ── Uploaded-date column ── shows when the source file was imported */}
                  <td className="px-4 py-3 text-ink-500">
                    {row.upload_batches?.uploaded_at ? formatDate(row.upload_batches.uploaded_at) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {row.status === 'available' ? (
                      <Badge variant="available">Available</Badge>
                    ) : (
                      <Badge variant="pickedup">Picked up by {row.picked_up_by || 'unknown'}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
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
    </div>
  )
}

function SortableHeader({ label, sortKeyName, currentKey, asc, onClick }) {
  const isActive = currentKey === sortKeyName
  const Icon = isActive ? (asc ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th className={cn('px-4 py-3 font-medium', isActive && 'bg-ledger-stamp/5')}>
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

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: 9 }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-3.5 w-full max-w-[7rem] animate-pulse rounded bg-ink-100" />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
