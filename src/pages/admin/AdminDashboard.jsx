import React, { useCallback, useEffect, useRef, useState } from 'react'
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
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Card, CardContent } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'

export default function AdminDashboard() {
  const [stats, setStats] = useState(null)
  const [recent, setRecent] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)

  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(async (showFullLoading) => {
    if (showFullLoading) setLoading(true)
    else setRefreshing(true)
    setError('')

    try {
      const [availableRes, pickedRes, recentRes] = await Promise.all([
        supabase.from('checks').select('amount', { count: 'exact' }).eq('status', 'available'),
        supabase.from('checks').select('amount', { count: 'exact' }).eq('status', 'picked_up'),
        supabase
          .from('checks')
          .select('id, payee, check_no, amount, picked_up_by, picked_up_at')
          .eq('status', 'picked_up')
          .order('picked_up_at', { ascending: false })
          .limit(6),
      ])

      if (!isMountedRef.current) return

      const firstError = availableRes.error || pickedRes.error || recentRes.error
      if (firstError) {
        setError(firstError.message || 'Failed to load the dashboard. Please try again.')
        return
      }

      const availableAmount = (availableRes.data || []).reduce((s, r) => s + Number(r.amount || 0), 0)
      const pickedAmount = (pickedRes.data || []).reduce((s, r) => s + Number(r.amount || 0), 0)

      setStats({
        availableCount: availableRes.count || 0,
        pickedCount: pickedRes.count || 0,
        availableAmount,
        pickedAmount,
      })
      setRecent(recentRes.data || [])
      setLastUpdated(new Date())
    } catch (err) {
      if (!isMountedRef.current) return
      setError(err?.message || 'Failed to load the dashboard. Please try again.')
    } finally {
      if (isMountedRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

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
              A snapshot of checks awaiting pickup and recent collector activity.
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

      {error && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Clock3}
          label="Awaiting pickup"
          value={stats ? stats.availableCount : null}
          loading={loading}
          accent="stamp"
        />
        <StatCard
          icon={CircleCheckBig}
          label="Picked up"
          value={stats ? stats.pickedCount : null}
          loading={loading}
          accent="ink"
        />
        <StatCard
          icon={Wallet}
          label="Value awaiting pickup"
          value={stats ? formatCurrency(stats.availableAmount) : null}
          loading={loading}
          accent="amber"
        />
        <StatCard
          icon={Landmark}
          label="Value picked up"
          value={stats ? formatCurrency(stats.pickedAmount) : null}
          loading={loading}
          accent="ink"
        />
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-dashed border-ink-100 bg-ink-50/50 px-5 py-3.5">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink-900">
            <Stamp className="h-4 w-4 text-ledger-stampDark" />
            Recent pickups
          </h2>
          <Link
            to="/admin/checks"
            className="group flex items-center gap-1 text-xs font-medium text-ledger-stampDark hover:underline"
          >
            View register
            <ArrowUpRight className="h-3 w-3 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        </div>

        <CardContent className="p-5">
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
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, loading, accent }) {
  const accents = {
    stamp: {
      badge: 'bg-ledger-stamp/10 text-ledger-stampDark',
      ring: 'border-ledger-stamp/30',
    },
    amber: {
      badge: 'bg-ledger-amber/10 text-ledger-amber',
      ring: 'border-ledger-amber/30',
    },
    ink: {
      badge: 'bg-ink-50 text-ink-700',
      ring: 'border-ink-100',
    },
  }
  const style = accents[accent] || accents.ink

  return (
    <Card>
      <CardContent className="relative overflow-hidden p-4">
        {/* Faint stamp-ring watermark in the corner, echoing the ledger motif */}
        <div
          className={cn(
            'pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed',
            style.ring
          )}
          aria-hidden="true"
        />

        <div className="relative flex items-center gap-3">
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', style.badge)}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            {loading || value === null || value === undefined ? (
              <div className="h-6 w-16 animate-pulse rounded bg-ink-100" />
            ) : (
              <p className="truncate font-display text-lg font-semibold text-ink-900">{value}</p>
            )}
            <p className="truncate text-xs text-ink-400">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
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

      {/* Dotted ledger leader, only where there's room */}
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
