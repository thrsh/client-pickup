import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  Hash,
  CalendarDays,
  X,
  Check,
  Loader2,
  PackageCheck,
  Package,
  Truck,
  MapPin,
  ArrowRight,
  Clock,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Input } from '../components/ui/input'
import { Card } from '../components/ui/card'
import { formatDate } from '../lib/utils'

const PAGE_SIZE = 25
const SUGGESTION_MIN_CHARS = 3

export default function PublicSearch() {
  // Two independent search fields — both are combined (AND) when searching,
  // so entering both narrows results to checks matching that payee AND payor.
  const [payeeQuery, setPayeeQuery] = useState('')
  const [payorQuery, setPayorQuery] = useState('')

  const [rows, setRows] = useState([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const [payeeSuggestions, setPayeeSuggestions] = useState([])
  const [showPayeeSuggestions, setShowPayeeSuggestions] = useState(false)
  const payeeBoxRef = useRef(null)

  const [payorSuggestions, setPayorSuggestions] = useState([])
  const [showPayorSuggestions, setShowPayorSuggestions] = useState(false)
  const payorBoxRef = useRef(null)

  // Selection state
  const [selectedIds, setSelectedIds] = useState(new Set())

  // Pickup confirmation flow
  const [showConfirm, setShowConfirm] = useState(false)
  const [collectorName, setCollectorName] = useState('')
  const [reserving, setReserving] = useState(false)
  const [reserveError, setReserveError] = useState('')
  const [successInfo, setSuccessInfo] = useState(null) // { count, expiresAt, collectorName }

  // Live suggestions for the Payee field
  useEffect(() => {
    const term = payeeQuery.trim()
    if (!term) {
      setPayeeSuggestions([])
      setShowPayeeSuggestions(false)
      return
    }
    const handle = setTimeout(() => fetchSuggestions('payee', term), 200)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payeeQuery])

  // Live suggestions for the Payor field
  useEffect(() => {
    const term = payorQuery.trim()
    if (!term) {
      setPayorSuggestions([])
      setShowPayorSuggestions(false)
      return
    }
    const handle = setTimeout(() => fetchSuggestions('payor', term), 200)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payorQuery])

  useEffect(() => {
    if (!hasSearched) return
    fetchChecks(page, payeeQuery, payorQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  // Close each suggestions dropdown when clicking outside of it
  useEffect(() => {
    function handleClickOutside(e) {
      if (payeeBoxRef.current && !payeeBoxRef.current.contains(e.target)) {
        setShowPayeeSuggestions(false)
      }
      if (payorBoxRef.current && !payorBoxRef.current.contains(e.target)) {
        setShowPayorSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function fetchChecks(pageIndex, payeeTerm, payorTerm) {
    const payee = payeeTerm.trim()
    const payor = payorTerm.trim()

    if (!payee && !payor) {
      setRows([])
      setCount(0)
      setLoading(false)
      return
    }

    setLoading(true)
    setReserveError('')

    // Make sure any reservations that expired since the last load are
    // released back into the pool before we search, so results are fresh.
    await supabase.rpc('reclaim_expired_reservations')

    let req = supabase
      .from('checks')
      .select('id, row_number, payee, payor, check_date, amount', { count: 'exact' })
      .eq('status', 'available')
      .order('check_date', { ascending: false })
      .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1)

    if (payee) req = req.ilike('payee', `%${payee}%`)
    if (payor) req = req.ilike('payor', `%${payor}%`)

    const { data, count: total, error } = await req

    if (!error) {
      setRows(data || [])
      setCount(total || 0)
      // Drop any selections that fell off the current result set
      setSelectedIds((prev) => {
        const next = new Set()
        for (const row of data || []) {
          if (prev.has(row.id)) next.add(row.id)
        }
        return next
      })
    }
    setLoading(false)
  }

  async function fetchSuggestions(field, term) {
    const lowerTerm = term.toLowerCase()
    if (lowerTerm.length < SUGGESTION_MIN_CHARS) {
      if (field === 'payee') {
        setPayeeSuggestions([])
        setShowPayeeSuggestions(false)
      } else {
        setPayorSuggestions([])
        setShowPayorSuggestions(false)
      }
      return
    }

    const { data, error } = await supabase
      .from('checks')
      .select(field)
      .eq('status', 'available')
      .ilike(field, `%${lowerTerm}%`)
      .limit(20)

    if (!error) {
      const distinctNames = [...new Set((data || []).map((r) => r[field]))].slice(0, 6)
      if (field === 'payee') {
        setPayeeSuggestions(distinctNames)
        setShowPayeeSuggestions(distinctNames.length > 0)
      } else {
        setPayorSuggestions(distinctNames)
        setShowPayorSuggestions(distinctNames.length > 0)
      }
    }
  }

  function handleSearch() {
    // Both fields are required — searching only ever happens when the
    // button (or Enter, which triggers the same path) is used, never
    // automatically while typing or picking a suggestion.
    if (!payeeQuery.trim() || !payorQuery.trim()) return
    setShowPayeeSuggestions(false)
    setShowPayorSuggestions(false)
    setPage(0)
    setHasSearched(true)
    setSuccessInfo(null)
    fetchChecks(0, payeeQuery, payorQuery)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSearch()
    }
  }

  // Picking a suggestion only fills in the field — it no longer triggers a
  // search on its own. The person still has to click Check Availability
  // (or press Enter) once both fields are filled in.
  function selectPayeeSuggestion(name) {
    setPayeeQuery(name)
    setShowPayeeSuggestions(false)
  }

  function selectPayorSuggestion(name) {
    setPayorQuery(name)
    setShowPayorSuggestions(false)
  }

  function clearAll() {
    setPayeeQuery('')
    setPayorQuery('')
    setPayeeSuggestions([])
    setPayorSuggestions([])
    setShowPayeeSuggestions(false)
    setShowPayorSuggestions(false)
    setRows([])
    setCount(0)
    setHasSearched(false)
    setSelectedIds(new Set())
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      if (prev.size === rows.length && rows.length > 0) return new Set()
      return new Set(rows.map((r) => r.id))
    })
  }

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.has(r.id)),
    [rows, selectedIds]
  )

  function openConfirm() {
    if (selectedIds.size === 0) return
    setReserveError('')
    setShowConfirm(true)
  }

  async function confirmPickup() {
    if (!collectorName.trim()) {
      setReserveError('Please enter your name to continue.')
      return
    }
    setReserving(true)
    setReserveError('')

    const { data, error } = await supabase.rpc('create_reservation', {
      p_check_ids: Array.from(selectedIds),
      p_collector_name: collectorName.trim(),
    })

    setReserving(false)

    if (error) {
      setReserveError(error.message || 'Something went wrong. Please try again.')
      return
    }

    const result = Array.isArray(data) ? data[0] : data
    setSuccessInfo({
      count: selectedIds.size,
      expiresAt: result?.expires_at,
      collectorName: collectorName.trim(),
    })
    setShowConfirm(false)
    setSelectedIds(new Set())
    setCollectorName('')
    // Refresh the list so the reserved checks disappear from the pool
    fetchChecks(page, payeeQuery, payorQuery)
  }

  const totalPages = useMemo(() => Math.max(1, Math.ceil(count / PAGE_SIZE)), [count])
  // Both payee and payor need text before a search can run.
  const hasQueryText = !!(payeeQuery.trim() && payorQuery.trim())
  const allSelected = rows.length > 0 && selectedIds.size === rows.length

  return (
    <div className="min-h-screen bg-[#fbfaf8]">
      <RouteStyles />

      <div className="mx-auto max-w-6xl px-4 pb-32 pt-8 sm:px-6 sm:pt-10">
        <Hero />

        {successInfo && <SuccessManifest info={successInfo} onDismiss={() => setSuccessInfo(null)} />}

        {/* Search dock */}
        <div className="relative mb-8 max-w-2xl overflow-hidden rounded-2xl border border-teal-100 bg-white shadow-[0_1px_0_rgba(15,118,110,0.06)]">
          <div className="flex items-center gap-2 border-b border-dashed border-teal-100 bg-teal-700 px-5 py-2.5">
            <Search className="h-3.5 w-3.5 text-teal-200" />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal-100">
              Lookup terminal
            </span>
          </div>

          <div className="p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div ref={payeeBoxRef} className="relative flex-1">
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                  Payee
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-teal-400" />
                  <Input
                    value={payeeQuery}
                    onChange={(e) => setPayeeQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => payeeSuggestions.length > 0 && setShowPayeeSuggestions(true)}
                    placeholder="Payee name..."
                    className="border-slate-200 pl-10 pr-9 focus-visible:ring-teal-500"
                    aria-label="Search by payee"
                    autoComplete="off"
                  />
                  {payeeQuery && (
                    <button
                      onClick={() => {
                        setPayeeQuery('')
                        setPayeeSuggestions([])
                        setShowPayeeSuggestions(false)
                      }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-600"
                      aria-label="Clear payee search"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {showPayeeSuggestions && (
                  <div className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-md border border-teal-100 bg-white shadow-lg">
                    {payeeSuggestions.map((name) => (
                      <button
                        key={name}
                        onClick={() => selectPayeeSuggestion(name)}
                        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm text-slate-700 hover:bg-teal-50"
                      >
                        <Search className="h-3.5 w-3.5 shrink-0 text-teal-400" />
                        {name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div ref={payorBoxRef} className="relative flex-1">
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                  Payor
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-teal-400" />
                  <Input
                    value={payorQuery}
                    onChange={(e) => setPayorQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => payorSuggestions.length > 0 && setShowPayorSuggestions(true)}
                    placeholder="Payor name..."
                    className="border-slate-200 pl-10 pr-9 focus-visible:ring-teal-500"
                    aria-label="Search by payor"
                    autoComplete="off"
                  />
                  {payorQuery && (
                    <button
                      onClick={() => {
                        setPayorQuery('')
                        setPayorSuggestions([])
                        setShowPayorSuggestions(false)
                      }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-600"
                      aria-label="Clear payor search"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {showPayorSuggestions && (
                  <div className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-md border border-teal-100 bg-white shadow-lg">
                    {payorSuggestions.map((name) => (
                      <button
                        key={name}
                        onClick={() => selectPayorSuggestion(name)}
                        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm text-slate-700 hover:bg-teal-50"
                      >
                        <Search className="h-3.5 w-3.5 shrink-0 text-teal-400" />
                        {name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={handleSearch}
                disabled={!hasQueryText}
                className="group flex items-center gap-2 rounded-md bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-600 disabled:opacity-40 disabled:shadow-none"
              >
                Check Availability
                <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
              </button>
              {(payeeQuery || payorQuery) && (
                <button
                  onClick={clearAll}
                  className="rounded-md px-3 py-2.5 text-sm font-medium text-slate-500 hover:text-slate-700"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>

        {hasSearched && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-mono text-xs text-slate-500">
              {loading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-500" />
                  Searching manifest…
                </>
              ) : (
                <>
                  <Package className="h-3.5 w-3.5 text-teal-500" />
                  {count} check{count === 1 ? '' : 's'} available for pickup
                </>
              )}
            </span>
            {!loading && rows.length > 0 && (
              <button
                onClick={toggleSelectAll}
                className="flex items-center gap-1.5 rounded-md border border-teal-200 px-2.5 py-1.5 font-medium text-teal-700 hover:bg-teal-50"
              >
                <span
                  className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
                    allSelected ? 'border-teal-600 bg-teal-600' : 'border-slate-300 bg-white'
                  }`}
                >
                  {allSelected && <Check className="h-2.5 w-2.5 text-white" />}
                </span>
                {allSelected ? 'Deselect all' : `Select all on this page`}
              </button>
            )}
          </div>
        )}

        {!hasQueryText ? (
          <PromptState />
        ) : loading ? (
          <SkeletonList />
        ) : rows.length === 0 ? (
          <EmptyState hasQuery={hasQueryText} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => (
              <CheckStub
                key={row.id}
                row={row}
                selected={selectedIds.has(row.id)}
                onToggle={() => toggleSelected(row.id)}
              />
            ))}
          </div>
        )}

        {hasQueryText && totalPages > 1 && rows.length > 0 && (
          <div className="mt-8 flex items-center justify-center gap-2 font-mono text-xs text-slate-500">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded border border-slate-200 px-3 py-2 disabled:opacity-40"
            >
              Prev
            </button>
            <span>
              Page {page + 1} of {totalPages}
            </span>
            <button
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="rounded border border-slate-200 px-3 py-2 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-teal-800/20 bg-teal-800 px-4 py-3 shadow-[0_-8px_24px_rgba(15,118,110,0.25)]">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium text-teal-50">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white">
                {selectedIds.size}
              </span>
              check{selectedIds.size === 1 ? '' : 's'} loaded for pickup
            </span>
            <button
              onClick={openConfirm}
              className="flex items-center gap-2 rounded-md bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-600"
            >
              <Truck className="h-4 w-4" />
              Proceed to Pickup
            </button>
          </div>
        </div>
      )}

      {showConfirm && (
        <ConfirmModal
          rows={selectedRows}
          collectorName={collectorName}
          onCollectorNameChange={setCollectorName}
          onCancel={() => {
            setShowConfirm(false)
            setReserveError('')
          }}
          onConfirm={confirmPickup}
          reserving={reserving}
          error={reserveError}
        />
      )}
    </div>
  )
}

/* ---------------------------------------------------------------------- */
/* Presentational pieces                                                  */
/* ---------------------------------------------------------------------- */

// Shared keyframes for the hero route graphic and stamp micro-interactions.
// Scoped by unique class names so this never leaks into the rest of the app.
function RouteStyles() {
  return (
    <style>{`
      @media (prefers-reduced-motion: no-preference) {
        .route-dash { stroke-dasharray: 6 8; animation: route-travel 22s linear infinite; }
        @keyframes route-travel { to { stroke-dashoffset: -280; } }
        .route-truck { animation: route-bob 2.4s ease-in-out infinite; }
        @keyframes route-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
      }
      .stamp-pop { animation: stamp-pop 0.18s ease-out; }
      @keyframes stamp-pop { from { transform: scale(0.6) rotate(-14deg); opacity: 0; } to { transform: scale(1) rotate(-8deg); opacity: 1; } }
    `}</style>
  )
}

function Hero() {
  return (
    <div className="relative mb-8 overflow-hidden rounded-2xl border border-teal-100 bg-white sm:mb-10">
      <div className="grid grid-cols-1 md:grid-cols-[1.1fr_0.9fr]">
        <div className="px-5 py-7 sm:px-8 sm:py-9">
          <p className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.2em] text-teal-700">
            <Truck className="h-3.5 w-3.5" />
            Collector lookup — no sign-in required
          </p>
          <h1 className="mt-3 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
            Find a check
            <span className="relative mx-2 inline-block text-orange-500">
              waiting for pickup
              <svg
                viewBox="0 0 220 12"
                className="absolute -bottom-1 left-0 h-2.5 w-full text-orange-300"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  d="M2 8 C 40 2, 80 10, 120 5 C 150 1, 190 9, 218 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-500">
            Enter both a payee name and a payor name. Suggestions appear as you type — results
            only show once you press Enter or click Check Availability.
          </p>

          <StepStrip />
        </div>

        <RouteGraphic />
      </div>
    </div>
  )
}

function StepStrip() {
  const steps = [
    { icon: Search, label: 'Search' },
    { icon: Package, label: 'Select checks' },
    { icon: Truck, label: 'Pick up in 1hr' },
  ]
  return (
    <div className="mt-6 flex items-center gap-1.5">
      {steps.map((step, i) => (
        <React.Fragment key={step.label}>
          <div className="flex items-center gap-1.5 rounded-full border border-teal-100 bg-teal-50/70 px-2.5 py-1.5">
            <step.icon className="h-3.5 w-3.5 text-teal-600" />
            <span className="font-mono text-[11px] font-medium text-teal-800">{step.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className="h-px w-3 border-t border-dashed border-teal-300 sm:w-4" />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}

// Decorative route illustration — a delivery line from the issuing office to
// the pickup point. Hidden on small screens to keep the mobile hero tight.
function RouteGraphic() {
  return (
    <div className="relative hidden min-h-[220px] overflow-hidden bg-gradient-to-br from-teal-700 via-teal-700 to-teal-900 md:block">
      <div
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            'radial-gradient(circle, #fff 1px, transparent 1px)',
          backgroundSize: '14px 14px',
        }}
        aria-hidden="true"
      />
      <svg viewBox="0 0 320 220" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <path
          d="M40 60 C 100 30, 140 140, 200 120 S 280 60, 290 150"
          fill="none"
          stroke="#5eead4"
          strokeOpacity="0.55"
          strokeWidth="2.5"
          className="route-dash"
        />
      </svg>

      <div className="absolute left-8 top-10 flex flex-col items-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-md">
          <MapPin className="h-4.5 w-4.5 text-teal-700" />
        </span>
        <span className="mt-1.5 rounded-sm bg-teal-900/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-teal-100">
          Issuing office
        </span>
      </div>

      <div className="route-truck absolute left-[46%] top-[46%] flex h-9 w-9 items-center justify-center rounded-full bg-orange-500 shadow-lg">
        <Truck className="h-4.5 w-4.5 text-white" />
      </div>

      <div className="absolute bottom-8 right-8 flex flex-col items-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-orange-500 shadow-md">
          <Package className="h-4.5 w-4.5 text-white" />
        </span>
        <span className="mt-1.5 rounded-sm bg-teal-900/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-teal-100">
          Pickup point
        </span>
      </div>
    </div>
  )
}

function SuccessManifest({ info, onDismiss }) {
  return (
    <div className="stamp-pop mb-6 flex items-start gap-3 overflow-hidden rounded-xl border border-teal-200 bg-white shadow-sm">
      <div className="flex h-full items-center bg-teal-600 px-4 py-5 sm:px-5">
        <PackageCheck className="h-6 w-6 text-white" />
      </div>
      <div className="flex-1 py-4 pr-4 text-sm text-teal-900 sm:pr-5">
        <p className="font-semibold">
          {info.count} check{info.count === 1 ? '' : 's'} reserved for {info.collectorName}.
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-teal-700">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          Please pick {info.count === 1 ? 'it' : 'them'} up within 1 hour
          {info.expiresAt ? ` (by ${new Date(info.expiresAt).toLocaleTimeString()})` : ''}. If not
          picked up in time, the hold is released and these checks go back to the available pool.
        </p>
      </div>
      <button
        onClick={onDismiss}
        className="mr-3 mt-3 shrink-0 text-teal-400 hover:text-teal-700"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

function CheckStub({ row, selected, onToggle }) {
  const trackingNo = `CHK-${String(row.row_number ?? 0).padStart(6, '0')}`

  return (
    <Card
      onClick={onToggle}
      className={`relative cursor-pointer overflow-visible p-0 transition ${
        selected ? 'border-orange-400 ring-2 ring-orange-200' : 'border-slate-200 hover:border-teal-300'
      }`}
    >
      {selected && (
        <span className="stamp-pop absolute -right-2 -top-3 z-10 rotate-[-8deg] rounded-sm border-2 border-orange-500 bg-white px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-orange-600 shadow-sm">
          Selected
        </span>
      )}

      {/* Ticket header stub, perforated from the body */}
      <div className="relative flex items-center justify-between bg-teal-50/70 px-4 py-2.5">
        <span className="flex items-center gap-1.5 font-mono text-[11px] font-medium tracking-wide text-teal-700">
          <Hash className="h-3 w-3" />
          {trackingNo}
        </span>
        <span className="flex items-center gap-1 rounded-full border border-dashed border-teal-400 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-teal-700">
          <Package className="h-2.5 w-2.5" />
          Available
        </span>

        {/* Perforation line with punch-hole notches */}
        <div className="absolute -bottom-[1px] left-0 right-0 border-t border-dashed border-slate-300" />
        <span className="absolute -bottom-2 -left-2 h-4 w-4 rounded-full bg-white" aria-hidden="true" />
        <span className="absolute -bottom-2 -right-2 h-4 w-4 rounded-full bg-white" aria-hidden="true" />
      </div>

      <div className="p-4 pt-5">
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition ${
              selected ? 'border-orange-500 bg-orange-500' : 'border-slate-300 bg-white'
            }`}
          >
            {selected && <Check className="h-3.5 w-3.5 text-white" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[11px] uppercase tracking-widest text-slate-400">Payee</p>
            <p className="truncate text-lg font-semibold leading-snug text-slate-900">{row.payee}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-dashed border-slate-100 pt-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-400">Payor</p>
            <p className="truncate text-sm text-slate-700">{row.payor}</p>
          </div>
          <div>
            <p className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-slate-400">
              <CalendarDays className="h-3 w-3" /> Check Date
            </p>
            <p className="text-sm text-slate-700">{formatDate(row.check_date)}</p>
          </div>
        </div>
      </div>
    </Card>
  )
}

function ConfirmModal({
  rows,
  collectorName,
  onCollectorNameChange,
  onCancel,
  onConfirm,
  reserving,
  error,
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:rounded-xl">
        <div className="flex items-center justify-between bg-teal-700 px-5 py-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Truck className="h-4.5 w-4.5" />
            Confirm pickup
          </h2>
          <button onClick={onCancel} className="text-teal-200 hover:text-white" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-3 text-sm text-slate-500">
            You're about to reserve the following {rows.length} check{rows.length === 1 ? '' : 's'}.
            Once confirmed, they'll be held for you for <span className="font-medium text-slate-700">1 hour</span>.
            If they aren't picked up in that time, the hold is released automatically.
          </p>

          <ul className="mb-4 divide-y divide-dashed divide-slate-200 rounded-lg border border-slate-200">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-600">
                  <Package className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-900">{row.payee}</p>
                  <p className="truncate font-mono text-xs text-slate-400">
                    Payor: {row.payor} · CHK-{String(row.row_number ?? 0).padStart(6, '0')}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs text-slate-400">
                  {formatDate(row.check_date)}
                </span>
              </li>
            ))}
          </ul>

          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Your name
          </label>
          <Input
            value={collectorName}
            onChange={(e) => onCollectorNameChange(e.target.value)}
            placeholder="Enter your full name"
            className="border-slate-200 focus-visible:ring-teal-500"
            autoFocus
          />

          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            onClick={onCancel}
            disabled={reserving}
            className="rounded-md border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={reserving}
            className="flex items-center gap-2 rounded-md bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
          >
            {reserving && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm Pickup
          </button>
        </div>
      </div>
    </div>
  )
}

function SkeletonList() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-36 animate-pulse rounded-lg border border-slate-100 bg-slate-50" />
      ))}
    </div>
  )
}

function PromptState() {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-teal-200 bg-teal-50/40 px-4 py-16 text-center sm:py-20">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-teal-100">
        <Search className="h-6 w-6 text-teal-500" />
      </span>
      <p className="mt-3 text-lg font-semibold text-slate-700">Enter a payee and a payor to search</p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        Both fields are required. Fill in the payee and payor name above, then press Enter or
        click Check Availability.
      </p>
    </div>
  )
}

function EmptyState({ hasQuery }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-slate-200 px-4 py-16 text-center sm:py-20">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
        <Package className="h-6 w-6 text-slate-300" />
      </span>
      <p className="mt-3 text-lg font-semibold text-slate-700">
        {hasQuery ? 'No matching checks' : 'No checks available right now'}
      </p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        {hasQuery
          ? 'Try different names for the payee and payor fields.'
          : 'Once the admin uploads a file, checks awaiting pickup will appear here.'}
      </p>
    </div>
  )
}
