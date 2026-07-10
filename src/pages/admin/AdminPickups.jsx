import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  RefreshCw,
  Search,
  X,
  Check,
  Undo2,
  Loader2,
  AlertTriangle,
  User,
  Hash,
  CalendarDays,
  Layers,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'

const POLL_INTERVAL_MS = 20000
const EXPIRING_SOON_MINUTES = 15

export default function AdminPickups() {
  const [tab, setTab] = useState('active') // 'active' | 'history'
  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [collectorFilter, setCollectorFilter] = useState('')
  const [now, setNow] = useState(Date.now())
  const [confirmAction, setConfirmAction] = useState(null) // { type: 'pickup' | 'release', reservation }
  const [actioning, setActioning] = useState(false)
  const [actionError, setActionError] = useState('')

  const debounceRef = useRef(null)
  const isMountedRef = useRef(true)
  // Guards against overlapping fetches (e.g. a poll firing while a manual
  // refresh is still in flight) and against a stale response landing after
  // a newer request has already resolved.
  const requestIdRef = useRef(0)
  const inFlightRef = useRef(false)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Debounced re-fetch when the collector filter changes
  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load(false), 250)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectorFilter])

  // Keep countdowns live and periodically pull fresh data (also catches
  // reservations that expired naturally without anyone touching this page).
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => {
      if (tab === 'active') load(false)
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const load = useCallback(
    async (showFullLoading) => {
      // Don't let a background poll pile up behind a slow request; the
      // next scheduled tick will just try again.
      if (inFlightRef.current && !showFullLoading) return

      const requestId = ++requestIdRef.current
      inFlightRef.current = true

      if (showFullLoading) setLoading(true)
      else setRefreshing(true)
      setLoadError('')

      try {
        if (tab === 'active') {
          // Release anything that expired since we last looked, so the
          // active list never shows stale holds. Non-fatal if it fails —
          // the list below still reflects whatever is currently 'reserved'.
          const { error: reclaimError } = await supabase.rpc('reclaim_expired_reservations')
          if (reclaimError) {
            console.error('reclaim_expired_reservations failed:', reclaimError)
          }
        }

        const statusFilter = tab === 'active' ? ['reserved'] : ['picked_up', 'expired', 'cancelled']

        let req = supabase
          .from('pickup_reservations')
          .select(
            'id, collector_name, status, reserved_at, expires_at, picked_up_at, checks(id, row_number, payee, payor, check_no, check_date, amount)'
          )
          .in('status', statusFilter)
          .order('reserved_at', { ascending: false })
          .limit(150)

        const trimmedFilter = collectorFilter.trim()
        if (trimmedFilter) {
          req = req.ilike('collector_name', `%${trimmedFilter}%`)
        }

        const { data, error } = await req

        // If a newer request has since started, or we've unmounted, drop
        // this result on the floor.
        if (!isMountedRef.current || requestId !== requestIdRef.current) return

        if (error) {
          setLoadError(error.message || 'Failed to load reservations. Please try again.')
        } else {
          setReservations(Array.isArray(data) ? data : [])
        }
      } catch (err) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) return
        setLoadError(err?.message || 'Failed to load reservations. Please try again.')
      } finally {
        if (isMountedRef.current && requestId === requestIdRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
        inFlightRef.current = false
      }
    },
    [tab, collectorFilter]
  )

  function minutesLeft(expiresAt) {
    if (!expiresAt) return 0
    return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 60000))
  }

  function formatCountdown(expiresAt) {
    if (!expiresAt) return '—'
    const ms = new Date(expiresAt).getTime() - now
    if (ms <= 0) return 'Expiring…'
    const mins = Math.floor(ms / 60000)
    const secs = Math.floor((ms % 60000) / 1000)
    return `${mins}m ${secs.toString().padStart(2, '0')}s left`
  }

  // Checks within a single order should always render in a stable,
  // predictable sequence regardless of what order the API returns them in.
  function sortedChecks(reservation) {
    const checks = Array.isArray(reservation.checks) ? reservation.checks : []
    return [...checks].sort((a, b) => {
      const an = Number(a.row_number)
      const bn = Number(b.row_number)
      if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn
      return String(a.check_no ?? '').localeCompare(String(b.check_no ?? ''))
    })
  }

  function orderTotal(reservation) {
    const checks = Array.isArray(reservation.checks) ? reservation.checks : []
    return checks.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
  }

  const activeSummary = useMemo(() => {
    if (tab !== 'active') return null
    const expiringSoon = reservations.filter(
      (r) => minutesLeft(r.expires_at) <= EXPIRING_SOON_MINUTES
    ).length
    const totalChecks = reservations.reduce(
      (sum, r) => sum + (Array.isArray(r.checks) ? r.checks.length : 0),
      0
    )
    return { total: reservations.length, expiringSoon, totalChecks }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, tab, now])

  function openConfirm(type, reservation) {
    setActionError('')
    setConfirmAction({ type, reservation })
  }

  async function runAction() {
    if (!confirmAction || actioning) return
    setActioning(true)
    setActionError('')

    const fn =
      confirmAction.type === 'pickup' ? 'admin_confirm_pickup' : 'admin_release_reservation'

    try {
      const { error } = await supabase.rpc(fn, {
        p_reservation_id: confirmAction.reservation.id,
      })

      if (!isMountedRef.current) return

      if (error) {
        setActionError(error.message || 'Something went wrong. Please try again.')
        return
      }

      setConfirmAction(null)
      load(false)
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      if (isMountedRef.current) setActioning(false)
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Pending pickups</h1>
          <p className="mt-1 text-sm text-ink-500">
            Checks collectors have reserved and their remaining pickup window. A single order can
            include multiple checks.
          </p>
        </div>
        <button
          onClick={() => load(false)}
          disabled={refreshing || loading}
          className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {tab === 'active' && activeSummary && !loading && (
        <div className="mb-5 grid grid-cols-3 gap-3 sm:max-w-lg">
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-400">Active orders</p>
            <p className="mt-1 text-2xl font-semibold text-ink-900">{activeSummary.total}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-400">Checks on hold</p>
            <p className="mt-1 text-2xl font-semibold text-ink-900">{activeSummary.totalChecks}</p>
          </Card>
          <Card className={cn('p-4', activeSummary.expiringSoon > 0 && 'border-orange-300 bg-orange-50')}>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
              Expiring within {EXPIRING_SOON_MINUTES}m
            </p>
            <p
              className={cn(
                'mt-1 text-2xl font-semibold',
                activeSummary.expiringSoon > 0 ? 'text-orange-600' : 'text-ink-900'
              )}
            >
              {activeSummary.expiringSoon}
            </p>
          </Card>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md border border-ink-200 p-1">
          <TabButton active={tab === 'active'} onClick={() => setTab('active')}>
            Active
          </TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
            History
          </TabButton>
        </div>

        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input
            value={collectorFilter}
            onChange={(e) => setCollectorFilter(e.target.value)}
            placeholder="Filter by collector name..."
            className="border-ink-200 pl-9 pr-8 text-sm focus-visible:ring-teal-500"
            aria-label="Filter by collector name"
          />
          {collectorFilter && (
            <button
              onClick={() => setCollectorFilter('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600"
              aria-label="Clear filter"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

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
      ) : reservations.length === 0 ? (
        <EmptyState tab={tab} hasFilter={!!collectorFilter.trim()} />
      ) : (
        <div className="space-y-3">
          {reservations.map((r) => (
            <ReservationCard
              key={r.id}
              reservation={r}
              checks={sortedChecks(r)}
              total={orderTotal(r)}
              tab={tab}
              minutesLeft={tab === 'active' ? minutesLeft(r.expires_at) : null}
              countdownLabel={tab === 'active' ? formatCountdown(r.expires_at) : null}
              onConfirmPickup={() => openConfirm('pickup', r)}
              onRelease={() => openConfirm('release', r)}
            />
          ))}
        </div>
      )}

      {confirmAction && (
        <ActionModal
          action={confirmAction}
          checks={sortedChecks(confirmAction.reservation)}
          total={orderTotal(confirmAction.reservation)}
          onCancel={() => setConfirmAction(null)}
          onConfirm={runAction}
          loading={actioning}
          error={actionError}
        />
      )}
    </div>
  )
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded px-3.5 py-1.5 text-sm font-medium transition',
        active ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-50'
      )}
    >
      {children}
    </button>
  )
}

function StatusBadge({ status }) {
  const styles = {
    reserved: 'bg-teal-100 text-teal-700',
    picked_up: 'bg-teal-100 text-teal-700',
    expired: 'bg-slate-100 text-slate-500',
    cancelled: 'bg-orange-100 text-orange-700',
  }
  const labels = {
    reserved: 'Reserved',
    picked_up: 'Picked up',
    expired: 'Expired',
    cancelled: 'Released',
  }
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-medium', styles[status] || 'bg-ink-100 text-ink-600')}>
      {labels[status] || status || 'Unknown'}
    </span>
  )
}

function ReservationCard({
  reservation,
  checks,
  total,
  tab,
  minutesLeft,
  countdownLabel,
  onConfirmPickup,
  onRelease,
}) {
  const expiringSoon = tab === 'active' && minutesLeft !== null && minutesLeft <= EXPIRING_SOON_MINUTES
  const checkCount = checks.length

  return (
    <Card className={cn('overflow-hidden p-0', expiringSoon && 'border-orange-300')}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 bg-ink-50/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-ink-400" />
          <span className="font-medium text-ink-900">
            {reservation.collector_name || 'Unknown collector'}
          </span>
          <StatusBadge status={reservation.status} />
          <span className="flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600">
            <Layers className="h-3 w-3" />
            {checkCount} check{checkCount === 1 ? '' : 's'}
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs text-ink-500">
          <span>Reserved {formatDate(reservation.reserved_at)}</span>
          {tab === 'active' ? (
            <span
              className={cn(
                'flex items-center gap-1 font-mono font-medium',
                expiringSoon ? 'text-orange-600' : 'text-teal-700'
              )}
            >
              <Clock className="h-3.5 w-3.5" />
              {countdownLabel}
            </span>
          ) : (
            reservation.picked_up_at && (
              <span className="flex items-center gap-1">
                <Check className="h-3.5 w-3.5 text-teal-600" />
                Picked up {formatDate(reservation.picked_up_at)}
              </span>
            )
          )}
        </div>
      </div>

      {checkCount === 0 ? (
        <p className="px-4 py-3 text-xs text-ink-400">No linked checks found for this order.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-ink-50 text-left text-[11px] uppercase tracking-wide text-ink-400">
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-2 py-2 font-medium">Check no.</th>
                <th className="px-2 py-2 font-medium">Payee</th>
                <th className="px-2 py-2 font-medium">Payor</th>
                <th className="px-2 py-2 font-medium">Check date</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {checks.map((c, idx) => (
                <tr key={c.id ?? `${reservation.id}-${idx}`}>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-400">{idx + 1}</td>
                  <td className="px-2 py-2.5 font-mono text-xs text-ink-700">
                    <span className="flex items-center gap-1">
                      <Hash className="h-3 w-3 text-ink-300" />
                      {c.check_no || '—'}
                    </span>
                  </td>
                  <td className="max-w-[160px] truncate px-2 py-2.5 font-medium text-ink-900">
                    {c.payee || '—'}
                  </td>
                  <td className="max-w-[160px] truncate px-2 py-2.5 text-ink-600">{c.payor || '—'}</td>
                  <td className="px-2 py-2.5 text-xs text-ink-500">
                    <span className="flex items-center gap-1">
                      <CalendarDays className="h-3 w-3 text-ink-300" />
                      {c.check_date ? formatDate(c.check_date) : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono font-medium text-ink-700">
                    {formatCurrency(c.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-100 bg-ink-50/40">
                <td colSpan={5} className="px-4 py-2 text-right text-xs font-medium text-ink-500">
                  Order total
                </td>
                <td className="px-4 py-2 text-right font-mono font-semibold text-ink-900">
                  {formatCurrency(total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {tab === 'active' && (
        <div className="flex items-center justify-end gap-2 border-t border-ink-100 bg-white px-4 py-3">
          <button
            onClick={onRelease}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50"
          >
            <Undo2 className="h-3.5 w-3.5" />
            Release
          </button>
          <button
            onClick={onConfirmPickup}
            className="flex items-center gap-1.5 rounded-md bg-orange-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-600"
          >
            <Check className="h-3.5 w-3.5" />
            Mark Picked Up
          </button>
        </div>
      )}
    </Card>
  )
}

function ActionModal({ action, checks, total, onCancel, onConfirm, loading, error }) {
  const isPickup = action.type === 'pickup'
  const { reservation } = action
  const checkCount = checks.length
  const dialogRef = useRef(null)

  // Escape-to-close and a light focus trap so keyboard users aren't
  // dropped out of the modal into the page behind it.
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && !loading) {
        onCancel()
        return
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
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
    const previouslyFocused = document.activeElement
    dialogRef.current?.querySelector('button')?.focus()

    // Prevent the page behind the modal from scrolling.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [loading, onCancel])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pickup-action-title"
        className="w-full max-w-lg rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
          <h2 id="pickup-action-title" className="text-lg font-semibold text-ink-900">
            {isPickup ? 'Confirm pickup' : 'Release reservation'}
          </h2>
          <button
            onClick={onCancel}
            disabled={loading}
            className="text-ink-300 hover:text-ink-600 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-ink-600">
            {isPickup ? (
              <>
                Confirm that <span className="font-medium text-ink-900">{reservation.collector_name}</span>{' '}
                has physically taken this order of {checkCount} check{checkCount === 1 ? '' : 's'}. This
                will mark {checkCount === 1 ? 'it' : 'them'} as permanently picked up.
              </>
            ) : (
              <>
                This releases this order of {checkCount} check{checkCount === 1 ? '' : 's'} held for{' '}
                <span className="font-medium text-ink-900">{reservation.collector_name}</span> back into the
                available pool immediately. Use this if the collector cancelled or won't be coming.
              </>
            )}
          </p>

          {checkCount > 0 && (
            <div className="mt-3 max-h-56 overflow-y-auto rounded-md border border-ink-100">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-ink-50">
                  <tr className="text-left uppercase tracking-wide text-ink-400">
                    <th className="px-3 py-1.5 font-medium">Check no.</th>
                    <th className="px-3 py-1.5 font-medium">Payee</th>
                    <th className="px-3 py-1.5 font-medium">Payor</th>
                    <th className="px-3 py-1.5 font-medium">Date</th>
                    <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {checks.map((c, idx) => (
                    <tr key={c.id ?? idx}>
                      <td className="px-3 py-1.5 font-mono text-ink-700">{c.check_no || '—'}</td>
                      <td className="max-w-[110px] truncate px-3 py-1.5 text-ink-900">{c.payee || '—'}</td>
                      <td className="max-w-[110px] truncate px-3 py-1.5 text-ink-600">{c.payor || '—'}</td>
                      <td className="px-3 py-1.5 text-ink-500">
                        {c.check_date ? formatDate(c.check_date) : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-ink-700">
                        {formatCurrency(c.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-100 bg-ink-50/60">
                    <td colSpan={4} className="px-3 py-1.5 text-right font-medium text-ink-500">
                      Total
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold text-ink-900">
                      {formatCurrency(total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {!isPickup && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-orange-50 px-3 py-2 text-xs text-orange-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This collector's reservation will be marked as not picked up.
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
            onClick={onCancel}
            disabled={loading}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-60',
              isPickup ? 'bg-orange-500 hover:bg-orange-600' : 'bg-ink-900 hover:bg-ink-800'
            )}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {isPickup ? 'Confirm Pickup' : 'Release'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-28 animate-pulse rounded-lg border border-ink-100 bg-ink-50/60" />
      ))}
    </div>
  )
}

function EmptyState({ tab, hasFilter }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-ink-200 px-4 py-16 text-center">
      <Clock className="h-8 w-8 text-ink-200" />
      <p className="mt-3 text-lg font-semibold text-ink-700">
        {hasFilter
          ? 'No matching reservations'
          : tab === 'active'
          ? 'No active reservations'
          : 'No history yet'}
      </p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        {hasFilter
          ? 'Try a different collector name, or clear the filter.'
          : tab === 'active'
          ? 'Orders reserved by collectors will show up here until picked up or expired.'
          : 'Completed, expired, and released orders will appear here.'}
      </p>
    </div>
  )
}
