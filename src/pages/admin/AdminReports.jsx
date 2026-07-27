import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ScrollText,
  Search,
  RefreshCw,
  Download,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  X,
  Filter,
  Calendar,
  Activity,
  UserCircle2,
  LogIn,
  Pencil,
  Trash2,
  ShieldCheck,
  Ban,
  RotateCcw,
  CheckCircle2,
  XCircle,
  FileCheck2,
  Send,
  KeyRound,
  AlertTriangle,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { Select } from '../../components/ui/select'
import { listAuditLogs } from '../../lib/adminAuditApi'

// This page is read-only: it surfaces the activity_log trail for verifier,
// approver, and admin accounts. Adjust ACTION_META below if your action
// strings differ from the ones assumed here.

const ROLE_FILTER_OPTIONS = [
  { value: 'all', label: 'All roles' },
  { value: 'admin', label: 'Admin' },
  { value: 'verifier', label: 'Verifier' },
  { value: 'approver', label: 'Approver' },
]

const ROLE_BADGE_STYLE = {
  admin: 'bg-purple-100 text-purple-800',
  verifier: 'bg-blue-100 text-blue-800',
  approver: 'bg-amber-100 text-amber-800',
}

const ACTION_FILTER_OPTIONS = [
  { value: 'all', label: 'All actions' },
  { value: 'auth', label: 'Sign in / sign out' },
  { value: 'create', label: 'Created' },
  { value: 'update', label: 'Updated' },
  { value: 'approve', label: 'Approved' },
  { value: 'reject', label: 'Rejected' },
  { value: 'deactivate', label: 'Deactivated' },
  { value: 'reactivate', label: 'Reactivated' },
  { value: 'reset', label: 'Password reset' },
]

const DATE_RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
]

// Maps an action string (e.g. "check.approved") to a display label, icon, and color.
// Falls back to a generic "Activity" treatment for anything unrecognized.
function getActionMeta(action = '') {
  const a = action.toLowerCase()
  if (a.includes('login') || a.includes('signin') || a.includes('sign_in')) {
    return { label: 'Signed in', icon: LogIn, tone: 'text-gray-600 bg-gray-100', category: 'auth' }
  }
  if (a.includes('logout') || a.includes('signout') || a.includes('sign_out')) {
    return { label: 'Signed out', icon: LogIn, tone: 'text-gray-600 bg-gray-100', category: 'auth' }
  }
  if (a.includes('reset') || a.includes('password')) {
    return { label: 'Password reset', icon: KeyRound, tone: 'text-blue-700 bg-blue-50', category: 'reset' }
  }
  if (a.includes('deactivate') || a.includes('banned') || a.includes('ban')) {
    return { label: 'Deactivated', icon: Ban, tone: 'text-red-700 bg-red-50', category: 'deactivate' }
  }
  if (a.includes('reactivate') || a.includes('unban')) {
    return { label: 'Reactivated', icon: RotateCcw, tone: 'text-green-700 bg-green-50', category: 'reactivate' }
  }
  if (a.includes('approve')) {
    return { label: 'Approved', icon: CheckCircle2, tone: 'text-green-700 bg-green-50', category: 'approve' }
  }
  if (a.includes('reject') || a.includes('decline')) {
    return { label: 'Rejected', icon: XCircle, tone: 'text-red-700 bg-red-50', category: 'reject' }
  }
  if (a.includes('submit')) {
    return { label: 'Submitted for approval', icon: Send, tone: 'text-amber-700 bg-amber-50', category: 'update' }
  }
  if (a.includes('pickup') || a.includes('release')) {
    return { label: 'Pickup updated', icon: FileCheck2, tone: 'text-teal-700 bg-teal-50', category: 'update' }
  }
  if (a.includes('delete') || a.includes('remove')) {
    return { label: 'Deleted', icon: Trash2, tone: 'text-red-700 bg-red-50', category: 'update' }
  }
  if (a.includes('create') || a.includes('add')) {
    return { label: 'Created', icon: Pencil, tone: 'text-blue-700 bg-blue-50', category: 'create' }
  }
  if (a.includes('update') || a.includes('edit')) {
    return { label: 'Updated', icon: Pencil, tone: 'text-amber-700 bg-amber-50', category: 'update' }
  }
  return { label: action || 'Activity', icon: Activity, tone: 'text-gray-600 bg-gray-100', category: 'other' }
}

const PAGE_SIZE = 15

function formatDateTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatRelativeTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const diffMs = Date.now() - date.getTime()
  const diffSec = Math.round(diffMs / 1000)
  const diffMin = Math.round(diffSec / 60)
  const diffHr = Math.round(diffMin / 60)
  const diffDay = Math.round(diffHr / 24)
  if (diffSec < 60) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 30) return `${diffDay}d ago`
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function getInitials(name, email) {
  const source = (name || '').trim()
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean)
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }
  return (email || '?').slice(0, 2).toUpperCase()
}

const AVATAR_PALETTE = [
  'bg-teal-100 text-teal-700',
  'bg-blue-100 text-blue-700',
  'bg-amber-100 text-amber-700',
  'bg-violet-100 text-violet-700',
  'bg-rose-100 text-rose-700',
  'bg-emerald-100 text-emerald-700',
]

function avatarStyleFor(key = '') {
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % AVATAR_PALETTE.length
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

function useDebouncedValue(value, delay) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

function SortButton({ label, sortKey, activeKey, direction, onSort }) {
  const isActive = activeKey === sortKey
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className="group inline-flex items-center gap-1 text-left text-xs font-medium uppercase tracking-wide text-gray-500 transition-colors hover:text-gray-800"
    >
      {label}
      {isActive ? (
        direction === 'asc' ? (
          <ChevronUp className="h-3.5 w-3.5 text-teal-600" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-teal-600" />
        )
      ) : (
        <ArrowUpDown className="h-3.5 w-3.5 text-gray-300 transition-colors group-hover:text-gray-400" />
      )}
    </button>
  )
}

function SkeletonRows({ count = 6 }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i} className="animate-pulse">
          <td className="px-4 py-3">
            <div className="h-3.5 w-24 rounded bg-gray-200" />
          </td>
          <td className="px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="h-7 w-7 rounded-full bg-gray-200" />
              <div className="h-3.5 w-24 rounded bg-gray-200" />
            </div>
          </td>
          <td className="px-4 py-3">
            <div className="h-5 w-16 rounded-full bg-gray-200" />
          </td>
          <td className="px-4 py-3">
            <div className="h-5 w-28 rounded-full bg-gray-200" />
          </td>
          <td className="px-4 py-3">
            <div className="h-3.5 w-32 rounded bg-gray-200" />
          </td>
          <td className="px-4 py-3 text-right">
            <div className="ml-auto h-4 w-4 rounded bg-gray-200" />
          </td>
        </tr>
      ))}
    </>
  )
}

function escapeCsvValue(value) {
  const str = String(value ?? '')
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function downloadCsv(rows, filename) {
  const header = ['Timestamp', 'Actor', 'Email', 'Role', 'Action', 'Target', 'Details']
  const lines = [header.join(',')]
  rows.forEach((r) => {
    lines.push(
      [
        formatDateTime(r.created_at),
        r.actor_name || '',
        r.actor_email || '',
        r.actor_role || '',
        getActionMeta(r.action).label,
        r.target_label || r.target_id || '',
        typeof r.metadata === 'object' ? JSON.stringify(r.metadata || {}) : r.metadata || '',
      ]
        .map(escapeCsvValue)
        .join(',')
    )
  })
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export default function AdminAuditTrail() {
  const [searchParams, setSearchParams] = useSearchParams()

  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const lastFetchedRef = useRef(null)

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 250)
  const [roleFilter, setRoleFilter] = useState('all')
  const [actionFilter, setActionFilter] = useState('all')
  const [dateRange, setDateRange] = useState('30')
  const [actorFilter, setActorFilter] = useState(searchParams.get('actorId') || '')

  const [sortKey, setSortKey] = useState('time')
  const [sortDir, setSortDir] = useState('desc')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState(null)

  const fetchLogs = useCallback(async () => {
    setLoadError('')
    try {
      // Fetch a generous window of recent logs and refine client-side, mirroring
      // the pattern used on the Manage Users page. For very large tables, move
      // filtering server-side by passing these params through to listAuditLogs.
      const { logs: rows } = await listAuditLogs({ page: 1, perPage: 500 })
      setLogs(rows)
      lastFetchedRef.current = Date.now()
    } catch (err) {
      setLoadError(err.message || 'Could not load audit trail')
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchLogs().finally(() => setLoading(false))
  }, [fetchLogs])

  async function handleRefresh() {
    setRefreshing(true)
    await fetchLogs()
    setRefreshing(false)
  }

  // Keep the actorId query param in sync so the filtered link (e.g. from
  // Manage Users -> "View activity") is shareable and survives a reload.
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (actorFilter) next.set('actorId', actorFilter)
    else next.delete('actorId')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorFilter])

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, roleFilter, actionFilter, dateRange, actorFilter, sortKey, sortDir])

  const actorOptions = useMemo(() => {
    const map = new Map()
    logs.forEach((l) => {
      if (l.actor_id && !map.has(l.actor_id)) {
        map.set(l.actor_id, { id: l.actor_id, name: l.actor_name, email: l.actor_email })
      }
    })
    return Array.from(map.values()).sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''))
  }, [logs])

  const filteredLogs = useMemo(() => {
    let rows = logs

    if (actorFilter) rows = rows.filter((l) => l.actor_id === actorFilter)

    if (dateRange !== 'all') {
      const days = Number(dateRange)
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
      rows = rows.filter((l) => new Date(l.created_at).getTime() >= cutoff)
    }

    if (roleFilter !== 'all') rows = rows.filter((l) => l.actor_role === roleFilter)

    if (actionFilter !== 'all') {
      rows = rows.filter((l) => getActionMeta(l.action).category === actionFilter)
    }

    const q = debouncedSearch.trim().toLowerCase()
    if (q) {
      rows = rows.filter((l) =>
        [l.actor_name, l.actor_email, l.action, l.target_label, l.target_id]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(q))
      )
    }

    return rows
  }, [logs, actorFilter, dateRange, roleFilter, actionFilter, debouncedSearch])

  const sortedLogs = useMemo(() => {
    const rows = [...filteredLogs]
    const dir = sortDir === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      let av
      let bv
      switch (sortKey) {
        case 'actor':
          av = a.actor_name || a.actor_email || ''
          bv = b.actor_name || b.actor_email || ''
          break
        case 'role':
          av = a.actor_role || ''
          bv = b.actor_role || ''
          break
        case 'action':
          av = getActionMeta(a.action).label
          bv = getActionMeta(b.action).label
          break
        default:
          av = new Date(a.created_at).getTime()
          bv = new Date(b.created_at).getTime()
      }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
    return rows
  }, [filteredLogs, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sortedLogs.length / PAGE_SIZE))
  const pagedLogs = useMemo(
    () => sortedLogs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sortedLogs, page]
  )

  const stats = useMemo(() => {
    const now = Date.now()
    const startOfDay = new Date().setHours(0, 0, 0, 0)
    const today = logs.filter((l) => new Date(l.created_at).getTime() >= startOfDay).length
    const uniqueActors = new Set(logs.map((l) => l.actor_id)).size
    const counts = {}
    logs.forEach((l) => {
      const label = getActionMeta(l.action).label
      counts[label] = (counts[label] || 0) + 1
    })
    const topAction = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
    return {
      total: logs.length,
      today,
      uniqueActors,
      topAction: topAction ? topAction[0] : '—',
    }
  }, [logs])

  const hasActiveFilters =
    Boolean(search.trim()) || roleFilter !== 'all' || actionFilter !== 'all' || dateRange !== '30' || Boolean(actorFilter)

  function resetFilters() {
    setSearch('')
    setRoleFilter('all')
    setActionFilter('all')
    setDateRange('30')
    setActorFilter('')
  }

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'time' ? 'desc' : 'asc')
    }
  }

  function handleExport() {
    downloadCsv(sortedLogs, `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`)
  }

  const activeActorLabel = useMemo(() => {
    if (!actorFilter) return null
    const found = actorOptions.find((a) => a.id === actorFilter)
    return found?.name || found?.email || actorFilter
  }, [actorFilter, actorOptions])

  return (
    <div>
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50">
            <ScrollText className="h-5 w-5 text-teal-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-800">Audit trail</h1>
            <p className="text-xs text-gray-500">
              {loading ? 'Loading…' : `${sortedLogs.length} of ${logs.length} events shown`}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={handleRefresh} disabled={refreshing || loading}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={handleExport} disabled={loading || sortedLogs.length === 0}>
            <Download className="mr-1.5 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:mb-6 sm:grid-cols-4 sm:gap-3">
        {[
          { label: 'Total events', value: stats.total, icon: Activity, tone: 'text-gray-700 bg-gray-100' },
          { label: 'Today', value: stats.today, icon: Calendar, tone: 'text-teal-700 bg-teal-50' },
          { label: 'Unique actors', value: stats.uniqueActors, icon: UserCircle2, tone: 'text-blue-700 bg-blue-50' },
          { label: 'Most common', value: stats.topAction, icon: ShieldCheck, tone: 'text-amber-700 bg-amber-50' },
        ].map((s) => (
          <Card key={s.label} className="flex items-center gap-2.5 px-3 py-2.5 sm:px-4 sm:py-3">
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md ${s.tone}`}>
              <s.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[11px] uppercase tracking-wide text-gray-400">{s.label}</p>
              <p className="truncate text-base font-semibold text-gray-800">{loading ? '—' : s.value}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Active actor filter chip (e.g. arrived from Manage Users -> View activity) */}
      {activeActorLabel && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-900">
          <Filter className="h-3.5 w-3.5 flex-shrink-0" />
          Showing activity for <span className="font-medium">{activeActorLabel}</span>
          <button
            type="button"
            onClick={() => setActorFilter('')}
            className="ml-auto rounded p-0.5 transition-colors hover:bg-teal-100"
            aria-label="Clear actor filter"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:flex-wrap">
        <div className="relative flex-1 sm:min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by actor, action, or target"
            className="pl-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-600"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex gap-2.5">
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="flex-1 sm:w-36">
            {ROLE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <Select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="flex-1 sm:w-44">
            {ACTION_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <Select value={dateRange} onChange={(e) => setDateRange(e.target.value)} className="flex-1 sm:w-40">
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        {hasActiveFilters && (
          <Button variant="ghost" onClick={resetFilters} className="justify-center text-gray-500 sm:w-auto">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reset
          </Button>
        )}
      </div>

      {/* Desktop table */}
      <Card className="hidden overflow-hidden sm:block">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3">
                  <SortButton label="Time" sortKey="time" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Actor" sortKey="actor" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Role" sortKey="role" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3">
                  <SortButton label="Action" sortKey="action" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">Target</th>
                <th className="w-10 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <SkeletonRows />
              ) : loadError ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-red-600">
                    <AlertTriangle className="mx-auto mb-1 h-5 w-5" />
                    {loadError}
                  </td>
                </tr>
              ) : pagedLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <ScrollText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
                    <p className="text-sm font-medium text-gray-600">No activity found</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {hasActiveFilters ? 'Try adjusting your search or filters.' : 'Activity will appear here as accounts take actions.'}
                    </p>
                    {hasActiveFilters && (
                      <Button variant="ghost" size="sm" onClick={resetFilters} className="mt-3">
                        Clear filters
                      </Button>
                    )}
                  </td>
                </tr>
              ) : (
                pagedLogs.map((log) => {
                  const meta = getActionMeta(log.action)
                  const Icon = meta.icon
                  const isExpanded = expandedId === log.id
                  const hasDetails = Boolean(log.metadata && Object.keys(log.metadata).length) || log.ip_address
                  return (
                    <React.Fragment key={log.id}>
                      <tr
                        className={`group cursor-pointer transition-colors hover:bg-gray-50 ${isExpanded ? 'bg-gray-50' : ''}`}
                        onClick={() => hasDetails && setExpandedId(isExpanded ? null : log.id)}
                      >
                        <td className="whitespace-nowrap px-4 py-3 text-gray-600" title={formatDateTime(log.created_at)}>
                          {formatRelativeTime(log.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div
                              className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarStyleFor(
                                log.actor_name || log.actor_email || ''
                              )}`}
                            >
                              {getInitials(log.actor_name, log.actor_email)}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate font-medium text-gray-800">
                                {log.actor_name || log.actor_email || 'Unknown'}
                              </p>
                              {log.actor_name && <p className="truncate text-xs text-gray-400">{log.actor_email}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge className={ROLE_BADGE_STYLE[log.actor_role] || 'bg-gray-100 text-gray-700'}>
                            {log.actor_role || 'unknown'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${meta.tone}`}>
                            <Icon className="h-3.5 w-3.5" />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          <span className="truncate">{log.target_label || log.target_id || '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {hasDetails && (
                            <ChevronDown
                              className={`ml-auto h-4 w-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                            />
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-gray-50/60">
                          <td colSpan={6} className="px-4 pb-4 pt-1">
                            <div className="rounded-md border border-gray-200 bg-white p-3 text-xs">
                              {log.ip_address && (
                                <p className="mb-1.5 text-gray-500">
                                  <span className="font-medium text-gray-600">IP address:</span> {log.ip_address}
                                </p>
                              )}
                              {log.user_agent && (
                                <p className="mb-1.5 truncate text-gray-500">
                                  <span className="font-medium text-gray-600">Device:</span> {log.user_agent}
                                </p>
                              )}
                              {log.metadata && Object.keys(log.metadata).length > 0 && (
                                <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-600">
                                  {JSON.stringify(log.metadata, null, 2)}
                                </pre>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Mobile cards */}
      <div className="space-y-2.5 sm:hidden">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="animate-pulse px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-full bg-gray-200" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-2/3 rounded bg-gray-200" />
                  <div className="h-3 w-1/2 rounded bg-gray-200" />
                </div>
              </div>
            </Card>
          ))
        ) : loadError ? (
          <Card className="px-4 py-8 text-center text-sm text-red-600">{loadError}</Card>
        ) : pagedLogs.length === 0 ? (
          <Card className="px-4 py-10 text-center">
            <ScrollText className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            <p className="text-sm font-medium text-gray-600">No activity found</p>
            <p className="mt-0.5 text-xs text-gray-400">
              {hasActiveFilters ? 'Try adjusting your search or filters.' : 'Activity will appear here as accounts take actions.'}
            </p>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={resetFilters} className="mt-3">
                Clear filters
              </Button>
            )}
          </Card>
        ) : (
          pagedLogs.map((log) => {
            const meta = getActionMeta(log.action)
            const Icon = meta.icon
            const isExpanded = expandedId === log.id
            const hasDetails = Boolean(log.metadata && Object.keys(log.metadata).length) || log.ip_address
            return (
              <Card key={log.id} className="px-4 py-3">
                <div
                  className={hasDetails ? 'cursor-pointer' : ''}
                  onClick={() => hasDetails && setExpandedId(isExpanded ? null : log.id)}
                >
                  <div className="flex items-start gap-2.5">
                    <div
                      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarStyleFor(
                        log.actor_name || log.actor_email || ''
                      )}`}
                    >
                      {getInitials(log.actor_name, log.actor_email)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-gray-800">
                          {log.actor_name || log.actor_email || 'Unknown'}
                        </p>
                        <span className="flex-shrink-0 text-[11px] text-gray-400" title={formatDateTime(log.created_at)}>
                          {formatRelativeTime(log.created_at)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge className={ROLE_BADGE_STYLE[log.actor_role] || 'bg-gray-100 text-gray-700'}>
                          {log.actor_role || 'unknown'}
                        </Badge>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.tone}`}>
                          <Icon className="h-3 w-3" />
                          {meta.label}
                        </span>
                      </div>
                      {(log.target_label || log.target_id) && (
                        <p className="mt-1 truncate text-xs text-gray-500">on {log.target_label || log.target_id}</p>
                      )}
                    </div>
                  </div>
                </div>
                {isExpanded && hasDetails && (
                  <div className="mt-2.5 rounded-md border border-gray-200 bg-gray-50 p-2.5 text-[11px]">
                    {log.ip_address && (
                      <p className="mb-1 text-gray-500">
                        <span className="font-medium text-gray-600">IP:</span> {log.ip_address}
                      </p>
                    )}
                    {log.metadata && Object.keys(log.metadata).length > 0 && (
                      <pre className="overflow-x-auto text-gray-600">{JSON.stringify(log.metadata, null, 2)}</pre>
                    )}
                  </div>
                )}
              </Card>
            )
          })
        )}
      </div>

      {/* Pagination */}
      {!loading && !loadError && sortedLogs.length > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sortedLogs.length)} of {sortedLogs.length}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[3rem] text-center text-xs">
              {page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}