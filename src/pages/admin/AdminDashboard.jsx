import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Landmark,
  CircleCheckBig,
  Clock3,
  Wallet,
  Stamp,
  RefreshCw,
  ArrowUpRight,
  AlertTriangle,
  Hourglass,
  Flame,
  Timer,
  Layers,
  Users,
  BarChart3,
  TrendingUp,
  TrendingDown,
  ChevronRight,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Card, CardContent } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'

const DAY_MS = 86400000
const EXPIRING_SOON_MINUTES = 15
const TREND_DAYS = 14

const PERIOD_OPTIONS = [
  { value: '24h', label: '24h', longLabel: 'last 24 hours', days: 1 },
  { value: '7d', label: '7d', longLabel: 'last 7 days', days: 7 },
  { value: '30d', label: '30d', longLabel: 'last 30 days', days: 30 },
  { value: 'all', label: 'All', longLabel: 'all time', days: null },
]

const AGING_BUCKETS = [
  { key: '0-7', label: '0–7 days', test: (d) => d <= 7, tone: 'neutral' },
  { key: '8-14', label: '8–14 days', test: (d) => d > 7 && d <= 14, tone: 'neutral' },
  { key: '15-30', label: '15–30 days', test: (d) => d > 14 && d <= 30, tone: 'watch' },
  { key: '31-60', label: '31–60 days', test: (d) => d > 30 && d <= 60, tone: 'risk' },
  { key: '60+', label: '60+ days', test: (d) => d > 60, tone: 'critical' },
]

// Human-readable label used in error/debug output so a failed query is
// traceable to exactly which fetch broke, instead of one generic message.
const QUERY_LABELS = {
  snapshot: 'Awaiting-pickup snapshot (checks: available/reserved)',
  period: 'Picked-up checks for selected period',
  prevPeriod: 'Picked-up count for prior period (for delta badge)',
  trend: `Picked-up checks, last ${TREND_DAYS} days (trend)`,
  reservations: 'Active reservations',
  recent: 'Recent pickups',
}

export default function AdminDashboard() {
  const [period, setPeriod] = useState('7d')
  const [snapshotChecks, setSnapshotChecks] = useState([])
  const [periodPicked, setPeriodPicked] = useState([])
  const [previousPeriodCount, setPreviousPeriodCount] = useState(0)
  const [trendPicked, setTrendPicked] = useState([])
  const [activeReservations, setActiveReservations] = useState([])
  const [recent, setRecent] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  // Per-query errors, so a single failing query surfaces exactly which one
  // broke instead of a single vague banner (or, worse, nothing at all if the
  // query merely returned zero rows due to RLS rather than throwing).
  const [queryErrors, setQueryErrors] = useState([])
  const [lastUpdated, setLastUpdated] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [sessionReady, setSessionReady] = useState(false)
  const [noSessionWarning, setNoSessionWarning] = useState(false)

  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // IMPORTANT: on a hard refresh, supabase-js needs a moment to rehydrate
  // the session from storage. Firing queries before that finishes means
  // they run as an anonymous/unauthenticated request — Row Level Security
  // then silently returns zero rows for every query (no error thrown), and
  // the dashboard just looks "broken" with nothing to show for why. We wait
  // for getSession() to resolve at least once before running any query.
  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (cancelled) return
      if (sessionError) {
        console.error('[AdminDashboard] Failed to read auth session:', sessionError)
      }
      if (!data?.session) {
        console.warn(
          '[AdminDashboard] No active Supabase session found. Queries will run unauthenticated and RLS will likely return zero rows.'
        )
        setNoSessionWarning(true)
      }
      setSessionReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!sessionReady) return
    load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, sessionReady])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(tick)
  }, [])

  const load = useCallback(
    async (showFullLoading) => {
      if (showFullLoading) setLoading(true)
      else setRefreshing(true)
      setError('')
      setQueryErrors([])

      const activeOption = PERIOD_OPTIONS.find((o) => o.value === period) || PERIOD_OPTIONS[1]
      const periodStartIso =
        activeOption.days != null ? new Date(Date.now() - activeOption.days * DAY_MS).toISOString() : null
      const prevStartIso =
        activeOption.days != null
          ? new Date(Date.now() - activeOption.days * 2 * DAY_MS).toISOString()
          : null
      const trendStartIso = new Date(Date.now() - TREND_DAYS * DAY_MS).toISOString()

      try {
        const queries = [
          supabase
            .from('checks')
            .select('id, payee, check_no, amount, status, created_at, check_date')
            .in('status', ['available', 'reserved']),

          (() => {
            let q = supabase
              .from('checks')
              .select('id, amount, picked_up_by, picked_up_at')
              .eq('status', 'picked_up')
            if (periodStartIso) q = q.gte('picked_up_at', periodStartIso)
            return q
          })(),

          activeOption.days != null
            ? supabase
                .from('checks')
                .select('id', { count: 'exact', head: true })
                .eq('status', 'picked_up')
                .gte('picked_up_at', prevStartIso)
                .lt('picked_up_at', periodStartIso)
            : Promise.resolve({ count: 0, error: null, data: [] }),

          supabase
            .from('checks')
            .select('amount, picked_up_at')
            .eq('status', 'picked_up')
            .gte('picked_up_at', trendStartIso),

          // Explicit FK hint (checks!checks_reservation_id_fkey) rather than
          // the bare `checks(id, amount)` shorthand. If Postgres/PostgREST
          // ever sees more than one plausible relationship between these
          // two tables, the bare form throws "Could not embed because more
          // than one relationship was found" and this whole query fails —
          // naming the constraint explicitly removes that ambiguity.
          supabase
            .from('pickup_reservations')
            .select('id, collector_name, reserved_at, expires_at, checks!checks_reservation_id_fkey(id, amount)')
            .eq('status', 'reserved')
            .order('expires_at', { ascending: true })
            .limit(200),

          supabase
            .from('checks')
            .select('id, payee, check_no, amount, picked_up_by, picked_up_at')
            .eq('status', 'picked_up')
            .order('picked_up_at', { ascending: false })
            .limit(6),
        ]

        const keys = ['snapshot', 'period', 'prevPeriod', 'trend', 'reservations', 'recent']
        const results = await Promise.all(queries)

        if (!isMountedRef.current) return

        const errs = []
        results.forEach((res, i) => {
          if (res?.error) {
            const label = QUERY_LABELS[keys[i]] || keys[i]
            console.error(`[AdminDashboard] Query failed — ${label}:`, res.error)
            errs.push(`${label}: ${res.error.message || 'unknown error'}`)
          }
        })

        const [snapshotRes, periodRes, prevRes, trendRes, reservationsRes, recentRes] = results

        setSnapshotChecks(Array.isArray(snapshotRes?.data) ? snapshotRes.data : [])
        setPeriodPicked(Array.isArray(periodRes?.data) ? periodRes.data : [])
        setPreviousPeriodCount(prevRes?.count || 0)
        setTrendPicked(Array.isArray(trendRes?.data) ? trendRes.data : [])
        setActiveReservations(Array.isArray(reservationsRes?.data) ? reservationsRes.data : [])
        setRecent(recentRes?.data || [])
        setLastUpdated(new Date())

        if (errs.length > 0) {
          setQueryErrors(errs)
          setError(
            errs.length === keys.length
              ? 'All dashboard queries failed — likely a permissions (RLS) or connection issue. See details below.'
              : 'Some dashboard data failed to load. See details below.'
          )
        } else if (
          (snapshotRes?.data || []).length === 0 &&
          (periodRes?.data || []).length === 0 &&
          (reservationsRes?.data || []).length === 0 &&
          (recentRes?.data || []).length === 0
        ) {
          // No errors, but every single query came back empty — this is the
          // classic silent-RLS symptom. Flag it distinctly from "no error,
          // just a genuinely quiet register" so it doesn't get missed.
          console.warn(
            '[AdminDashboard] Every query succeeded but returned zero rows. If the `checks`/`pickup_reservations` tables are not actually empty, check RLS SELECT policies for the current user role.'
          )
        }
      } catch (err) {
        if (!isMountedRef.current) return
        console.error('[AdminDashboard] Unexpected error loading dashboard:', err)
        setError(err?.message || 'Failed to load the dashboard. Please try again.')
      } finally {
        if (isMountedRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [period]
  )

  // ---- Derived stats ----------------------------------------------------

  const available = useMemo(() => snapshotChecks.filter((c) => c.status === 'available'), [snapshotChecks])
  const reserved = useMemo(() => snapshotChecks.filter((c) => c.status === 'reserved'), [snapshotChecks])

  const availableAmount = useMemo(() => sumAmount(available), [available])
  const reservedAmount = useMemo(() => sumAmount(reserved), [reserved])

  const pickedCount = periodPicked.length
  const pickedAmount = useMemo(() => sumAmount(periodPicked), [periodPicked])
  const pickedDelta = useMemo(
    () => computeDelta(pickedCount, previousPeriodCount),
    [pickedCount, previousPeriodCount]
  )

  const reservationStats = useMemo(() => {
    const withTotals = activeReservations.map((r) => ({
      ...r,
      total: sumAmount(r.checks || []),
      checkCount: (r.checks || []).length,
      minutesLeft: r.expires_at ? Math.max(0, Math.round((new Date(r.expires_at).getTime() - now) / 60000)) : null,
    }))
    const expiringSoon = withTotals.filter(
      (r) => r.minutesLeft !== null && r.minutesLeft <= EXPIRING_SOON_MINUTES
    ).length
    return { list: withTotals, expiringSoon }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeReservations, now])

  const aging = useMemo(() => computeAging(available.concat(reserved)), [available, reserved])

  const trend = useMemo(() => buildTrend(trendPicked, TREND_DAYS), [trendPicked])

  const topCollectors = useMemo(() => buildTopCollectors(periodPicked, 5), [periodPicked])

  const activePeriodOption = PERIOD_OPTIONS.find((o) => o.value === period) || PERIOD_OPTIONS[1]

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-ledger-stamp/40 bg-ledger-stamp/10 text-ledger-stampDark">
            <Stamp className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ledger-stampDark/80">
              Register snapshot
            </p>
            <h1 className="font-display text-2xl font-semibold text-ink-900">Overview</h1>
            <p className="mt-1 text-sm text-ink-400">
              A snapshot of checks awaiting pickup, aging risk, and collector activity.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated && !loading && (
            <span className="hidden font-mono text-[11px] text-ink-300 sm:inline">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => load(false)}
            disabled={refreshing || loading}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {noSessionWarning && (
        <div className="mb-5 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No active Supabase session was detected when this page loaded. If you're logged in and still
            see this, your session may not have finished restoring — try refreshing. If it persists, the
            auth cookie/token may not be reaching the Supabase client.
          </span>
        </div>
      )}

      {error && (
        <div className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </span>
            <button
              onClick={() => load(loading)}
              className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
            >
              Retry
            </button>
          </div>
          {queryErrors.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-dashed border-red-200 pt-2 font-mono text-xs text-red-600">
              {queryErrors.map((msg, i) => (
                <li key={i}>• {msg}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!loading && aging.riskCount > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-ledger-amber/40 bg-ledger-amber/10 px-4 py-3 text-sm text-ink-800">
          <span className="flex items-center gap-2">
            <Flame className="h-4 w-4 shrink-0 text-ledger-amber" />
            <span>
              <span className="font-semibold">{aging.riskCount} check{aging.riskCount === 1 ? '' : 's'}</span>{' '}
              ({formatCurrency(aging.riskAmount)}) {aging.riskCount === 1 ? 'has' : 'have'} been waiting 30+ days
              for pickup.
            </span>
          </span>
          <Link
            to="/admin/checks"
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-ledger-stampDark hover:underline"
          >
            Review register
            <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      )}

      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-300">Key figures</p>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          icon={Clock3}
          label="Awaiting pickup"
          value={loading ? null : available.length}
          secondary={loading ? null : formatCurrency(availableAmount)}
          accent="stamp"
          to="/admin/checks"
        />
        <KpiCard
          icon={Layers}
          label="On hold (reserved)"
          value={loading ? null : reserved.length}
          secondary={loading ? null : formatCurrency(reservedAmount)}
          accent="amber"
          to="/admin/pickups"
        />
        <KpiCard
          icon={CircleCheckBig}
          label={`Picked up · ${activePeriodOption.label}`}
          value={loading ? null : pickedCount}
          secondary={loading ? null : formatCurrency(pickedAmount)}
          accent="ink"
          delta={period === 'all' ? null : pickedDelta}
        />
        <KpiCard
          icon={Timer}
          label="Expiring ≤ 15m"
          value={loading ? null : reservationStats.expiringSoon}
          secondary={loading ? null : `${activeReservations.length} active hold${activeReservations.length === 1 ? '' : 's'}`}
          accent={!loading && reservationStats.expiringSoon > 0 ? 'critical' : 'ink'}
          to="/admin/pickups"
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <AgingCard loading={loading} aging={aging} />
        <TrendCard loading={loading} trend={trend} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <ActiveReservationsCard loading={loading} reservations={reservationStats.list.slice(0, 6)} />
        <TopCollectorsCard loading={loading} collectors={topCollectors} periodLabel={activePeriodOption.longLabel} />
      </div>

      <SectionCard
        className="mt-5"
        icon={Stamp}
        title="Recent pickups"
        right={
          <Link
            to="/admin/checks"
            className="group flex items-center gap-1 text-xs font-medium text-ledger-stampDark hover:underline"
          >
            View register
            <ArrowUpRight className="h-3 w-3 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        }
      >
        {loading ? (
          <RecentSkeleton />
        ) : recent.length === 0 ? (
          <EmptyRecent />
        ) : (
          <div className="divide-y divide-dashed divide-ink-100">
            {recent.map((r) => (
              <RecentRow key={r.id} record={r} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  )
}

// ---- Data helpers ---------------------------------------------------------

function sumAmount(rows) {
  return (rows || []).reduce((s, r) => s + Number(r.amount || 0), 0)
}

function ageInDays(check) {
  const raw = check.created_at || check.check_date
  if (!raw) return null
  const ms = Date.now() - new Date(raw).getTime()
  if (Number.isNaN(ms)) return null
  return Math.max(0, Math.floor(ms / DAY_MS))
}

function computeAging(checks) {
  const buckets = AGING_BUCKETS.map((b) => ({ ...b, count: 0, amount: 0 }))
  let oldest = null

  checks.forEach((c) => {
    const days = ageInDays(c)
    if (days === null) return
    const bucket = buckets.find((b) => b.test(days))
    if (bucket) {
      bucket.count += 1
      bucket.amount += Number(c.amount || 0)
    }
    if (!oldest || days > oldest.days) {
      oldest = { days, payee: c.payee, checkNo: c.check_no }
    }
  })

  const riskBuckets = buckets.filter((b) => b.tone === 'risk' || b.tone === 'critical')
  const riskCount = riskBuckets.reduce((s, b) => s + b.count, 0)
  const riskAmount = riskBuckets.reduce((s, b) => s + b.amount, 0)
  const maxAmount = Math.max(1, ...buckets.map((b) => b.amount))
  const totalCount = checks.length
  const totalAmount = sumAmount(checks)

  return { buckets, oldest, riskCount, riskAmount, maxAmount, totalCount, totalAmount }
}

function buildTrend(picked, days) {
  const byDate = new Map()
  picked.forEach((c) => {
    if (!c.picked_up_at) return
    const key = new Date(c.picked_up_at).toISOString().slice(0, 10)
    byDate.set(key, (byDate.get(key) || 0) + 1)
  })

  const out = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * DAY_MS)
    const key = d.toISOString().slice(0, 10)
    out.push({
      date: key,
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      count: byDate.get(key) || 0,
    })
  }
  return out
}

function buildTopCollectors(picked, limit) {
  const map = new Map()
  picked.forEach((c) => {
    const name = c.picked_up_by || 'Unknown collector'
    const entry = map.get(name) || { name, count: 0, amount: 0 }
    entry.count += 1
    entry.amount += Number(c.amount || 0)
    map.set(name, entry)
  })
  return [...map.values()].sort((a, b) => b.amount - a.amount).slice(0, limit)
}

function computeDelta(curr, prev) {
  if (!prev) {
    if (!curr) return null
    return { pct: null, direction: 'up', isNew: true }
  }
  const pct = Math.round(((curr - prev) / prev) * 100)
  return { pct, direction: pct >= 0 ? 'up' : 'down', isNew: false }
}

function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?'
}

// ---- Presentational pieces -------------------------------------------------

function PeriodSelector({ value, onChange }) {
  return (
    <div className="flex gap-0.5 rounded-md border border-ink-200 bg-white p-0.5">
      {PERIOD_OPTIONS.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-2.5 py-1 font-mono text-[11px] font-medium transition',
            value === o.value ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-50'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SectionCard({ icon: Icon, title, subtitle, right, children, className }) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-dashed border-ink-100 bg-ink-50/50 px-5 py-3.5">
        <div>
          <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink-900">
            <Icon className="h-4 w-4 text-ledger-stampDark" />
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>}
        </div>
        {right}
      </div>
      <CardContent className="p-5">{children}</CardContent>
    </Card>
  )
}

function KpiCard({ icon: Icon, label, value, secondary, loading, accent, delta, to }) {
  const accents = {
    stamp: { badge: 'bg-ledger-stamp/10 text-ledger-stampDark', ring: 'border-ledger-stamp/30' },
    amber: { badge: 'bg-ledger-amber/10 text-ledger-amber', ring: 'border-ledger-amber/30' },
    ink: { badge: 'bg-ink-50 text-ink-700', ring: 'border-ink-100' },
    critical: { badge: 'bg-red-50 text-red-600', ring: 'border-red-200' },
  }
  const style = accents[accent] || accents.ink
  const isLoading = value === null || value === undefined

  const content = (
    <CardContent className="relative overflow-hidden p-4">
      <div
        className={cn(
          'pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed',
          style.ring
        )}
        aria-hidden="true"
      />

      <div className="relative flex items-start gap-3">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', style.badge)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-6 w-16 animate-pulse rounded bg-ink-100" />
          ) : (
            <div className="flex items-center gap-2">
              <p className="truncate font-display text-lg font-semibold text-ink-900">{value}</p>
              {delta && !delta.isNew && delta.pct !== null && (
                <span
                  className={cn(
                    'flex items-center gap-0.5 text-[11px] font-medium',
                    delta.direction === 'up' ? 'text-ledger-stampDark' : 'text-ink-400'
                  )}
                >
                  {delta.direction === 'up' ? (
                    <TrendingUp className="h-3 w-3" />
                  ) : (
                    <TrendingDown className="h-3 w-3" />
                  )}
                  {Math.abs(delta.pct)}%
                </span>
              )}
              {delta && delta.isNew && (
                <span className="text-[11px] font-medium text-ledger-stampDark">new</span>
              )}
            </div>
          )}
          <p className="truncate text-xs text-ink-400">{label}</p>
          {!isLoading && secondary && (
            <p className="mt-0.5 truncate font-mono text-xs text-ink-500">{secondary}</p>
          )}
        </div>
      </div>
    </CardContent>
  )

  if (to) {
    return (
      <Card className="transition hover:border-ink-200 hover:shadow-sm">
        <Link to={to}>{content}</Link>
      </Card>
    )
  }
  return <Card>{content}</Card>
}

function AgingCard({ loading, aging }) {
  return (
    <SectionCard
      icon={Hourglass}
      title="Aging register"
      subtitle="How long checks have been waiting, since they were added."
    >
      {loading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-ink-50" />
          ))}
        </div>
      ) : aging.totalCount === 0 ? (
        <p className="py-6 text-center text-sm text-ink-400">Nothing awaiting pickup right now.</p>
      ) : (
        <>
          <div className="space-y-2.5">
            {aging.buckets.map((b) => (
              <div key={b.key} className="flex items-center gap-3">
                <span className="w-16 shrink-0 font-mono text-[11px] text-ink-400">{b.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-50">
                  <div
                    className={cn(
                      'h-full rounded-full',
                      b.tone === 'critical'
                        ? 'bg-red-400'
                        : b.tone === 'risk'
                        ? 'bg-ledger-amber'
                        : b.tone === 'watch'
                        ? 'bg-ledger-amber/50'
                        : 'bg-ink-300'
                    )}
                    style={{ width: `${b.amount > 0 ? Math.max(4, (b.amount / aging.maxAmount) * 100) : 0}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right font-mono text-xs text-ink-600">{b.count}</span>
                <span className="w-20 shrink-0 text-right font-mono text-xs text-ink-400">
                  {formatCurrency(b.amount)}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-ink-100 pt-3 text-xs">
            <span className="text-ink-400">
              {aging.totalCount} checks · {formatCurrency(aging.totalAmount)} total
            </span>
            {aging.oldest && (
              <span className="text-ink-500">
                Oldest: <span className="font-medium text-ink-700">{aging.oldest.days} days</span>
                {aging.oldest.payee ? ` · ${aging.oldest.payee}` : ''}
                {aging.oldest.checkNo ? ` · #${aging.oldest.checkNo}` : ''}
              </span>
            )}
          </div>
        </>
      )}
    </SectionCard>
  )
}

function TrendCard({ loading, trend }) {
  const max = Math.max(1, ...trend.map((d) => d.count))
  const total = trend.reduce((s, d) => s + d.count, 0)

  return (
    <SectionCard
      icon={BarChart3}
      title="Pickup activity"
      subtitle={`Checks picked up per day, last ${TREND_DAYS} days.`}
    >
      {loading ? (
        <div className="h-32 animate-pulse rounded bg-ink-50" />
      ) : (
        <>
          <div className="flex h-32 items-end gap-1.5">
            {trend.map((d) => (
              <div key={d.date} className="flex flex-1 flex-col items-center gap-1" title={`${d.label}: ${d.count}`}>
                <div className="flex h-24 w-full items-end overflow-hidden rounded-t bg-ink-50">
                  <div
                    className={cn('w-full rounded-t', d.count > 0 ? 'bg-ledger-stamp/60' : 'bg-transparent')}
                    style={{ height: `${d.count > 0 ? Math.max(6, (d.count / max) * 100) : 0}%` }}
                  />
                </div>
                <span className="font-mono text-[9px] text-ink-300">{d.label.split(' ')[1]}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-400">
            <span className="font-medium text-ink-700">{total}</span> picked up in the last {TREND_DAYS} days
          </p>
        </>
      )}
    </SectionCard>
  )
}

function ActiveReservationsCard({ loading, reservations }) {
  return (
    <SectionCard
      icon={Layers}
      title="Active reservations"
      subtitle="Orders currently on hold for collectors."
      right={
        <Link
          to="/admin/pickups"
          className="group flex items-center gap-1 text-xs font-medium text-ledger-stampDark hover:underline"
        >
          View all
          <ArrowUpRight className="h-3 w-3 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </Link>
      }
    >
      {loading ? (
        <RecentSkeleton />
      ) : reservations.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-400">No active reservations right now.</p>
      ) : (
        <div className="divide-y divide-dashed divide-ink-100">
          {reservations.map((r) => {
            const urgent = r.minutesLeft !== null && r.minutesLeft <= EXPIRING_SOON_MINUTES
            return (
              <div key={r.id} className="flex items-center gap-3 py-3 text-sm">
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold',
                    urgent ? 'bg-red-50 text-red-600' : 'bg-ledger-stamp/10 text-ledger-stampDark'
                  )}
                >
                  {initials(r.collector_name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink-800">
                    {r.collector_name || 'Unknown collector'}
                  </p>
                  <p className="truncate font-mono text-xs text-ink-300">
                    {r.checkCount} check{r.checkCount === 1 ? '' : 's'} · {formatCurrency(r.total)}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 font-mono text-xs font-medium',
                    urgent ? 'text-red-600' : 'text-ink-500'
                  )}
                >
                  {r.minutesLeft === null ? '—' : `${r.minutesLeft}m left`}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </SectionCard>
  )
}

function TopCollectorsCard({ loading, collectors, periodLabel }) {
  return (
    <SectionCard icon={Users} title="Top collectors" subtitle={`By value picked up, ${periodLabel}.`}>
      {loading ? (
        <RecentSkeleton />
      ) : collectors.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-400">No pickups in this period.</p>
      ) : (
        <div className="divide-y divide-dashed divide-ink-100">
          {collectors.map((c, idx) => (
            <div key={c.name} className="flex items-center gap-3 py-3 text-sm">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-ink-200 font-mono text-[11px] text-ink-400">
                {idx + 1}
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-50 font-mono text-[10px] font-semibold text-ink-600">
                {initials(c.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink-800">{c.name}</p>
                <p className="font-mono text-xs text-ink-300">
                  {c.count} check{c.count === 1 ? '' : 's'}
                </p>
              </div>
              <span className="shrink-0 font-mono text-sm font-medium text-ink-800">
                {formatCurrency(c.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function RecentRow({ record }) {
  return (
    <div className="flex items-center gap-3 py-3 text-sm">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ledger-stamp/10 text-ledger-stampDark">
        <CircleCheckBig className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink-800">{record.payee || 'Unknown payee'}</p>
        <p className="truncate font-mono text-xs text-ink-300">
          Check #{record.check_no || '—'} · picked up by {record.picked_up_by || 'unknown collector'}
        </p>
      </div>

      <div className="hidden flex-1 border-b border-dotted border-ink-200 sm:block" aria-hidden="true" />

      <div className="shrink-0 text-right">
        <p className="font-mono font-medium text-ink-800">{formatCurrency(record.amount)}</p>
        <p className="text-xs text-ink-300">
          {record.picked_up_at ? formatDate(record.picked_up_at) : '—'}
        </p>
      </div>
    </div>
  )
}

function RecentSkeleton() {
  return (
    <div className="divide-y divide-dashed divide-ink-100">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 py-3">
          <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-ink-100" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-32 animate-pulse rounded bg-ink-100" />
            <div className="h-3 w-48 animate-pulse rounded bg-ink-50" />
          </div>
          <div className="space-y-1.5 text-right">
            <div className="ml-auto h-3.5 w-16 animate-pulse rounded bg-ink-100" />
            <div className="ml-auto h-3 w-12 animate-pulse rounded bg-ink-50" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyRecent() {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-ink-200 text-ink-300">
        <Stamp className="h-5 w-5" />
      </span>
      <p className="mt-3 text-sm font-medium text-ink-600">No pickups recorded yet</p>
      <p className="mt-1 max-w-xs text-xs text-ink-300">
        Once a collector picks up a check, it'll be stamped into the register here.
      </p>
    </div>
  )
}
