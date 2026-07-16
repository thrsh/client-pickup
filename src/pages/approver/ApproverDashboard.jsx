// src/pages/approver/ApproverDashboard.jsx
//
// Overview page for the approver area — mirrors the structure and "ledger"
// visual identity of AdminDashboard.jsx, but the KPIs are about the
// approval queue itself: what's waiting on you, how fast you're clearing
// it, how it's trending, and (new) who's driving the numbers — instead of
// pickup/collection activity.
//
// Decision history (approved/rejected) does NOT live on `checks` — that
// table only tracks the current state (approved_by/approved_at reflect the
// latest approval, and there's no 'rejected' value in its status check
// constraint). The actual per-decision record, including rejections, is
// `check_activity_log` (action = 'approved' | 'rejected'), joined back to
// `checks` for payee/check_no/amount. See flattenDecisionRow() below.
//
// Layout:
//   1. Key figures        — primary KPI row (queue size, approved, rejected, avg time)
//   2. Insights           — secondary KPI row (approval rate, SLA, top approver, largest pending)
//   3. Wait breakdown + decision trend
//   4. Top submitters + approver leaderboard
//   5. Rejection reasons + recent decisions
//
// The KpiCard component below is the shared template for any future
// approver/admin page — icon badge, accent ring, optional delta pill,
// optional link-through. Reuse it rather than hand-rolling new stat cards.
//
// Access: gated at the route level by <RequireRole roles={['approver','admin']}>
// (see App.jsx), plus an in-component check here as defense-in-depth.
// Real enforcement is the RLS policies on `checks` / `check_activity_log`
// and the approver_decide RPC — see fix_profiles_rls.sql for the pattern.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Stamp,
  RefreshCw,
  ArrowUpRight,
  AlertTriangle,
  Hourglass,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Timer,
  Users,
  BarChart3,
  TrendingUp,
  TrendingDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Percent,
  Target,
  Award,
  Banknote,
  MessageSquareWarning,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Card, CardContent } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import { useProfile, hasRole } from '../../context/ProfileContext'

const DAY_MS = 86400000
const HOUR_MS = 3600000
const URGENT_WAIT_HOURS = 24
const TREND_DAYS = 14
const SLA_TARGET_HOURS = 24
const ALLOWED_ROLES = ['approver', 'admin']

const PERIOD_OPTIONS = [
  { value: '24h', label: '24h', longLabel: 'last 24 hours', days: 1 },
  { value: '7d', label: '7d', longLabel: 'last 7 days', days: 7 },
  { value: '30d', label: '30d', longLabel: 'last 30 days', days: 30 },
  { value: 'all', label: 'All', longLabel: 'all time', days: null },
]

// How long checks have been sitting in the queue waiting on a decision.
// Ordered least → most overdue; approvals should move much faster than
// pickup aging, so the thresholds are hours, not days.
const WAIT_BUCKETS = [
  { key: '0-1', label: '< 1 hour', test: (h) => h < 1, tone: 'neutral' },
  { key: '1-4', label: '1–4 hours', test: (h) => h >= 1 && h < 4, tone: 'neutral' },
  { key: '4-24', label: '4–24 hours', test: (h) => h >= 4 && h < 24, tone: 'watch' },
  { key: '24-72', label: '1–3 days', test: (h) => h >= 24 && h < 72, tone: 'risk' },
  { key: '72+', label: '3+ days', test: (h) => h >= 72, tone: 'critical' },
]

export default function ApproverDashboard() {
  const { role, name, loading: profileLoading, error: profileError } = useProfile()
  const authorized = hasRole(role, ALLOWED_ROLES)

  const [period, setPeriod] = useState('7d')
  const [pendingChecks, setPendingChecks] = useState([])
  const [decidedPeriod, setDecidedPeriod] = useState([])
  const [prevPeriodApproved, setPrevPeriodApproved] = useState(0)
  const [prevPeriodRejected, setPrevPeriodRejected] = useState(0)
  const [decidedTrend, setDecidedTrend] = useState([])
  const [recentDecisions, setRecentDecisions] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)
  const [now, setNow] = useState(Date.now())

  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!profileLoading && authorized) load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, profileLoading, authorized])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(tick)
  }, [])

  const load = useCallback(
    async (showFullLoading) => {
      if (showFullLoading) setLoading(true)
      else setRefreshing(true)
      setError('')

      const activeOption = PERIOD_OPTIONS.find((o) => o.value === period) || PERIOD_OPTIONS[1]
      const periodStartIso =
        activeOption.days != null ? new Date(Date.now() - activeOption.days * DAY_MS).toISOString() : null
      const prevStartIso =
        activeOption.days != null ? new Date(Date.now() - activeOption.days * 2 * DAY_MS).toISOString() : null
      const trendStartIso = new Date(Date.now() - TREND_DAYS * DAY_MS).toISOString()

      try {
        const queries = [
          // Everything currently waiting on a decision — powers the
          // wait-time breakdown, the top KPI cards, top submitters, and
          // the "largest pending check" insight.
          supabase
            .from('checks')
            .select('id, payee, check_no, amount, submitted_at, submitted_by_name')
            .eq('status', 'pending_approval'),

          // Decided within the selected period, for the KPI cards, the
          // avg-time-to-decision stat, rejection rate, approval rate, SLA
          // compliance, the approver leaderboard, and rejection reasons.
          // Joins back to `checks` for payee/check_no/amount/submitted_at —
          // the log row itself only has the check_id and what happened.
          (() => {
            let q = supabase
              .from('check_activity_log')
              .select('id, action, performed_at, remarks, approved_by_name, checks(payee, check_no, amount, submitted_at)')
              .in('action', ['approved', 'rejected'])
            if (periodStartIso) q = q.gte('performed_at', periodStartIso)
            return q
          })(),

          // Decided during the equivalent prior window, broken out by
          // action so we can show both a raw-volume delta and an
          // approval-rate delta, not just a total-count delta.
          activeOption.days != null
            ? supabase
                .from('check_activity_log')
                .select('action')
                .in('action', ['approved', 'rejected'])
                .gte('performed_at', prevStartIso)
                .lt('performed_at', periodStartIso)
            : Promise.resolve({ data: [], error: null }),

          // Fixed 14-day window for the approved/rejected trend chart,
          // independent of the period selector so the shape stays
          // comparable regardless of what's selected above. No join
          // needed here — only counts per day/action are used.
          supabase
            .from('check_activity_log')
            .select('action, performed_at')
            .in('action', ['approved', 'rejected'])
            .gte('performed_at', trendStartIso),

          // Latest decisions, always absolute-recent regardless of period.
          supabase
            .from('check_activity_log')
            .select('id, action, performed_at, remarks, approved_by_name, checks(payee, check_no, amount)')
            .in('action', ['approved', 'rejected'])
            .order('performed_at', { ascending: false })
            .limit(6),
        ]

        const [pendingRes, decidedRes, prevRes, trendRes, recentRes] = await Promise.all(queries)

        if (!isMountedRef.current) return

        const firstError = pendingRes.error || decidedRes.error || prevRes.error || trendRes.error || recentRes.error
        if (firstError) {
          const isAuthError = firstError.code === 'PGRST301' || /permission|policy/i.test(firstError.message || '')
          setError(
            isAuthError
              ? "You don't have permission to view this dashboard. Contact an admin if this seems wrong."
              : firstError.message || 'Failed to load the dashboard. Please try again.'
          )
          return
        }

        const prevRows = Array.isArray(prevRes.data) ? prevRes.data : []

        setPendingChecks(Array.isArray(pendingRes.data) ? pendingRes.data : [])
        setDecidedPeriod((decidedRes.data || []).map(flattenDecisionRow))
        setPrevPeriodApproved(prevRows.filter((r) => r.action === 'approved').length)
        setPrevPeriodRejected(prevRows.filter((r) => r.action === 'rejected').length)
        setDecidedTrend(Array.isArray(trendRes.data) ? trendRes.data : [])
        setRecentDecisions((recentRes.data || []).map(flattenDecisionRow))
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
    },
    [period]
  )

  // ---- Derived stats ----------------------------------------------------

  const pendingAmount = useMemo(() => sumAmount(pendingChecks), [pendingChecks])

  const approvedPeriod = useMemo(() => decidedPeriod.filter((c) => c.decision === 'approved'), [decidedPeriod])
  const rejectedPeriod = useMemo(() => decidedPeriod.filter((c) => c.decision === 'rejected'), [decidedPeriod])
  const approvedAmount = useMemo(() => sumAmount(approvedPeriod), [approvedPeriod])
  const rejectedAmount = useMemo(() => sumAmount(rejectedPeriod), [rejectedPeriod])

  const decidedCount = decidedPeriod.length
  const prevDecidedCount = prevPeriodApproved + prevPeriodRejected
  const decidedDelta = useMemo(
    () => computeDelta(decidedCount, prevDecidedCount),
    [decidedCount, prevDecidedCount]
  )

  const rejectionRate = decidedCount > 0 ? Math.round((rejectedPeriod.length / decidedCount) * 100) : null

  const avgDecisionHours = useMemo(() => {
    const withBoth = decidedPeriod.filter((c) => c.submitted_at && c.decided_at)
    if (withBoth.length === 0) return null
    const totalMs = withBoth.reduce(
      (s, c) => s + (new Date(c.decided_at).getTime() - new Date(c.submitted_at).getTime()),
      0
    )
    return totalMs / withBoth.length / HOUR_MS
  }, [decidedPeriod])

  // Approval rate — share of decisions in the period that were approvals,
  // plus a point-delta against the prior equivalent window.
  const approvalRate = useMemo(() => computeApprovalRate(approvedPeriod.length, decidedCount), [
    approvedPeriod.length,
    decidedCount,
  ])
  const prevApprovalRate = useMemo(
    () => computeApprovalRate(prevPeriodApproved, prevDecidedCount),
    [prevPeriodApproved, prevDecidedCount]
  )
  const approvalRateDelta = useMemo(() => {
    if (approvalRate === null || prevApprovalRate === null) return null
    const diff = approvalRate - prevApprovalRate
    return { pct: diff, direction: diff >= 0 ? 'up' : 'down', isNew: false }
  }, [approvalRate, prevApprovalRate])

  // SLA compliance — share of decisions made within the target turnaround.
  const slaCompliance = useMemo(() => computeSlaCompliance(decidedPeriod, SLA_TARGET_HOURS), [decidedPeriod])

  // Approver leaderboard — who's clearing the queue, and how their
  // approve/reject split looks, for this period.
  const approverLeaderboard = useMemo(() => buildApproverLeaderboard(decidedPeriod, 5), [decidedPeriod])
  const topApprover = approverLeaderboard[0] || null

  // Most common rejection remarks, so patterns in why checks bounce are
  // visible at a glance instead of buried in the activity log.
  const rejectionReasons = useMemo(() => buildRejectionReasons(rejectedPeriod, 5), [rejectedPeriod])

  const largestPending = useMemo(() => findLargestPending(pendingChecks), [pendingChecks])

  const waitBreakdown = useMemo(() => computeWaitBreakdown(pendingChecks, now), [pendingChecks, now])

  const trend = useMemo(() => buildDecisionTrend(decidedTrend, TREND_DAYS), [decidedTrend])

  const topSubmitters = useMemo(() => buildTopSubmitters(pendingChecks, now, 5), [pendingChecks, now])

  const activePeriodOption = PERIOD_OPTIONS.find((o) => o.value === period) || PERIOD_OPTIONS[1]

  if (profileLoading) {
    return <div className="flex min-h-[40vh] items-center justify-center text-sm text-ink-300">Loading…</div>
  }

  if (profileError) {
    return <ProfileLoadError error={profileError} />
  }

  if (!authorized) {
    return <AccessDenied />
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-ledger-stamp/40 bg-ledger-stamp/10 text-ledger-stampDark">
            <Stamp className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ledger-stampDark/80">
              Approval queue snapshot
            </p>
            <h1 className="font-display text-2xl font-semibold text-ink-900">Overview</h1>
            <p className="mt-1 text-sm text-ink-400">
              {name ? `Welcome back, ${name}. ` : ''}What's waiting on you, how fast it's moving, and
              how the queue is trending.
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

      {!loading && waitBreakdown.overdueCount > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-ink-800">
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-red-500" />
            <span>
              <span className="font-semibold">{waitBreakdown.overdueCount} check{waitBreakdown.overdueCount === 1 ? '' : 's'}</span>{' '}
              ({formatCurrency(waitBreakdown.overdueAmount)}) {waitBreakdown.overdueCount === 1 ? 'has' : 'have'} been
              waiting {URGENT_WAIT_HOURS}+ hours for a decision.
            </span>
          </span>
          <Link
            to="/approver/pending"
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-red-700 hover:underline"
          >
            Review queue
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
          icon={Hourglass}
          label="Awaiting your decision"
          value={loading ? null : pendingChecks.length}
          secondary={loading ? null : formatCurrency(pendingAmount)}
          accent="stamp"
          to="/approver/pending"
        />
        <KpiCard
          icon={CheckCircle2}
          label={`Approved · ${activePeriodOption.label}`}
          value={loading ? null : approvedPeriod.length}
          secondary={loading ? null : formatCurrency(approvedAmount)}
          accent="ink"
        />
        <KpiCard
          icon={XCircle}
          label={`Rejected · ${activePeriodOption.label}`}
          value={loading ? null : rejectedPeriod.length}
          secondary={loading ? null : rejectionRate !== null ? `${rejectionRate}% of decisions` : formatCurrency(rejectedAmount)}
          accent={!loading && rejectionRate !== null && rejectionRate >= 25 ? 'critical' : 'amber'}
        />
        <KpiCard
          icon={Timer}
          label="Avg. time to decision"
          value={loading ? null : avgDecisionHours === null ? '—' : formatHours(avgDecisionHours)}
          secondary={loading ? null : `${decidedCount} decision${decidedCount === 1 ? '' : 's'} · ${activePeriodOption.longLabel}`}
          accent="ink"
          delta={period === 'all' ? null : decidedDelta}
        />
      </div>

      <div className="mb-2 mt-6 flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-300">Insights</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          icon={Percent}
          label="Approval rate"
          value={loading ? null : approvalRate === null ? '—' : `${approvalRate}%`}
          secondary={loading ? null : `${approvedPeriod.length} of ${decidedCount} decision${decidedCount === 1 ? '' : 's'}`}
          accent={
            !loading && approvalRate !== null
              ? approvalRate < 70
                ? 'critical'
                : approvalRate < 90
                ? 'amber'
                : 'stamp'
              : 'ink'
          }
          delta={period === 'all' ? null : approvalRateDelta}
          deltaUnit="pts"
        />
        <KpiCard
          icon={Target}
          label={`SLA compliance · ${SLA_TARGET_HOURS}h`}
          value={loading ? null : slaCompliance === null ? '—' : `${slaCompliance.pct}%`}
          secondary={
            loading
              ? null
              : slaCompliance
              ? `${slaCompliance.within} of ${slaCompliance.total} within target`
              : 'No data yet'
          }
          accent={
            !loading && slaCompliance !== null
              ? slaCompliance.pct < 70
                ? 'critical'
                : slaCompliance.pct < 90
                ? 'amber'
                : 'ink'
              : 'ink'
          }
        />
        <KpiCard
          icon={Award}
          label={`Top approver · ${activePeriodOption.label}`}
          value={loading ? null : topApprover ? topApprover.name : '—'}
          secondary={
            loading
              ? null
              : topApprover
              ? `${topApprover.total} decision${topApprover.total === 1 ? '' : 's'} · ${topApprover.approved} approved / ${topApprover.rejected} rejected`
              : 'No decisions yet'
          }
          accent="ink"
        />
        <KpiCard
          icon={Banknote}
          label="Largest pending check"
          value={loading ? null : largestPending ? formatCurrency(Number(largestPending.amount || 0)) : '—'}
          secondary={
            loading
              ? null
              : largestPending
              ? `${largestPending.payee || 'Unknown payee'}${largestPending.check_no ? ` · #${largestPending.check_no}` : ''}`
              : 'Nothing pending'
          }
          accent="stamp"
          to="/approver/pending"
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <WaitBreakdownCard loading={loading} breakdown={waitBreakdown} />
        <TrendCard loading={loading} trend={trend} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <TopSubmittersCard loading={loading} submitters={topSubmitters} />
        <ApproverLeaderboardCard loading={loading} leaderboard={approverLeaderboard} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <RejectionReasonsCard loading={loading} reasons={rejectionReasons} totalRejected={rejectedPeriod.length} />
        <SectionCard
          icon={Stamp}
          title="Recent decisions"
          right={
            <Link
              to="/approver/history"
              className="group flex items-center gap-1 text-xs font-medium text-ledger-stampDark hover:underline"
            >
              View history
              <ArrowUpRight className="h-3 w-3 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
          }
        >
          {loading ? (
            <RecentSkeleton />
          ) : recentDecisions.length === 0 ? (
            <EmptyRecent />
          ) : (
            <div className="divide-y divide-dashed divide-ink-100">
              {recentDecisions.map((r) => (
                <RecentDecisionRow key={r.id} record={r} />
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  )
}

// ---- Data helpers ---------------------------------------------------------

// check_activity_log rows come back with the joined check nested under
// `.checks`. Flatten that here once so every consumer below (KPIs, trend,
// recent list) can just read `.amount`, `.decided_at`, etc. directly,
// same shape as before — only the query changed, not the rest of the file.
function flattenDecisionRow(row) {
  const check = row.checks || {}
  return {
    id: row.id,
    decision: row.action, // 'approved' | 'rejected'
    decided_at: row.performed_at,
    decided_by_name: row.approved_by_name,
    rejection_remarks: row.action === 'rejected' ? row.remarks : null,
    amount: check.amount,
    payee: check.payee,
    check_no: check.check_no,
    submitted_at: check.submitted_at,
  }
}

function sumAmount(rows) {
  return (rows || []).reduce((s, r) => s + Number(r.amount || 0), 0)
}

function waitHours(check, now) {
  if (!check.submitted_at) return null
  const ms = now - new Date(check.submitted_at).getTime()
  if (Number.isNaN(ms)) return null
  return Math.max(0, ms / HOUR_MS)
}

function computeWaitBreakdown(pendingChecks, now) {
  const buckets = WAIT_BUCKETS.map((b) => ({ ...b, count: 0, amount: 0 }))
  let oldest = null

  pendingChecks.forEach((c) => {
    const hours = waitHours(c, now)
    if (hours === null) return
    const bucket = buckets.find((b) => b.test(hours))
    if (bucket) {
      bucket.count += 1
      bucket.amount += Number(c.amount || 0)
    }
    if (!oldest || hours > oldest.hours) {
      oldest = { hours, payee: c.payee, checkNo: c.check_no }
    }
  })

  const overdueBuckets = buckets.filter((b) => b.tone === 'risk' || b.tone === 'critical')
  const overdueCount = overdueBuckets.reduce((s, b) => s + b.count, 0)
  const overdueAmount = overdueBuckets.reduce((s, b) => s + b.amount, 0)
  const maxAmount = Math.max(1, ...buckets.map((b) => b.amount))
  const totalCount = pendingChecks.length
  const totalAmount = sumAmount(pendingChecks)

  return { buckets, oldest, overdueCount, overdueAmount, maxAmount, totalCount, totalAmount }
}

function buildDecisionTrend(decided, days) {
  const byDate = new Map()
  decided.forEach((c) => {
    if (!c.performed_at) return
    const key = new Date(c.performed_at).toISOString().slice(0, 10)
    const entry = byDate.get(key) || { approved: 0, rejected: 0 }
    if (c.action === 'rejected') entry.rejected += 1
    else entry.approved += 1
    byDate.set(key, entry)
  })

  const out = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * DAY_MS)
    const key = d.toISOString().slice(0, 10)
    const entry = byDate.get(key) || { approved: 0, rejected: 0 }
    out.push({
      date: key,
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      approved: entry.approved,
      rejected: entry.rejected,
      total: entry.approved + entry.rejected,
    })
  }
  return out
}

function buildTopSubmitters(pendingChecks, now, limit) {
  const map = new Map()
  pendingChecks.forEach((c) => {
    const submittedName = c.submitted_by_name || 'Unknown submitter'
    const entry = map.get(submittedName) || { name: submittedName, count: 0, amount: 0, totalHours: 0, hoursCount: 0 }
    entry.count += 1
    entry.amount += Number(c.amount || 0)
    const hours = waitHours(c, now)
    if (hours !== null) {
      entry.totalHours += hours
      entry.hoursCount += 1
    }
    map.set(submittedName, entry)
  })
  return [...map.values()]
    .map((e) => ({ ...e, avgHours: e.hoursCount > 0 ? e.totalHours / e.hoursCount : null }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

// Who's clearing the queue this period, and how their approve/reject split
// looks — surfaces workload imbalance and unusually high rejection rates
// per approver at a glance.
function buildApproverLeaderboard(decided, limit) {
  const map = new Map()
  decided.forEach((d) => {
    const nameKey = d.decided_by_name || 'Unknown approver'
    const entry = map.get(nameKey) || { name: nameKey, approved: 0, rejected: 0, amount: 0 }
    if (d.decision === 'rejected') entry.rejected += 1
    else entry.approved += 1
    entry.amount += Number(d.amount || 0)
    map.set(nameKey, entry)
  })
  return [...map.values()]
    .map((e) => ({ ...e, total: e.approved + e.rejected }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
}

// Groups rejected checks by their (trimmed, case-insensitive) remark text
// so recurring reasons surface even though remarks are free text.
function buildRejectionReasons(rejected, limit) {
  const map = new Map()
  rejected.forEach((r) => {
    const label = (r.rejection_remarks || '').trim()
    if (!label) return
    const key = label.toLowerCase()
    const entry = map.get(key) || { label, count: 0 }
    entry.count += 1
    map.set(key, entry)
  })
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit)
}

function computeApprovalRate(approvedCount, decidedCount) {
  if (!decidedCount) return null
  return Math.round((approvedCount / decidedCount) * 100)
}

// Share of decisions made within the SLA target, measured from submission
// to decision. Only counts rows where both timestamps are present.
function computeSlaCompliance(decided, slaHours) {
  const withBoth = decided.filter((c) => c.submitted_at && c.decided_at)
  if (withBoth.length === 0) return null
  const within = withBoth.filter(
    (c) => (new Date(c.decided_at).getTime() - new Date(c.submitted_at).getTime()) / HOUR_MS <= slaHours
  ).length
  return { pct: Math.round((within / withBoth.length) * 100), within, total: withBoth.length }
}

function findLargestPending(pendingChecks) {
  if (!pendingChecks.length) return null
  return pendingChecks.reduce(
    (max, c) => (Number(c.amount || 0) > Number(max.amount || 0) ? c : max),
    pendingChecks[0]
  )
}

function computeDelta(curr, prev) {
  if (!prev) {
    if (!curr) return null
    return { pct: null, direction: 'up', isNew: true }
  }
  const pct = Math.round(((curr - prev) / prev) * 100)
  return { pct, direction: pct >= 0 ? 'up' : 'down', isNew: false }
}

function formatHours(hours) {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?'
}

// ---- Presentational pieces -------------------------------------------------

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
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        This dashboard requires the approver or admin role. If this seems wrong, ask an admin to
        check your account's role.
      </p>
    </div>
  )
}

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

// Shared KPI card template — icon badge, accent ring, value + secondary
// line, optional delta pill (growth % by default, or `deltaUnit="pts"` for
// point-based deltas like approval-rate swings), optional link-through.
// Reuse this component for any new stat card on approver/admin pages
// rather than hand-rolling new markup, so the visual language stays
// consistent across the app.
function KpiCard({ icon: Icon, label, value, secondary, loading, accent, delta, deltaUnit = '%', to }) {
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
                    'flex shrink-0 items-center gap-0.5 text-[11px] font-medium',
                    delta.direction === 'up' ? 'text-ledger-stampDark' : 'text-ink-400'
                  )}
                >
                  {delta.direction === 'up' ? (
                    <TrendingUp className="h-3 w-3" />
                  ) : (
                    <TrendingDown className="h-3 w-3" />
                  )}
                  {Math.abs(delta.pct)}
                  {deltaUnit}
                </span>
              )}
              {delta && delta.isNew && (
                <span className="shrink-0 text-[11px] font-medium text-ledger-stampDark">new</span>
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

function WaitBreakdownCard({ loading, breakdown }) {
  return (
    <SectionCard
      icon={Hourglass}
      title="Waiting on you"
      subtitle="How long pending checks have sat in the queue since submission."
    >
      {loading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-ink-50" />
          ))}
        </div>
      ) : breakdown.totalCount === 0 ? (
        <p className="py-6 text-center text-sm text-ink-400">Nothing awaiting a decision right now.</p>
      ) : (
        <>
          <div className="space-y-2.5">
            {breakdown.buckets.map((b) => (
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
                    style={{ width: `${b.amount > 0 ? Math.max(4, (b.amount / breakdown.maxAmount) * 100) : 0}%` }}
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
              {breakdown.totalCount} checks · {formatCurrency(breakdown.totalAmount)} total
            </span>
            {breakdown.oldest && (
              <span className="text-ink-500">
                Oldest: <span className="font-medium text-ink-700">{formatHours(breakdown.oldest.hours)}</span>
                {breakdown.oldest.payee ? ` · ${breakdown.oldest.payee}` : ''}
                {breakdown.oldest.checkNo ? ` · #${breakdown.oldest.checkNo}` : ''}
              </span>
            )}
          </div>
        </>
      )}
    </SectionCard>
  )
}

function TrendCard({ loading, trend }) {
  const max = Math.max(1, ...trend.map((d) => d.total))
  const totalApproved = trend.reduce((s, d) => s + d.approved, 0)
  const totalRejected = trend.reduce((s, d) => s + d.rejected, 0)

  return (
    <SectionCard
      icon={BarChart3}
      title="Decision activity"
      subtitle={`Approved vs. rejected per day, last ${TREND_DAYS} days.`}
    >
      {loading ? (
        <div className="h-32 animate-pulse rounded bg-ink-50" />
      ) : (
        <>
          <div className="flex h-32 items-end gap-1.5">
            {trend.map((d) => (
              <div
                key={d.date}
                className="flex flex-1 flex-col items-center gap-1"
                title={`${d.label}: ${d.approved} approved, ${d.rejected} rejected`}
              >
                <div className="flex h-24 w-full flex-col-reverse items-end overflow-hidden rounded-t bg-ink-50">
                  {d.approved > 0 && (
                    <div
                      className="w-full bg-ledger-stamp/60"
                      style={{ height: `${Math.max(4, (d.approved / max) * 100)}%` }}
                    />
                  )}
                  {d.rejected > 0 && (
                    <div
                      className="w-full rounded-t bg-red-300"
                      style={{ height: `${Math.max(4, (d.rejected / max) * 100)}%` }}
                    />
                  )}
                </div>
                <span className="font-mono text-[9px] text-ink-300">{d.label.split(' ')[1]}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 flex items-center gap-3 text-xs text-ink-400">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-ledger-stamp/60" />
              <span className="font-medium text-ink-700">{totalApproved}</span> approved
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-red-300" />
              <span className="font-medium text-ink-700">{totalRejected}</span> rejected
            </span>
          </p>
        </>
      )}
    </SectionCard>
  )
}

function TopSubmittersCard({ loading, submitters }) {
  return (
    <SectionCard icon={Users} title="Top submitters" subtitle="Who's currently waiting on the most decisions.">
      {loading ? (
        <RecentSkeleton />
      ) : submitters.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-400">Nothing pending right now.</p>
      ) : (
        <div className="divide-y divide-dashed divide-ink-100">
          {submitters.map((s, idx) => (
            <div key={s.name} className="flex items-center gap-3 py-3 text-sm">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-ink-200 font-mono text-[11px] text-ink-400">
                {idx + 1}
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-50 font-mono text-[10px] font-semibold text-ink-600">
                {initials(s.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink-800">{s.name}</p>
                <p className="font-mono text-xs text-ink-300">
                  {s.count} check{s.count === 1 ? '' : 's'} pending
                  {s.avgHours !== null ? ` · avg wait ${formatHours(s.avgHours)}` : ''}
                </p>
              </div>
              <span className="shrink-0 font-mono text-sm font-medium text-ink-800">
                {formatCurrency(s.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function ApproverLeaderboardCard({ loading, leaderboard }) {
  const maxTotal = Math.max(1, ...leaderboard.map((a) => a.total))
  return (
    <SectionCard icon={Award} title="Approver activity" subtitle="Who's clearing the queue this period.">
      {loading ? (
        <RecentSkeleton />
      ) : leaderboard.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-400">No decisions recorded in this period.</p>
      ) : (
        <div className="space-y-3.5">
          {leaderboard.map((a, idx) => (
            <div key={a.name} className="flex items-center gap-3 text-sm">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-ink-200 font-mono text-[11px] text-ink-400">
                {idx + 1}
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-50 font-mono text-[10px] font-semibold text-ink-600">
                {initials(a.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink-800">{a.name}</p>
                <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-ink-50">
                  <div className="h-full bg-ledger-stamp/60" style={{ width: `${(a.approved / maxTotal) * 100}%` }} />
                  <div className="h-full bg-red-300" style={{ width: `${(a.rejected / maxTotal) * 100}%` }} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono text-sm font-medium text-ink-800">{a.total}</p>
                <p className="font-mono text-[11px] text-ink-300">
                  {a.approved}/{a.rejected}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function RejectionReasonsCard({ loading, reasons, totalRejected }) {
  const maxCount = Math.max(1, ...reasons.map((r) => r.count))
  return (
    <SectionCard
      icon={MessageSquareWarning}
      title="Top rejection reasons"
      subtitle="Most common remarks left on rejected checks this period."
    >
      {loading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-ink-50" />
          ))}
        </div>
      ) : reasons.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-400">
          {totalRejected === 0 ? 'No rejections in this period.' : 'No remarks were recorded for rejections.'}
        </p>
      ) : (
        <div className="space-y-2.5">
          {reasons.map((r) => (
            <div key={r.label} className="flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-50">
                <div
                  className="h-full rounded-full bg-red-300"
                  style={{ width: `${Math.max(4, (r.count / maxCount) * 100)}%` }}
                />
              </div>
              <span className="w-8 shrink-0 text-right font-mono text-xs text-ink-600">{r.count}</span>
              <span className="max-w-[45%] shrink-0 truncate text-xs text-ink-500" title={r.label}>
                {r.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function RecentDecisionRow({ record }) {
  const approved = record.decision !== 'rejected'
  return (
    <div className="flex items-center gap-3 py-3 text-sm">
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          approved ? 'bg-ledger-stamp/10 text-ledger-stampDark' : 'bg-red-50 text-red-500'
        )}
      >
        {approved ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldX className="h-3.5 w-3.5" />}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink-800">{record.payee || 'Unknown payee'}</p>
        <p className="truncate font-mono text-xs text-ink-300">
          Check #{record.check_no || '—'} · {approved ? 'approved' : 'rejected'} by{' '}
          {record.decided_by_name || 'unknown approver'}
          {!approved && record.rejection_remarks ? ` · ${record.rejection_remarks}` : ''}
        </p>
      </div>

      <div className="hidden flex-1 border-b border-dotted border-ink-200 sm:block" aria-hidden="true" />

      <div className="shrink-0 text-right">
        <p className="font-mono font-medium text-ink-800">{formatCurrency(record.amount)}</p>
        <p className="text-xs text-ink-300">{record.decided_at ? formatDate(record.decided_at) : '—'}</p>
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
      <p className="mt-3 text-sm font-medium text-ink-600">No decisions recorded yet</p>
      <p className="mt-1 max-w-xs text-xs text-ink-300">
        Once you approve or reject a check, it'll show up here.
      </p>
    </div>
  )
}
