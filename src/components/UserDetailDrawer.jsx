import React, { useEffect, useState } from 'react'
import {
  X,
  Send,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Clock3,
  FileCheck2,
  UploadCloud,
  Info,
  Calendar,
  Activity,
} from 'lucide-react'
import { Badge } from './ui/badge'
import { getUserInsights } from '../lib/adminUserInsightsApi'

const ROLE_BADGE_STYLE = {
  admin: 'bg-purple-100 text-purple-800',
  verifier: 'bg-blue-100 text-blue-800',
  approver: 'bg-amber-100 text-amber-800',
}

const EVENT_META = {
  submitted_for_approval: { label: 'Submitted for approval', icon: Send, tone: 'text-amber-700 bg-amber-50' },
  approved: { label: 'Approved', icon: CheckCircle2, tone: 'text-green-700 bg-green-50' },
  rejected: { label: 'Rejected', icon: XCircle, tone: 'text-red-700 bg-red-50' },
  returned: { label: 'Returned', icon: RotateCcw, tone: 'text-orange-700 bg-orange-50' },
  released: { label: 'Returned to pool', icon: RotateCcw, tone: 'text-gray-700 bg-gray-100' },
  expired: { label: 'Reservation expired', icon: Clock3, tone: 'text-gray-700 bg-gray-100' },
  picked_up: { label: 'Picked up', icon: FileCheck2, tone: 'text-teal-700 bg-teal-50' },
  uploaded_batch: { label: 'Uploaded a batch', icon: UploadCloud, tone: 'text-blue-700 bg-blue-50' },
}

function getEventMeta(action) {
  return EVENT_META[action] || { label: action || 'Activity', icon: Info, tone: 'text-gray-600 bg-gray-100' }
}

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatRelativeTime(iso) {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()) || d.getTime() === 0) return 'Never'
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function getInitials(name) {
  const source = (name || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function UserDetailDrawer({ userId, open, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !userId) return
    let cancelled = false
    setLoading(true)
    setError('')
    getUserInsights(userId)
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load user activity')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, userId])

  if (!open) return null

  const detail = data?.detail
  const timeline = data?.timeline || []
  const breakdown = detail?.action_breakdown || {}

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3.5">
          <h2 className="text-sm font-semibold text-gray-800">User activity</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Close">
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading && (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-gray-100" />
              ))}
            </div>
          )}

          {!loading && error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</div>
          )}

          {!loading && !error && detail && (
            <>
              {/* Profile header */}
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-teal-100 text-sm font-semibold text-teal-700">
                  {getInitials(detail.full_name)}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-800">{detail.full_name || 'Unknown'}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Badge className={ROLE_BADGE_STYLE[detail.role] || 'bg-gray-100 text-gray-700'}>{detail.role || 'unknown'}</Badge>
                    <span className="flex items-center gap-1 text-[11px] text-gray-400">
                      <Calendar className="h-3 w-3" /> Since {formatDateTime(detail.member_since)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Stat chips */}
              <div className="mb-4 grid grid-cols-3 gap-2">
                <div className="rounded-md border border-gray-200 px-2.5 py-2 text-center">
                  <p className="text-base font-semibold text-gray-800">{detail.total_actions}</p>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">Actions</p>
                </div>
                <div className="rounded-md border border-gray-200 px-2.5 py-2 text-center">
                  <p className="text-base font-semibold text-gray-800">{detail.total_uploads}</p>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">Uploads</p>
                </div>
                <div className="rounded-md border border-gray-200 px-2.5 py-2 text-center">
                  <p className="text-[11px] font-semibold leading-tight text-gray-800">{formatRelativeTime(detail.last_active)}</p>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">Last active</p>
                </div>
              </div>

              {/* Action breakdown */}
              {Object.keys(breakdown).length > 0 && (
                <div className="mb-4">
                  <p className="mb-2 text-xs font-medium text-gray-500">Breakdown by action</p>
                  <div className="space-y-1.5">
                    {Object.entries(breakdown)
                      .sort((a, b) => b[1] - a[1])
                      .map(([action, count]) => {
                        const meta = getEventMeta(action)
                        return (
                          <div key={action} className="flex items-center justify-between text-xs">
                            <span className="flex items-center gap-1.5 text-gray-600">
                              <meta.icon className="h-3.5 w-3.5" />
                              {meta.label}
                            </span>
                            <span className="font-medium text-gray-800">{count}</span>
                          </div>
                        )
                      })}
                  </div>
                </div>
              )}

              {/* Timeline */}
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  <Activity className="h-3.5 w-3.5" /> Recent activity
                </p>
                {timeline.length === 0 ? (
                  <p className="py-6 text-center text-xs text-gray-400">No recorded activity yet</p>
                ) : (
                  <ul className="space-y-2.5">
                    {timeline.map((event, i) => {
                      const meta = getEventMeta(event.action)
                      const Icon = meta.icon
                      return (
                        <li key={i} className="flex items-start gap-2.5">
                          <div className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${meta.tone}`}>
                            <Icon className="h-3 w-3" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-medium text-gray-800">{meta.label}</p>
                              <span className="flex-shrink-0 text-[10px] text-gray-400" title={formatDateTime(event.occurred_at)}>
                                {formatRelativeTime(event.occurred_at)}
                              </span>
                            </div>
                            {event.check_no && (
                              <p className="truncate text-[11px] text-gray-500">
                                {event.check_no} · {event.payee}
                                {event.amount != null && ` · ${new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(event.amount)}`}
                              </p>
                            )}
                            {event.event_type === 'upload' && event.detail && (
                              <p className="truncate text-[11px] text-gray-500">{event.detail}</p>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}