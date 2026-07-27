import React, { useEffect, useState, useCallback, useMemo } from 'react'
import {
  LayoutDashboard,
  ScrollText,
  Users,
  Clock3,
  AlertTriangle,
  Wallet,
  RefreshCw,
  ShieldAlert,
  ArrowRight,
  Database,
  Eye,
  Landmark,
  UploadCloud,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Hourglass,
  FileSpreadsheet,
  BookmarkCheck,
  PackageCheck,
  Calculator,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { getAdminDashboardData } from '../../lib/adminDashboardApi'
import { getDatabaseSizeStats, formatBytes } from '../../lib/adminUserInsightsApi'
import UserDetailDrawer from '../../components/UserDetailDrawer'
// KPI grid column classes now come from AdminLayout — it's the single
// source of truth for these (see the comment there). Previously this file
// kept its own copy in sync by hand, which is exactly the kind of thing
// that quietly drifts the next time either one gets tuned.
// NOTE: adjust this relative path if AdminLayout.jsx lives somewhere else
// in your tree — this assumes src/layouts/AdminLayout.jsx and this file at
// src/pages/admin/AdminDashboard.jsx.
import { KPI_GRID_CLASS, KPI_GRID_2COL_CLASS } from '../../components/AdminLayout'


const STATUS_COLORS = {
  available: '#14b8a6',
  reserved: '#3b82f6',
  pending_approval: '#f59e0b',
  returned: '#f97316',
  picked_up: '#8b5cf6',
}

const ACTION_LABELS = {
  submitted_for_approval: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  returned: 'Returned',
  released: 'Returned to pool',
  expired: 'Expired',
  picked_up: 'Picked up',
  recalled: 'Recalled',
  resubmitted: 'Resubmitted',
}

const DECISION_COLORS = {
  approved: '#14b8a6',
  rejected: '#ef4444',
  returned: '#f59e0b',
}

const ROLE_COLORS = {
  admin: '#8b5cf6',
  verifier: '#3b82f6',
  approver: '#f59e0b',
}

const AGING_COLORS = {
  '< 1h': '#14b8a6',
  '1-4h': '#3b82f6',
  '4-24h': '#f59e0b',
  '24h+': '#ef4444',
  Unknown: '#9ca3af',
}
const AGING_ORDER = ['< 1h', '1-4h', '4-24h', '24h+', 'Unknown']

const ROLE_BADGE_STYLE = {
  admin: 'bg-purple-100 text-purple-800',
  verifier: 'bg-blue-100 text-blue-800',
  approver: 'bg-amber-100 text-amber-800',
}

const DASHBOARD_QUERY_OPTIONS = { trendDays: 14, actionDays: 30, topActorDays: 30, uploadTrendDays: 14, decisionDays: 30 }

// Bank names can be long ("Bank of the Philippine Islands"); truncate the
// axis label on narrow charts and let the tooltip show the full name, so
// the chart doesn't need to reserve a huge fixed YAxis width that eats into
// the plot area on mobile.
function truncateLabel(value, maxLength = 16) {
  if (typeof value !== 'string') return value
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function formatCurrency(amount) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '—'
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(amount)
}

function formatDay(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function getInitials(name) {
  const source = (name || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Safely coerce a value that should be numeric (Postgres/Supabase often
 * returns aggregates as strings) without letting a bad value silently
 * become 0 and hide a real data problem downstream. */
function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function KpiCard({ label, value, icon: Icon, tone, sub }) {
  return (
    <Card className="flex items-start gap-3 px-4 py-3.5">
      <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md ${tone}`}>
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
        <p className="truncate text-lg font-semibold text-gray-800">{value}</p>
        {sub && <p className="mt-0.5 truncate text-[11px] text-gray-400">{sub}</p>}
      </div>
    </Card>
  )
}

function ChartSkeleton({ height = 220 }) {
  return <div className="animate-pulse rounded-md bg-gray-100" style={{ height }} />
}

function SectionHeading({ children }) {
  return <h2 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wide text-gray-400 first:mt-0">{children}</h2>
}

export default function AdminDashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [dbStats, setDbStats] = useState(null)
  const [drawerUserId, setDrawerUserId] = useState(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [result, sizeStats] = await Promise.all([
        getAdminDashboardData(DASHBOARD_QUERY_OPTIONS),
        getDatabaseSizeStats(),
      ])
      setData(result)
      setDbStats(sizeStats)
    } catch (err) {
      console.error('Failed to load admin dashboard data', err)
      setError(err?.message || 'Could not load dashboard data. Please try again.')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [load])

  async function handleRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const stats = data?.stats

  // ---------------------------------------------------------------------
  // Derived datasets. All memoized so a re-render (e.g. opening the user
  // drawer) doesn't re-crunch every chart's data on every keystroke.
  // ---------------------------------------------------------------------

  const statusData = useMemo(
    () =>
      (data?.checksByStatus || []).map((s) => ({
        name: s.status,
        label: s.status.replace(/_/g, ' '),
        value: toNumber(s.count),
        amount: toNumber(s.total_amount),
      })),
    [data]
  )

  const statusByName = useMemo(() => {
    const map = {}
    statusData.forEach((s) => {
      map[s.name] = s
    })
    return map
  }, [statusData])

  const actionData = useMemo(
    () => (data?.activityByAction || []).map((a) => ({ name: ACTION_LABELS[a.action] || a.action, count: toNumber(a.count) })),
    [data]
  )

  const trendData = useMemo(
    () => (data?.activityByDay || []).map((d) => ({ day: formatDay(d.day), count: toNumber(d.count) })),
    [data]
  )

  const topActors = data?.topActors || []

  const bankData = useMemo(
    () => (data?.checksByBank || []).map((b) => ({ name: b.bank, count: toNumber(b.count), amount: toNumber(b.total_amount) })),
    [data]
  )

  const agingData = useMemo(
    () =>
      AGING_ORDER.map((bucket) => {
        const row = (data?.pendingApprovalAging || []).find((a) => a.bucket === bucket)
        return { bucket, count: row ? toNumber(row.count) : 0 }
      }).filter((a) => a.count > 0 || a.bucket !== 'Unknown'),
    [data]
  )
  const maxAgingCount = useMemo(() => Math.max(1, ...agingData.map((a) => a.count)), [agingData])

  const uploadTrendData = useMemo(
    () => (data?.uploadActivityByDay || []).map((d) => ({ day: formatDay(d.day), batches: toNumber(d.batch_count), rows: toNumber(d.row_count) })),
    [data]
  )

  const decisionData = useMemo(
    () => (data?.decisionBreakdown || []).map((d) => ({ name: ACTION_LABELS[d.action] || d.action, action: d.action, count: toNumber(d.count) })),
    [data]
  )
  const totalDecisions = decisionData.reduce((sum, d) => sum + d.count, 0)
  const approvedCount = decisionData.find((d) => d.action === 'approved')?.count || 0
  const rejectedCount = decisionData.find((d) => d.action === 'rejected')?.count || 0
  const returnedCount = decisionData.find((d) => d.action === 'returned')?.count || 0
  const approvalRate = totalDecisions > 0 ? Math.round((approvedCount / totalDecisions) * 100) : null
  const rejectionRate = totalDecisions > 0 ? Math.round((rejectedCount / totalDecisions) * 100) : null

  const rolesData = useMemo(() => (data?.rolesBreakdown || []).map((r) => ({ name: r.role, value: toNumber(r.count) })), [data])

  const recentUploads = data?.recentUploads || []

  // Derived KPIs computed from datasets already returned by the API — no
  // new backend fields required, just using totals the backend already
  // aggregates per status/decision.
  const availableTotalValue = statusByName.available?.amount
  const pendingApprovalTotalValue = statusByName.pending_approval?.amount
  const reservedCount = statusByName.reserved?.value
  const pickedUpTotalValue = statusByName.picked_up?.amount
  const avgAvailableCheckValue =
    statusByName.available?.value > 0 ? Math.round(statusByName.available.amount / statusByName.available.value) : null

  return (
    <div>
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50">
            <LayoutDashboard className="h-5 w-5 text-teal-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-800">Dashboard</h1>
            <p className="text-xs text-gray-500">Overview across checks, activity, and users</p>
          </div>
        </div>
        <Button variant="ghost" onClick={handleRefresh} disabled={refreshing || loading}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={handleRefresh} className="flex-shrink-0 font-medium underline decoration-red-300 underline-offset-2 hover:text-red-800">
            Retry
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      <SectionHeading>Checks</SectionHeading>
      <div className={KPI_GRID_CLASS}>
        {loading ? (
          Array.from({ length: 8 }).map((_, i) => <ChartSkeleton key={i} height={64} />)
        ) : (
          <>
            <KpiCard
              label="Available checks"
              value={stats?.checks_available ?? statusByName.available?.value ?? 0}
              sub={formatCurrency(availableTotalValue)}
              icon={Wallet}
              tone="text-teal-700 bg-teal-50"
            />
            <KpiCard
              label="Reserved"
              value={reservedCount ?? 0}
              sub={`${stats?.active_reservations ?? 0} active reservation${stats?.active_reservations === 1 ? '' : 's'}`}
              icon={BookmarkCheck}
              tone="text-blue-700 bg-blue-50"
            />
            <KpiCard
              label="Pending approval"
              value={stats?.checks_pending_approval ?? statusByName.pending_approval?.value ?? 0}
              sub={pendingApprovalTotalValue !== undefined ? formatCurrency(pendingApprovalTotalValue) : undefined}
              icon={Clock3}
              tone="text-amber-700 bg-amber-50"
            />
            <KpiCard
              label="Returned checks"
              value={stats?.checks_returned ?? statusByName.returned?.value ?? 0}
              sub="Awaiting correction"
              icon={RotateCcw}
              tone="text-orange-700 bg-orange-50"
            />
            <KpiCard
              label="Picked up (all-time)"
              value={stats?.checks_picked_up ?? statusByName.picked_up?.value ?? 0}
              sub={pickedUpTotalValue !== undefined ? formatCurrency(pickedUpTotalValue) : undefined}
              icon={PackageCheck}
              tone="text-violet-700 bg-violet-50"
            />
            <KpiCard
              label="Total checks"
              value={stats?.total_checks ?? 0}
              sub="All statuses combined"
              icon={FileSpreadsheet}
              tone="text-gray-700 bg-gray-100"
            />
            <KpiCard
              label="Avg. available value"
              value={avgAvailableCheckValue !== null ? formatCurrency(avgAvailableCheckValue) : '—'}
              sub="Per unclaimed check"
              icon={Calculator}
              tone="text-teal-700 bg-teal-50"
            />
            <KpiCard
              label="Expiring within 1h"
              value={stats?.expiring_within_hour ?? 0}
              sub="Of active reservations"
              icon={AlertTriangle}
              tone="text-red-700 bg-red-50"
            />
          </>
        )}
      </div>

      {/* ------------------------------------------------------------- */}
      <SectionHeading>Approvals &amp; activity</SectionHeading>
      <div className={KPI_GRID_CLASS}>
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <ChartSkeleton key={i} height={64} />)
        ) : (
          <>
            <KpiCard
              label="Approval rate (30d)"
              value={approvalRate !== null ? `${approvalRate}%` : '—'}
              sub={`${totalDecisions} decisions made`}
              icon={CheckCircle2}
              tone="text-teal-700 bg-teal-50"
            />
            <KpiCard
              label="Rejection rate (30d)"
              value={rejectionRate !== null ? `${rejectionRate}%` : '—'}
              sub={`${rejectedCount} rejected · ${returnedCount} returned`}
              icon={XCircle}
              tone="text-red-700 bg-red-50"
            />
            <KpiCard
              label="Events today"
              value={stats?.events_today ?? 0}
              sub={`${stats?.events_last_7_days ?? 0} in last 7 days`}
              icon={ScrollText}
              tone="text-blue-700 bg-blue-50"
            />
            <KpiCard
              label="Active users (30d)"
              value={stats?.unique_actors_last_30_days ?? 0}
              sub={`${stats?.total_users ?? 0} total accounts`}
              icon={Users}
              tone="text-violet-700 bg-violet-50"
            />
          </>
        )}
      </div>

      {/* ------------------------------------------------------------- */}
      <SectionHeading>System</SectionHeading>
      <div className={KPI_GRID_2COL_CLASS}>
        {loading ? (
          Array.from({ length: 2 }).map((_, i) => <ChartSkeleton key={i} height={64} />)
        ) : (
          <>
            <KpiCard
              label="Banks in register"
              value={bankData.length}
              sub={bankData[0] ? `Most checks: ${bankData[0].name}` : undefined}
              icon={Landmark}
              tone="text-blue-700 bg-blue-50"
            />
            <KpiCard
              label="Database size"
              value={formatBytes(dbStats?.database_size_bytes)}
              sub={dbStats?.tables?.[0] ? `Largest table: ${dbStats.tables[0].table_name}` : undefined}
              icon={Database}
              tone="text-slate-700 bg-slate-100"
            />
          </>
        )}
      </div>

      {/* ------------------------------------------------------------- */}
      <div className="mt-8 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Activity trend */}
        <Card className="min-w-0 px-4 py-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800">Activity, last 14 days</h2>
            <Link to="/admin/audit" className="flex items-center gap-1 text-xs font-medium text-teal-600 hover:text-teal-700">
              View log <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {loading ? (
            <ChartSkeleton />
          ) : trendData.every((d) => d.count === 0) ? (
            <p className="py-16 text-center text-xs text-gray-400">No activity in this window</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={trendData}>
                <defs>
                  <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#14b8a6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={28} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Area type="monotone" dataKey="count" name="Events" stroke="#0d9488" strokeWidth={2} fill="url(#activityFill)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Checks by status */}
        <Card className="min-w-0 px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">Checks by status</h2>
          {loading ? (
            <ChartSkeleton />
          ) : statusData.length === 0 ? (
            <p className="py-10 text-center text-xs text-gray-400">No checks yet</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={statusData} dataKey="value" nameKey="label" innerRadius={40} outerRadius={65} paddingAngle={2}>
                    {statusData.map((entry) => (
                      <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || '#9ca3af'} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1">
                {statusData.map((s) => (
                  <div key={s.name} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 capitalize text-gray-600">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_COLORS[s.name] || '#9ca3af' }} />
                      {s.label}
                    </span>
                    <span className="font-medium text-gray-800">{s.value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Actions breakdown */}
        <Card className="min-w-0 px-4 py-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">Actions, last 30 days</h2>
          {loading ? (
            <ChartSkeleton />
          ) : actionData.length === 0 ? (
            <p className="py-10 text-center text-xs text-gray-400">No activity in this window</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={actionData} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={100}
                  tickFormatter={truncateLabel}
                  tick={{ fontSize: 11, fill: '#4b5563' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={(label) => label} />
                <Bar dataKey="count" fill="#0d9488" radius={[0, 4, 4, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Top actors */}
        <Card className="min-w-0 px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800">Most active users</h2>
            <span className="text-[11px] text-gray-400">30 days</span>
          </div>
          {loading ? (
            <div className="space-y-2.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <ChartSkeleton key={i} height={32} />
              ))}
            </div>
          ) : topActors.length === 0 ? (
            <p className="py-10 text-center text-xs text-gray-400">No activity in this window</p>
          ) : (
            <div className="space-y-2.5">
              {topActors.map((actor) => (
                <button
                  key={actor.actor_id}
                  type="button"
                  onClick={() => setDrawerUserId(actor.actor_id)}
                  className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-gray-50"
                >
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-teal-100 text-[10px] font-semibold text-teal-700">
                    {getInitials(actor.full_name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-gray-800">{actor.full_name || 'Unknown'}</p>
                    <Badge className={`${ROLE_BADGE_STYLE[actor.role] || 'bg-gray-100 text-gray-700'} mt-0.5 text-[10px]`}>
                      {actor.role || 'unknown'}
                    </Badge>
                  </div>
                  <Eye className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
                  <span className="flex-shrink-0 text-sm font-semibold text-gray-700">{actor.event_count}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="min-w-0 px-4 py-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">Checks by bank</h2>
          {loading ? (
            <ChartSkeleton />
          ) : bankData.length === 0 ? (
            <p className="py-10 text-center text-xs text-gray-400">No checks yet</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(160, bankData.length * 34)}>
              <BarChart data={bankData} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={110}
                  tickFormatter={truncateLabel}
                  tick={{ fontSize: 11, fill: '#4b5563' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  labelFormatter={(label) => label}
                  formatter={(value, name, props) => [`${value} checks · ${formatCurrency(props.payload.amount)}`, '']}
                />
                <Bar dataKey="count" fill="#3b82f6" radius={[0, 4, 4, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card className="min-w-0 px-4 py-4">
          <div className="mb-3 flex items-center gap-1.5">
            <Hourglass className="h-3.5 w-3.5 text-amber-500" />
            <h2 className="text-sm font-semibold text-gray-800">Pending approval aging</h2>
          </div>
          {loading ? (
            <ChartSkeleton height={200} />
          ) : agingData.every((a) => a.count === 0) ? (
            <p className="py-10 text-center text-xs text-gray-400">Nothing pending approval</p>
          ) : (
            <div className="space-y-2.5">
              {agingData.map((a) => (
                <div key={a.bucket}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium text-gray-600">{a.bucket}</span>
                    <span className="font-semibold text-gray-800">{a.count}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.max(4, (a.count / maxAgingCount) * 100)}%`,
                        backgroundColor: AGING_COLORS[a.bucket] || '#9ca3af',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="min-w-0 px-4 py-4">
          <div className="mb-3 flex items-center gap-1.5">
            <UploadCloud className="h-3.5 w-3.5 text-blue-500" />
            <h2 className="text-sm font-semibold text-gray-800">Uploads, last 14 days</h2>
          </div>
          {loading ? (
            <ChartSkeleton />
          ) : uploadTrendData.every((d) => d.rows === 0) ? (
            <p className="py-10 text-center text-xs text-gray-400">No uploads in this window</p>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={uploadTrendData}>
                <defs>
                  <linearGradient id="uploadFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={28} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  formatter={(value, name) => [value, name === 'rows' ? 'Checks uploaded' : 'Batches']}
                />
                <Area type="monotone" dataKey="rows" name="rows" stroke="#3b82f6" strokeWidth={2} fill="url(#uploadFill)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card className="min-w-0 px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">Approver decisions, 30 days</h2>
          {loading ? (
            <ChartSkeleton height={180} />
          ) : decisionData.length === 0 ? (
            <p className="py-10 text-center text-xs text-gray-400">No decisions in this window</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie data={decisionData} dataKey="count" nameKey="name" innerRadius={32} outerRadius={55} paddingAngle={2}>
                    {decisionData.map((entry) => (
                      <Cell key={entry.action} fill={DECISION_COLORS[entry.action] || '#9ca3af'} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1">
                {decisionData.map((d) => (
                  <div key={d.action} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-gray-600">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: DECISION_COLORS[d.action] || '#9ca3af' }} />
                      {d.name}
                    </span>
                    <span className="font-medium text-gray-800">{d.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card className="min-w-0 px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">Users by role</h2>
          {loading ? (
            <ChartSkeleton height={180} />
          ) : rolesData.length === 0 ? (
            <p className="py-10 text-center text-xs text-gray-400">No users yet</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie data={rolesData} dataKey="value" nameKey="name" innerRadius={32} outerRadius={55} paddingAngle={2}>
                    {rolesData.map((entry) => (
                      <Cell key={entry.name} fill={ROLE_COLORS[entry.name] || '#9ca3af'} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1">
                {rolesData.map((r) => (
                  <div key={r.name} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 capitalize text-gray-600">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ROLE_COLORS[r.name] || '#9ca3af' }} />
                      {r.name}
                    </span>
                    <span className="font-medium text-gray-800">{r.value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Recent uploads */}
      <Card className="mb-5 mt-4 px-4 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">Recent uploads</h2>
          <Link to="/admin/upload" className="flex items-center gap-1 text-xs font-medium text-teal-600 hover:text-teal-700">
            Upload a file <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <ChartSkeleton key={i} height={40} />
            ))}
          </div>
        ) : recentUploads.length === 0 ? (
          <p className="py-6 text-center text-xs text-gray-400">No uploads yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-gray-100 text-[10px] uppercase tracking-wide text-gray-400">
                  <th className="py-2 font-medium">File</th>
                  <th className="py-2 font-medium">Bank</th>
                  <th className="py-2 font-medium">Rows</th>
                  <th className="py-2 font-medium">Uploaded by</th>
                  <th className="py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {recentUploads.map((u) => (
                  <tr key={u.id}>
                    <td className="max-w-[200px] truncate py-2 font-medium text-gray-800">{u.file_name}</td>
                    <td className="py-2 text-gray-600">{u.bank || '—'}</td>
                    <td className="py-2 font-mono text-gray-600">{u.total_rows}</td>
                    <td className="py-2 text-gray-600">{u.uploaded_by_name || 'Unknown'}</td>
                    <td className="py-2 text-gray-400">{formatDateTime(u.uploaded_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Honest gap, not fake data */}
      <Card className="flex items-start gap-3 px-4 py-4">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
          <ShieldAlert className="h-4.5 w-4.5" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-800">Login activity, IP, and device</h2>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            Not available yet — Supabase Auth doesn't record IP or device by default, and per-user sign-in history
            can only be read with the service-role key from a server context, never from the browser. To show this
            here, add a <code className="rounded bg-gray-100 px-1 py-0.5">login_events</code> table populated by a
            server-side Auth hook or edge function on sign-in (capturing IP/user-agent from the request), then this
            card can query it the same way the charts above query <code className="rounded bg-gray-100 px-1 py-0.5">check_activity_log</code>.
          </p>
        </div>
      </Card>

      {drawerUserId && <UserDetailDrawer userId={drawerUserId} onClose={() => setDrawerUserId(null)} />}
    </div>
  )
}