import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  RefreshCw,
  Search,
  X,
  Check,
  Undo2,
  RotateCcw,
  Send,
  Loader2,
  AlertTriangle,
  User,
  UserRound,
  Hash,
  CalendarDays,
  Layers,
  ChevronDown,
  ChevronUp,
  CheckSquare,
  Square,
  MinusSquare,
  Download,
  Pause,
  Play,
  ArrowUpDown,
  CheckCircle2,
  ShieldCheck,
  XCircle,
  Wallet,
  Timer,
  Flame,
  Landmark,
  ClipboardList,
  ReceiptText,
  Building2,
  CreditCard,
  Lock,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
import { BANKS } from '../../lib/banks'
import { useProfile } from '../../context/ProfileContext'

const PROFILE_BRANCH_TO_PICKUP_BRANCH = {
  csba_parqal: 'CSBA - PARQAL',
  csba_bgc: 'CSBA - BGC',
}
const POLL_INTERVAL_MS = 20000
const EXPIRING_SOON_MINUTES = 15
const CRITICAL_MINUTES = 5
const SUCCESS_FLASH_MS = 900

const RECEIPT_TYPES = ['PR', 'AR', 'OR']

const PICKUP_BRANCHES = [
  { value: 'CSBA - PARQAL', label: 'CSBA - Parqal' },
  { value: 'CSBA - BGC', label: 'CSBA - BGC' },
]
const PICKUP_BRANCH_LABELS = Object.fromEntries(PICKUP_BRANCHES.map((b) => [b.value, b.label]))

const QUEUE_BRANCH_PREFIX = {
  'CSBA - PARQAL': 'PQ',
  'CSBA - BGC': 'BGC',
}

function formatQueueCode(branchKey, number) {
  if (!branchKey || number === null || number === undefined) return null
  const prefix = QUEUE_BRANCH_PREFIX[branchKey] || 'Q'
  return `${prefix}-${String(number).padStart(3, '0')}`
}

const COLLECTOR_ID_TYPES = [
  { value: 'national_id', label: 'National ID' },
  { value: 'postal_id', label: 'Postal ID' },
  { value: 'passport', label: 'Passport' },
  { value: 'drivers_license', label: "Driver's License" },
  { value: 'other', label: 'Others' },
]
const COLLECTOR_ID_TYPE_LABELS = Object.fromEntries(COLLECTOR_ID_TYPES.map((t) => [t.value, t.label]))
const COLLECTOR_ID_NUMBER_MAX_LENGTH = 24
const RECEIPT_NUMBER_MAX_LENGTH = 24
const COLLECTOR_ID_OTHER_LABEL_MAX_LENGTH = 40

const ACTIVE_TAB_CHECK_STATUSES = new Set(['reserved', 'returned'])

const SORT_OPTIONS = [
  { value: 'expires_asc', label: 'Expiring soonest', tabs: ['active', 'pending_approval'] },
  { value: 'submitted_asc', label: 'Oldest submitted', tabs: ['pending_approval'] },
  { value: 'submitted_desc', label: 'Newest submitted', tabs: ['pending_approval'] },
  { value: 'reserved_desc', label: 'Newest reserved', tabs: ['active', 'history'] },
  { value: 'reserved_asc', label: 'Oldest reserved', tabs: ['active', 'history'] },
  { value: 'amount_desc', label: 'Highest amount', tabs: ['active', 'pending_approval', 'history'] },
  { value: 'amount_asc', label: 'Lowest amount', tabs: ['active', 'pending_approval', 'history'] },
  { value: 'collector_asc', label: 'Collector A→Z', tabs: ['active', 'pending_approval', 'history'] },
]

const EXPECTED_STATUS_BEFORE = {
  submit: 'reserved',
  recall: 'pending_approval',
  'bulk-recall': 'pending_approval',
}

function lineItems(reservation, tab) {
  if (tab === 'history') {
    const activity = Array.isArray(reservation.activity) ? reservation.activity : []
    const byCheck = new Map()

    activity
      .slice()
      .sort((a, b) => new Date(a.performed_at || 0) - new Date(b.performed_at || 0))
      .forEach((a) => {
        if (!a.check_id) return
        const entry = byCheck.get(a.check_id) || { or_no: null }
        entry.latest = a
        if (a.checks) entry.checks = a.checks
        if (a.or_no !== null && a.or_no !== undefined) entry.or_no = a.or_no
        byCheck.set(a.check_id, entry)
      })

    return [...byCheck.values()]
      .map(({ latest, checks: c, or_no }) => {
        if (!c) return null
        return {
          id: latest.id,
          checkId: c.id,
          row_number: c.row_number,
          bank: c.bank,
          pickupBranch: c.pickup_branch,
          payee: c.payee,
          payor: c.payor,
          check_no: c.check_no,
          check_date: c.check_date,
          amount: c.amount,
          outcome: latest.action,
          or_no,
          remarks: latest.remarks,
        }
      })
      .filter(Boolean)
  }

  const rawChecks = Array.isArray(reservation.checks) ? reservation.checks : []
  const checks =
    tab === 'active'
      ? rawChecks.filter((c) => {
          const normalizedStatus = String(c?.status ?? 'reserved').trim().toLowerCase()
          return ACTIVE_TAB_CHECK_STATUSES.has(normalizedStatus) || isReturnedCheck(c)
        })
      : rawChecks

  return checks.map((c) => ({
    id: c.id,
    checkId: c.id,
    row_number: c.row_number,
    bank: c.bank,
    pickupBranch: c.pickup_branch,
    payee: c.payee,
    payor: c.payor,
    check_no: c.check_no,
    check_date: c.check_date,
    amount: c.amount,
    outcome: null,
    or_no: tab === 'pending_approval' ? c.or_no ?? null : null,
    remarks: tab === 'pending_approval' ? c.remarks ?? null : null,
    submittedAt: tab === 'pending_approval' ? c.submitted_at ?? null : null,
    submittedByName: tab === 'pending_approval' ? c.submitted_by_name ?? null : null,
    submittedBy: tab === 'pending_approval' ? c.submitted_by ?? null : null,
    checkStatus: tab === 'active' ? (isReturnedCheck(c) ? 'returned' : 'reserved') : null,
    returnReason: tab === 'active' ? c.return_reason ?? null : null,
    returnedAt: tab === 'active' ? c.returned_at ?? null : null,
    returnedByName: tab === 'active' ? c.returned_by_name ?? null : null,
    attached2307: tab === 'active' ? c.form_2307_attached === 'Y' : null,
  }))
}

function sortedLineItems(reservation, tab) {
  return [...lineItems(reservation, tab)].sort((a, b) => {
    const an = Number(a.row_number)
    const bn = Number(b.row_number)
    if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn
    return String(a.check_no ?? '').localeCompare(String(b.check_no ?? ''))
  })
}

function orderTotal(items) {
  return items.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
}

function matchesSearch(reservation, items, term) {
  if (!term) return true
  const needle = term.toLowerCase()
  if (String(reservation?.collector_name || '').toLowerCase().includes(needle)) return true
  return items.some((c) =>
    [c.payee, c.payor, c.check_no, c.or_no, c.bank, c.pickupBranch, PICKUP_BRANCH_LABELS[c.pickupBranch]]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle))
  )
}

function payeePreview(items) {
  if (items.length === 0) return null
  const names = items.map((c) => c.payee).filter(Boolean)
  if (names.length === 0) return null
  if (names.length === 1) return names[0]
  return `${names[0]} +${names.length - 1} more`
}

function earliestSubmittedAt(items) {
  const times = items.map((c) => c.submittedAt).filter(Boolean).map((t) => new Date(t).getTime())
  if (times.length === 0) return null
  return Math.min(...times)
}

function isReturnedCheck(c) {
  const normalizedStatus = String(c?.status ?? '').trim().toLowerCase()
  return normalizedStatus === 'returned' || !!c?.return_reason || !!c?.returned_at || !!c?.returned_by_name
}

function formatDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function composeReceiptNo(entry) {
  const type = entry?.receiptType || ''
  const no = entry?.receiptNo?.trim() || ''
  if (!type || !no) return ''
  return `${type}-${no}`
}

function isCollectorIdComplete(idInfo) {
  if (!idInfo) return false
  const type = idInfo.idType
  if (!type) return false
  if (type === 'other' && !idInfo.idTypeOther?.trim()) return false
  const number = idInfo.idNumber?.trim() || ''
  if (!number) return false
  if (number.length > COLLECTOR_ID_NUMBER_MAX_LENGTH) return false
  return true
}

function formatCollectorId(reservation) {
  if (!reservation?.collector_id_type) return null
  const label =
    reservation.collector_id_type === 'other'
      ? reservation.collector_id_type_other || 'Other ID'
      : COLLECTOR_ID_TYPE_LABELS[reservation.collector_id_type] || reservation.collector_id_type
  return reservation.collector_id_number ? `${label} · ${reservation.collector_id_number}` : label
}

export default function AdminPickups() {
  const [tab, setTab] = useState('active')
  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [bankFilter, setBankFilter] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [quickFilter, setQuickFilter] = useState('all')
  const [sortBy, setSortBy] = useState('expires_asc')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [lastUpdated, setLastUpdated] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [confirmAction, setConfirmAction] = useState(null)
  const [actionError, setActionError] = useState('')
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [toast, setToast] = useState(null)
  const [successFlash, setSuccessFlash] = useState(null)
  const { profile } = useProfile()
  const currentUserId = profile?.id
  const isAdmin = profile?.role === 'admin'
  const rawBranch = !isAdmin ? profile?.branch || null : null
  const verifierBranch =
    rawBranch && rawBranch !== 'all_branches' ? PROFILE_BRANCH_TO_PICKUP_BRANCH[rawBranch] || null : null
  const isBranchRestricted = !isAdmin && !!verifierBranch

  const debounceRef = useRef(null)
  const toastTimerRef = useRef(null)
  const searchInputRef = useRef(null)
  const isMountedRef = useRef(true)
  const successTimerRef = useRef(null)
  const requestIdRef = useRef(0)
  const inFlightRef = useRef(false)
  const [actioningIds, setActioningIds] = useState(() => new Set())

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      clearTimeout(successTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!isAdmin && verifierBranch) setBranchFilter(verifierBranch)
  }, [isAdmin, verifierBranch])

  useEffect(() => {
    load(true)
    setSelectedIds(new Set())
    setQuickFilter('all')
    setSortBy(tab === 'active' ? 'expires_asc' : tab === 'pending_approval' ? 'expires_asc' : 'reserved_desc')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load(false), 250)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankFilter, branchFilter])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => {
      if ((tab === 'active' || tab === 'pending_approval') && autoRefresh) load(false)
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, autoRefresh])

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === '/' && document.activeElement !== searchInputRef.current) {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  function showToast(message, variant = 'success') {
    clearTimeout(toastTimerRef.current)
    setToast({ message, variant })
    toastTimerRef.current = setTimeout(() => setToast(null), 3500)
  }

  function lockAction(id) {
    setActioningIds((prev) => new Set(prev).add(id))
  }
  function unlockAction(id) {
    setActioningIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const load = useCallback(
    async (showFullLoading) => {
      if (inFlightRef.current && !showFullLoading) return

      const requestId = ++requestIdRef.current
      inFlightRef.current = true

      if (showFullLoading) setLoading(true)
      else setRefreshing(true)
      setLoadError('')

      try {
        if (tab === 'active' || tab === 'pending_approval') {
          const { error: reclaimError } = await supabase.rpc('reclaim_expired_reservations')
          if (reclaimError) console.error('reclaim_expired_reservations failed:', reclaimError)
        }

        const statusFilter =
          tab === 'active'
            ? ['reserved']
            : tab === 'pending_approval'
            ? ['pending_approval']
            : ['picked_up', 'partial', 'expired', 'cancelled']

        const effectiveBranchFilter = !isAdmin ? verifierBranch : branchFilter
        const scopingToOwnSubmissions = tab === 'pending_approval' && !isAdmin
        const scopingToOwnBranch = !isAdmin && !!effectiveBranchFilter && tab !== 'history'
        const needsInnerJoin = (bankFilter || scopingToOwnBranch || scopingToOwnSubmissions) && tab !== 'history'
        const checksJoin = needsInnerJoin ? 'checks!inner' : 'checks'

        const selectClause =
          tab === 'active'
            ? `id, collector_name, status, reserved_at, expires_at, picked_up_at, queue_number, queue_date, ${checksJoin}(id, row_number, bank, pickup_branch, payee, payor, check_no, check_date, amount, status, return_reason, returned_at, returned_by_name, submitted_by, form_2307_attached)`
            : tab === 'pending_approval'
            ? `id, collector_name, status, reserved_at, expires_at, collector_id_type, collector_id_type_other, collector_id_number, queue_number, queue_date, ${checksJoin}(id, row_number, bank, pickup_branch, payee, payor, check_no, check_date, amount, or_no, remarks, submitted_at, submitted_by, submitted_by_name)`
            : 'id, collector_name, status, reserved_at, expires_at, picked_up_at, collector_id_type, collector_id_type_other, collector_id_number, queue_number, queue_date'

        let req = supabase
          .from('pickup_reservations')
          .select(selectClause)
          .in('status', statusFilter)
          .order('reserved_at', { ascending: false })
          .limit(150)

        if (bankFilter && tab !== 'history') req = req.eq('checks.bank', bankFilter)
        if (effectiveBranchFilter && tab !== 'history') req = req.eq('checks.pickup_branch', effectiveBranchFilter)
        if (scopingToOwnSubmissions && currentUserId) req = req.eq('checks.submitted_by', currentUserId)

        const { data, error } = await req

        if (!isMountedRef.current || requestId !== requestIdRef.current) return

        if (error) {
          setLoadError(error.message || 'Failed to load reservations. Please try again.')
          return
        }

        let rows = Array.isArray(data) ? data : []

        if (tab === 'active') {
          rows = rows.map((r) => ({
            ...r,
            checks: (Array.isArray(r.checks) ? r.checks : []).filter((c) => {
              const normalizedStatus = String(c?.status ?? 'reserved').trim().toLowerCase()
              return ACTIVE_TAB_CHECK_STATUSES.has(normalizedStatus) || isReturnedCheck(c)
            }),
          }))
        }

        if (scopingToOwnSubmissions && currentUserId) {
          rows = rows
            .map((r) => ({
              ...r,
              checks: (Array.isArray(r.checks) ? r.checks : []).filter((c) => c.submitted_by === currentUserId),
            }))
            .filter((r) => r.checks.length > 0)
        }

        if (effectiveBranchFilter && tab !== 'history') {
          rows = rows
            .map((r) => ({
              ...r,
              checks: (Array.isArray(r.checks) ? r.checks : []).filter((c) => c.pickup_branch === effectiveBranchFilter),
            }))
            .filter((r) => r.checks.length > 0)
        }

        if (bankFilter && tab !== 'history') {
          rows = rows
            .map((r) => ({
              ...r,
              checks: (Array.isArray(r.checks) ? r.checks : []).filter((c) => c.bank === bankFilter),
            }))
            .filter((r) => r.checks.length > 0)
        }

        if (tab === 'history' && rows.length > 0) {
          const ids = rows.map((r) => r.id)

          const { data: activity, error: activityError } = await supabase
            .from('check_activity_log')
            .select('id, reservation_id, check_id, action, or_no, remarks, performed_at, submitted_by')
            .in('reservation_id', ids)
            .order('performed_at', { ascending: true })

          if (!isMountedRef.current || requestId !== requestIdRef.current) return

          if (activityError) {
            console.error('check_activity_log fetch failed:', activityError)
          } else {
            let activityRows = activity || []

            if (!isAdmin && currentUserId) {
              const ownedCheckIds = new Set(
                activityRows.filter((a) => a.submitted_by === currentUserId).map((a) => a.check_id)
              )
              activityRows = activityRows.filter((a) => ownedCheckIds.has(a.check_id))
            }

            const checkIds = [...new Set(activityRows.map((a) => a.check_id).filter(Boolean))]

            let checksById = new Map()
            if (checkIds.length > 0) {
              const { data: checksData, error: checksError } = await supabase
                .from('checks')
                .select('id, row_number, bank, pickup_branch, payee, payor, check_no, check_date, amount')
                .in('id', checkIds)

              if (!isMountedRef.current || requestId !== requestIdRef.current) return

              if (checksError) {
                console.error('checks lookup for history failed:', checksError)
              } else {
                checksById = new Map((checksData || []).map((c) => [c.id, c]))
              }
            }

            const byReservation = new Map()
            activityRows.forEach((a) => {
              const enriched = { ...a, checks: checksById.get(a.check_id) || null }
              if (!byReservation.has(a.reservation_id)) byReservation.set(a.reservation_id, [])
              byReservation.get(a.reservation_id).push(enriched)
            })

            const idsMissingActivity = rows.map((r) => r.id).filter((id) => !(byReservation.get(id) || []).length)

            if (idsMissingActivity.length > 0) {
              const { data: fallbackChecks, error: fallbackError } = await supabase
                .from('checks')
                .select('id, reservation_id, row_number, bank, pickup_branch, payee, payor, check_no, check_date, amount, status, submitted_by')
                .in('reservation_id', idsMissingActivity)

              if (!isMountedRef.current || requestId !== requestIdRef.current) return

              if (fallbackError) {
                console.error('fallback checks lookup for history failed:', fallbackError)
              } else {
                ;(fallbackChecks || [])
                  .filter((c) => isAdmin || !currentUserId || c.submitted_by === currentUserId)
                  .filter((c) => isAdmin || !verifierBranch || c.pickup_branch === verifierBranch)
                  .forEach((c) => {
                    const syntheticOutcome =
                      c.status === 'picked_up' ? 'picked_up' : c.status === 'available' ? 'released' : c.status || 'expired'
                    const entry = {
                      id: `fallback-${c.id}`,
                      check_id: c.id,
                      action: syntheticOutcome,
                      or_no: null,
                      remarks: null,
                      performed_at: null,
                      checks: c,
                    }
                    if (!byReservation.has(c.reservation_id)) byReservation.set(c.reservation_id, [])
                    byReservation.get(c.reservation_id).push(entry)
                  })
              }
            }

            rows = rows.map((r) => ({ ...r, activity: byReservation.get(r.id) || [] }))

            if (!isAdmin && verifierBranch) {
              rows = rows.map((r) => ({
                ...r,
                activity: (r.activity || []).filter((a) => a.checks && a.checks.pickup_branch === verifierBranch),
              }))
            }

            if (!isAdmin && currentUserId) {
              rows = rows.filter((r) => (r.activity || []).length > 0)
            }

            if (bankFilter) {
              rows = rows.filter((r) => (r.activity || []).some((a) => a.checks && a.checks.bank === bankFilter))
            }
            if (branchFilter) {
              rows = rows.filter((r) => (r.activity || []).some((a) => a.checks && a.checks.pickup_branch === branchFilter))
            }
          }
        }

        setReservations(rows)
        setLastUpdated(Date.now())
        setSelectedIds((prev) => {
          if (prev.size === 0) return prev
          const validIds = new Set(rows.map((r) => r.id))
          const next = new Set([...prev].filter((id) => validIds.has(id)))
          return next.size === prev.size ? prev : next
        })
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
    [tab, bankFilter, branchFilter, isAdmin, currentUserId, verifierBranch]
  )

  function minutesLeft(expiresAt) {
    if (!expiresAt) return 0
    return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 60000))
  }

  function secondsLeft(expiresAt) {
    if (!expiresAt) return 0
    return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000))
  }

  function formatCountdown(expiresAt) {
    if (!expiresAt) return '—'
    const ms = new Date(expiresAt).getTime() - now
    if (ms <= 0) return 'Expiring…'
    const mins = Math.floor(ms / 60000)
    const secs = Math.floor((ms % 60000) / 1000)
    return `${mins}m ${secs.toString().padStart(2, '0')}s left`
  }

  function urgency(expiresAt) {
    const secs = secondsLeft(expiresAt)
    if (secs <= CRITICAL_MINUTES * 60) return 'critical'
    if (secs <= EXPIRING_SOON_MINUTES * 60) return 'warning'
    return 'normal'
  }

  const visibleReservations = useMemo(() => {
    const term = searchTerm.trim()
    let list = reservations.filter((r) => matchesSearch(r, sortedLineItems(r, tab), term))

    if (tab === 'active' && quickFilter === 'expiring') {
      list = list.filter((r) => minutesLeft(r.expires_at) <= EXPIRING_SOON_MINUTES)
    }
    if (tab === 'active' && quickFilter === 'returned') {
      list = list.filter((r) => sortedLineItems(r, 'active').some((c) => c.checkStatus === 'returned'))
    }
    if (tab === 'pending_approval' && quickFilter === 'expiring') {
      list = list.filter((r) => minutesLeft(r.expires_at) <= EXPIRING_SOON_MINUTES)
    }
    if (tab === 'history' && quickFilter !== 'all') {
      list = list.filter((r) => sortedLineItems(r, 'history').some((c) => c.outcome === quickFilter))
    }

    const withMeta = list.map((r) => ({
      r,
      total: orderTotal(sortedLineItems(r, tab)),
      submittedAtMs: tab === 'pending_approval' ? earliestSubmittedAt(sortedLineItems(r, tab)) : null,
    }))

    withMeta.sort((a, b) => {
      switch (sortBy) {
        case 'expires_asc':
          return new Date(a.r.expires_at || 0) - new Date(b.r.expires_at || 0)
        case 'submitted_asc':
          return (a.submittedAtMs || 0) - (b.submittedAtMs || 0)
        case 'submitted_desc':
          return (b.submittedAtMs || 0) - (a.submittedAtMs || 0)
        case 'reserved_asc':
          return new Date(a.r.reserved_at || 0) - new Date(b.r.reserved_at || 0)
        case 'amount_desc':
          return b.total - a.total
        case 'amount_asc':
          return a.total - b.total
        case 'collector_asc':
          return String(a.r.collector_name || '').localeCompare(String(b.r.collector_name || ''))
        case 'reserved_desc':
        default:
          return new Date(b.r.reserved_at || 0) - new Date(a.r.reserved_at || 0)
      }
    })

    return withMeta.map((x) => x.r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, searchTerm, quickFilter, sortBy, tab, now])

  const activeSummary = useMemo(() => {
    if (tab !== 'active') return null
    const minutesLeftAll = reservations.map((r) => minutesLeft(r.expires_at))
    const expiringSoon = minutesLeftAll.filter((m) => m <= EXPIRING_SOON_MINUTES).length
    const critical = minutesLeftAll.filter((m) => m <= CRITICAL_MINUTES).length
    const totalChecks = reservations.reduce((sum, r) => sum + (Array.isArray(r.checks) ? r.checks.length : 0), 0)
    const returnedCount = reservations.reduce(
      (sum, r) => sum + (Array.isArray(r.checks) ? r.checks.filter((c) => isReturnedCheck(c)).length : 0),
      0
    )
    const totalValue = reservations.reduce((sum, r) => sum + orderTotal(lineItems(r, 'active')), 0)
    const avgChecksPerOrder = reservations.length ? (totalChecks / reservations.length).toFixed(1) : '0'
    return { total: reservations.length, expiringSoon, critical, totalChecks, totalValue, avgChecksPerOrder, returnedCount }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, tab, now])

  const pendingSummary = useMemo(() => {
    if (tab !== 'pending_approval') return null
    const minutesLeftAll = reservations.map((r) => minutesLeft(r.expires_at))
    const expiringSoon = minutesLeftAll.filter((m) => m <= EXPIRING_SOON_MINUTES).length
    const critical = minutesLeftAll.filter((m) => m <= CRITICAL_MINUTES).length
    const totalChecks = reservations.reduce((sum, r) => sum + sortedLineItems(r, 'pending_approval').length, 0)
    const totalValue = reservations.reduce((sum, r) => sum + orderTotal(sortedLineItems(r, 'pending_approval')), 0)
    return { total: reservations.length, totalChecks, totalValue, expiringSoon, critical }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, tab, now])

  const historySummary = useMemo(() => {
    if (tab !== 'history') return null
    let totalChecks = 0
    let totalValue = 0
    let approved = 0
    let released = 0
    let rejected = 0
    let returned = 0
    let expired = 0
    reservations.forEach((r) => {
      const items = lineItems(r, 'history')
      totalChecks += items.length
      totalValue += orderTotal(items)
      items.forEach((c) => {
        if (c.outcome === 'picked_up' || c.outcome === 'approved') approved += 1
        else if (c.outcome === 'released') released += 1
        else if (c.outcome === 'rejected') rejected += 1
        else if (c.outcome === 'returned') returned += 1
        else if (c.outcome === 'expired') expired += 1
      })
    })
    return { total: reservations.length, totalChecks, totalValue, approved, released, rejected, returned, expired }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, tab])

  function toggleExpand(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      const visibleIds = visibleReservations.map((r) => r.id)
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id))
      if (allSelected) {
        const next = new Set(prev)
        visibleIds.forEach((id) => next.delete(id))
        return next
      }
      return new Set([...prev, ...visibleIds])
    })
  }

  const selectedReservations = useMemo(
    () => reservations.filter((r) => selectedIds.has(r.id)),
    [reservations, selectedIds]
  )

  function openConfirm(type, reservation) {
    if (actioningIds.has(reservation.id)) return
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ type, reservation })
  }

  function openBulkRecallConfirm() {
    if (selectedReservations.length === 0) return
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ type: 'bulk-recall', reservations: selectedReservations })
  }

  const closeConfirm = useCallback(() => {
    clearTimeout(successTimerRef.current)
    setSuccessFlash(null)
    setConfirmAction(null)
  }, [])

  const confirmChecks = useMemo(() => {
    if (!confirmAction?.reservation) return []
    const sourceTab = confirmAction.type === 'recall' ? 'pending_approval' : 'active'
    return sortedLineItems(confirmAction.reservation, sourceTab)
  }, [confirmAction])
  const confirmTotal = useMemo(() => orderTotal(confirmChecks), [confirmChecks])
  const isActioning = confirmAction
    ? confirmAction.type === 'bulk-recall'
      ? confirmAction.reservations.some((r) => actioningIds.has(r.id))
      : actioningIds.has(confirmAction.reservation.id)
    : false

  function findIncompleteEntry(checks, orData) {
    const seenOrNos = new Map()
    for (const c of checks) {
      const entry = orData?.[c.checkId]
      if (!entry) return { reason: 'incomplete', checkId: c.checkId }

      if (entry.include) {
        const orNo = composeReceiptNo(entry)
        if (!orNo) return { reason: 'incomplete', checkId: c.checkId }
        const normalized = orNo.toLowerCase()
        if (seenOrNos.has(normalized)) return { reason: 'duplicate', checkId: c.checkId }
        seenOrNos.set(normalized, c.checkId)
      } else if (!entry.remarks?.trim()) {
        return { reason: 'missing-reason', checkId: c.checkId }
      }
    }
    return null
  }

  async function assertReservationStillActionable(reservationId, actionType) {
    const expected = EXPECTED_STATUS_BEFORE[actionType]
    const { data, error } = await supabase
      .from('pickup_reservations')
      .select('status')
      .eq('id', reservationId)
      .maybeSingle()

    if (error) return 'Could not verify this reservation before proceeding. Please try again.'
    if (!data) return 'This reservation no longer exists. Refreshing the list.'
    if (data.status !== expected) {
      return 'This reservation was already updated by someone else. Refreshing the list.'
    }
    return null
  }

  async function runAction(payload) {
    if (!confirmAction) return

    if (confirmAction.type === 'bulk-recall') {
      const ids = confirmAction.reservations.map((r) => r.id)
      if (ids.some((id) => actioningIds.has(id))) return
      ids.forEach(lockAction)
      setActionError('')

      try {
        const reason = payload?.reason?.trim()
        if (!reason) {
          setActionError('Enter a reason for recalling these submissions.')
          return
        }

        if (!isAdmin && currentUserId) {
          const hasForeignCheck = confirmAction.reservations.some((r) =>
            (Array.isArray(r.checks) ? r.checks : []).some((c) => c.submitted_by !== currentUserId)
          )
          if (hasForeignCheck) {
            setActionError('You can only recall submissions you submitted yourself.')
            return
          }
        }

        const staleChecks = await Promise.all(
          confirmAction.reservations.map((r) => assertReservationStillActionable(r.id, 'bulk-recall'))
        )
        if (staleChecks.some(Boolean)) {
          setActionError('One or more selected submissions changed elsewhere. Refreshing the list.')
          load(false)
          return
        }

        const results = await Promise.allSettled(
          confirmAction.reservations.map((r) =>
            supabase.rpc('admin_recall_submission', {
              p_reservation_id: r.id,
              p_check_ids: sortedLineItems(r, 'pending_approval').map((c) => c.checkId),
              p_reason: reason,
            })
          )
        )
        const failed = results.filter((res) => res.status === 'rejected' || res.value?.error).length
        const succeeded = results.length - failed

        if (!isMountedRef.current) return

        if (failed > 0 && succeeded === 0) {
          setActionError('Could not recall the selected submissions. Please try again.')
          return
        }

        setConfirmAction(null)
        setSelectedIds(new Set())
        load(false)
        showToast(
          failed > 0
            ? `Recalled ${succeeded} of ${results.length}. ${failed} failed — try again.`
            : `Recalled ${succeeded} submission${succeeded === 1 ? '' : 's'}.`,
          failed > 0 ? 'warning' : 'success'
        )
      } catch (err) {
        if (isMountedRef.current) setActionError(err?.message || 'Something went wrong. Please try again.')
      } finally {
        ids.forEach(unlockAction)
      }
      return
    }

    const reservationId = confirmAction.reservation.id
    if (actioningIds.has(reservationId)) return
    lockAction(reservationId)
    setActionError('')

    try {
      const isSubmit = confirmAction.type === 'submit'
      const isRecall = confirmAction.type === 'recall'
      const fn = isSubmit ? 'admin_submit_for_approval' : 'admin_recall_submission'
      const rpcParams = { p_reservation_id: reservationId }

      const staleError = await assertReservationStillActionable(reservationId, confirmAction.type)
      if (staleError) {
        setActionError(staleError)
        load(false)
        return
      }

      let pickedCount = 0
      let releasedCount = 0

      if (isSubmit) {
        const { checkOutcomes: orData, collectorId } = payload

        if (!isCollectorIdComplete(collectorId)) {
          setActionError("Record the collector's ID type and number before submitting.")
          return
        }

        const problem = findIncompleteEntry(confirmChecks, orData)
        if (problem) {
          setActionError(
            problem.reason === 'duplicate'
              ? 'Each check being picked up needs its own unique receipt type + number.'
              : problem.reason === 'missing-reason'
              ? 'Enter a reason for every check left off the pickup.'
              : 'Select a receipt type and enter its number for every check being picked up.'
          )
          return
        }

        rpcParams.p_check_outcomes = confirmChecks.map((c) => {
          const entry = orData[c.checkId]
          if (entry.include) {
            pickedCount += 1
            return {
              check_id: c.checkId,
              picked_up: true,
              or_no: composeReceiptNo(entry),
              ar_collected: entry.receiptType === 'AR',
              attached_2307: !!c.attached2307,
              remarks: null,
            }
          }
          releasedCount += 1
          return { check_id: c.checkId, picked_up: false, remarks: entry.remarks.trim() }
        })

        rpcParams.p_collector_id_type = collectorId.idType
        rpcParams.p_collector_id_type_other = collectorId.idType === 'other' ? collectorId.idTypeOther.trim() : null
        rpcParams.p_collector_id_number = collectorId.idNumber.trim()
      } else if (isRecall) {
        const reason = payload?.reason?.trim()
        if (!reason) {
          setActionError('Enter a reason for recalling this submission.')
          return
        }

        if (!isAdmin && currentUserId) {
          const hasForeignCheck = confirmChecks.some((c) => c.submittedBy && c.submittedBy !== currentUserId)
          if (hasForeignCheck) {
            setActionError('You can only recall submissions you submitted yourself.')
            return
          }
        }

        rpcParams.p_check_ids = confirmChecks.map((c) => c.checkId)
        rpcParams.p_reason = reason
      }

      const { error } = await supabase.rpc(fn, rpcParams)

      if (!isMountedRef.current) return

      if (error) {
        setActionError(error.message || 'Something went wrong. Please try again.')
        return
      }

      const collectorName = confirmAction.reservation.collector_name || 'Order'

      if (isSubmit) {
        const summary =
          releasedCount > 0
            ? `${pickedCount} of ${pickedCount + releasedCount} submitted for approval`
            : `${collectorName} submitted for approval`
        setSuccessFlash({ message: summary })
        clearTimeout(successTimerRef.current)
        successTimerRef.current = setTimeout(() => {
          if (!isMountedRef.current) return
          setSuccessFlash(null)
          setConfirmAction(null)
        }, SUCCESS_FLASH_MS)
      } else {
        setConfirmAction(null)
      }

      load(false)
      showToast(
        isSubmit
          ? releasedCount > 0
            ? `Sent ${pickedCount} of ${pickedCount + releasedCount} checks to approval for ${collectorName}; ${releasedCount} released.`
            : `Sent ${collectorName}'s pickup to approval.`
          : `Recalled ${collectorName}'s submission for edits.`
      )
    } catch (err) {
      if (isMountedRef.current) setActionError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      unlockAction(reservationId)
    }
  }

  function exportCsv() {
    const isHistory = tab === 'history'
    const isPending = tab === 'pending_approval'
    const isActive = tab === 'active'
    const headers = isHistory
      ? ['Queue #', 'Collector', 'Collector ID type', 'Collector ID no.', 'Status', 'Reserved at', 'Resolved at', 'Bank', 'Pickup branch', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'Outcome', 'Receipt no.', 'Remarks']
      : isPending
      ? ['Queue #', 'Collector', 'Collector ID type', 'Collector ID no.', 'Status', 'Reserved at', 'Bank', 'Pickup branch', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'Receipt no.', 'Remarks', 'Submitted by', 'Submitted at']
      : isActive
      ? ['Queue #', 'Collector', 'Status', 'Reserved at', 'Bank', 'Pickup branch', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'Check status', 'Return reason', 'Returned by', 'Returned at']
      : ['Queue #', 'Collector', 'Status', 'Reserved at', 'Bank', 'Pickup branch', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount']

    const rows = [headers]
    visibleReservations.forEach((r) => {
      const items = sortedLineItems(r, tab)
      const reservationBranch = items[0]?.pickupBranch || null
      const queueCode = formatQueueCode(reservationBranch, r.queue_number) || ''

      if (items.length === 0) {
        rows.push(
          isHistory
            ? [queueCode, r.collector_name || '', formatCollectorId(r) ? (r.collector_id_type === 'other' ? (r.collector_id_type_other || 'Other ID') : (COLLECTOR_ID_TYPE_LABELS[r.collector_id_type] || '')) : '', r.collector_id_number || '', r.status || '', r.reserved_at || '', r.picked_up_at || '', '', '', '', '', '', '', '', '', '', '']
            : isPending
            ? [queueCode, r.collector_name || '', formatCollectorId(r) ? (r.collector_id_type === 'other' ? (r.collector_id_type_other || 'Other ID') : (COLLECTOR_ID_TYPE_LABELS[r.collector_id_type] || '')) : '', r.collector_id_number || '', r.status || '', r.reserved_at || '', '', '', '', '', '', '', '', '', '', '']
            : isActive
            ? [queueCode, r.collector_name || '', r.status || '', r.reserved_at || '', '', '', '', '', '', '', '', '', '', '']
            : [queueCode, r.collector_name || '', r.status || '', r.reserved_at || '', '', '', '', '', '', '']
        )
        return
      }

      items.forEach((c) => {
        const branchLabel = PICKUP_BRANCH_LABELS[c.pickupBranch] || c.pickupBranch || ''
        rows.push(
          isHistory
            ? [
                queueCode, r.collector_name || '',
                r.collector_id_type === 'other' ? (r.collector_id_type_other || 'Other ID') : (COLLECTOR_ID_TYPE_LABELS[r.collector_id_type] || ''),
                r.collector_id_number || '', r.status || '', r.reserved_at || '', r.picked_up_at || '',
                c.bank || '', branchLabel, c.check_no || '', c.payee || '', c.payor || '', c.check_date || '', c.amount ?? '',
                c.outcome || '', c.or_no || '', c.remarks || '',
              ]
            : isPending
            ? [
                queueCode, r.collector_name || '',
                r.collector_id_type === 'other' ? (r.collector_id_type_other || 'Other ID') : (COLLECTOR_ID_TYPE_LABELS[r.collector_id_type] || ''),
                r.collector_id_number || '', r.status || '', r.reserved_at || '',
                c.bank || '', branchLabel, c.check_no || '', c.payee || '', c.payor || '', c.check_date || '', c.amount ?? '',
                c.or_no || '', c.remarks || '', c.submittedByName || '', c.submittedAt || '',
              ]
            : isActive
            ? [
                queueCode, r.collector_name || '', r.status || '', r.reserved_at || '',
                c.bank || '', branchLabel, c.check_no || '', c.payee || '', c.payor || '', c.check_date || '', c.amount ?? '',
                c.checkStatus === 'returned' ? 'Returned' : 'Reserved', c.returnReason || '', c.returnedByName || '', c.returnedAt || '',
              ]
            : [
                queueCode, r.collector_name || '', r.status || '', r.reserved_at || '',
                c.bank || '', branchLabel, c.check_no || '', c.payee || '', c.payor || '', c.check_date || '', c.amount ?? '',
              ]
        )
      })
    })

    const csv = rows
      .map((row) =>
        row.map((cell) => {
          const str = String(cell ?? '')
          return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
        }).join(',')
      )
      .join('\n')

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pickup-${tab}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const allVisibleSelected = visibleReservations.length > 0 && visibleReservations.every((r) => selectedIds.has(r.id))
  const someVisibleSelected = visibleReservations.some((r) => selectedIds.has(r.id))
  const activeSortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label || 'Sort'
  const selectable = tab === 'pending_approval'

  return (
    <div className="pb-20 sm:pb-0">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-900">Pending pickups</h1>
          <p className="mt-1 text-sm text-ink-400">
            Checks collectors have reserved and their remaining pickup window. Submitting a pickup sends it to
            an approver for verification before it's final.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="hidden text-xs text-ink-400 sm:inline">
              Updated <LiveRelativeTime timestamp={lastUpdated} now={now} />
            </span>
          )}
          {(tab === 'active' || tab === 'pending_approval') && (
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className="flex items-center gap-1.5 rounded-md border border-ink-200 px-2.5 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50"
              title={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
              aria-pressed={autoRefresh}
            >
              {autoRefresh ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{autoRefresh ? 'Live' : 'Paused'}</span>
            </button>
          )}
          <button
            onClick={() => load(false)}
            disabled={refreshing || loading}
            className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {!isAdmin && verifierBranch && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-700">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          Showing checks for {PICKUP_BRANCH_LABELS[verifierBranch] || verifierBranch} only.
        </div>
      )}

      {tab === 'active' && activeSummary && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard icon={User} label="Active orders" value={loading ? null : activeSummary.total} secondary={loading ? null : `${activeSummary.avgChecksPerOrder} checks/order avg`} accent="lightTeal" />
          <KpiCard icon={Layers} label="Checks on hold" value={loading ? null : activeSummary.totalChecks} secondary={loading ? null : formatCurrency(activeSummary.totalValue)} accent="ink" />
          <KpiCard icon={Wallet} label="Total value" value={loading ? null : formatCurrency(activeSummary.totalValue)} secondary={loading ? null : `${formatCurrency(activeSummary.totalValue / (activeSummary.total || 1))} avg/order`} accent="sky" />
          <KpiCard icon={Timer} label={`Expiring ≤ ${EXPIRING_SOON_MINUTES}m`} value={loading ? null : activeSummary.expiringSoon} secondary={loading ? null : `${activeSummary.critical} of these ≤ ${CRITICAL_MINUTES}m`} accent={!loading && activeSummary.expiringSoon > 0 ? 'orange' : 'ink'} active={quickFilter === 'expiring'} onClick={() => setQuickFilter((f) => (f === 'expiring' ? 'all' : 'expiring'))} />
          <KpiCard icon={Flame} label={`Critical ≤ ${CRITICAL_MINUTES}m`} value={loading ? null : activeSummary.critical} secondary={!loading && activeSummary.critical > 0 ? 'Needs immediate attention' : null} accent={!loading && activeSummary.critical > 0 ? 'red' : 'ink'} />
          <KpiCard icon={RotateCcw} label="Returned for correction" value={loading ? null : activeSummary.returnedCount} secondary={!loading && activeSummary.returnedCount > 0 ? 'An approver sent these back' : null} accent={!loading && activeSummary.returnedCount > 0 ? 'amber' : 'ink'} active={quickFilter === 'returned'} onClick={() => setQuickFilter((f) => (f === 'returned' ? 'all' : 'returned'))} />
        </div>
      )}

      {tab === 'pending_approval' && pendingSummary && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiCard icon={ShieldCheck} label="Awaiting approval" value={loading ? null : pendingSummary.total} accent="lightTeal" />
          <KpiCard icon={Hash} label="Checks submitted" value={loading ? null : pendingSummary.totalChecks} secondary={loading ? null : formatCurrency(pendingSummary.totalValue)} accent="ink" />
          <KpiCard icon={Wallet} label="Total value" value={loading ? null : formatCurrency(pendingSummary.totalValue)} secondary={loading ? null : `${formatCurrency(pendingSummary.totalValue / (pendingSummary.total || 1))} avg/submission`} accent="sky" />
          <KpiCard icon={Timer} label={`Expiring ≤ ${EXPIRING_SOON_MINUTES}m`} value={loading ? null : pendingSummary.expiringSoon} secondary={loading ? null : `${pendingSummary.critical} of these ≤ ${CRITICAL_MINUTES}m`} accent={!loading && pendingSummary.expiringSoon > 0 ? 'orange' : 'ink'} active={quickFilter === 'expiring'} onClick={() => setQuickFilter((f) => (f === 'expiring' ? 'all' : 'expiring'))} />
          <KpiCard icon={Flame} label={`Critical ≤ ${CRITICAL_MINUTES}m`} value={loading ? null : pendingSummary.critical} secondary={!loading && pendingSummary.critical > 0 ? 'Escalate to an approver' : null} accent={!loading && pendingSummary.critical > 0 ? 'red' : 'ink'} />
        </div>
      )}

      {tab === 'history' && historySummary && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard icon={Layers} label="Orders" value={loading ? null : historySummary.total} secondary={loading ? null : `${historySummary.totalChecks} checks total`} accent="lightTeal" />
          <KpiCard icon={Wallet} label="Total value" value={loading ? null : formatCurrency(historySummary.totalValue)} secondary={loading ? null : `${historySummary.totalChecks} checks`} accent="sky" />
          <KpiCard icon={CheckCircle2} label="Approved & picked up" value={loading ? null : historySummary.approved} secondary="Confirmed by an approver" accent="teal" active={quickFilter === 'picked_up'} onClick={() => setQuickFilter((f) => (f === 'picked_up' ? 'all' : 'picked_up'))} />
          <KpiCard icon={Undo2} label="Released" value={loading ? null : historySummary.released} secondary="Left off at submission" accent="ink" active={quickFilter === 'released'} onClick={() => setQuickFilter((f) => (f === 'released' ? 'all' : 'released'))} />
          <KpiCard icon={XCircle} label="Rejected" value={loading ? null : historySummary.rejected} secondary={!loading && historySummary.rejected > 0 ? 'Sent back to the pool' : null} accent={!loading && historySummary.rejected > 0 ? 'red' : 'ink'} active={quickFilter === 'rejected'} onClick={() => setQuickFilter((f) => (f === 'rejected' ? 'all' : 'rejected'))} />
          <KpiCard icon={RotateCcw} label="Returned / Expired" value={loading ? null : historySummary.returned + historySummary.expired} secondary={!loading ? `${historySummary.returned} returned · ${historySummary.expired} expired` : null} accent={!loading && historySummary.returned + historySummary.expired > 0 ? 'amber' : 'ink'} active={quickFilter === 'returned' || quickFilter === 'expired'} onClick={() => setQuickFilter((f) => (f === 'returned' ? 'all' : 'returned'))} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md border border-ink-200 p-1">
          <TabButton active={tab === 'active'} onClick={() => setTab('active')}>Active</TabButton>
          <TabButton active={tab === 'pending_approval'} onClick={() => setTab('pending_approval')}>Pending Approval</TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>History</TabButton>
        </div>

        <button
          onClick={exportCsv}
          disabled={visibleReservations.length === 0}
          className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative shrink-0 sm:w-56">
          <Landmark className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <select
            value={bankFilter}
            onChange={(e) => setBankFilter(e.target.value)}
            aria-label="Filter by bank"
            className="w-full rounded-md border border-ink-200 bg-white py-2 pl-9 pr-8 text-sm text-ink-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-500"
          >
            <option value="">All banks</option>
            {BANKS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        <div className="relative shrink-0 sm:w-48">
          <Building2 className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <select
            value={branchFilter}
            onChange={(e) => !isAdmin ? null : setBranchFilter(e.target.value)}
            disabled={!isAdmin}
            aria-label="Filter by pickup branch"
            title={!isAdmin ? 'Locked to your assigned branch' : undefined}
            className="w-full rounded-md border border-ink-200 bg-white py-2 pl-9 pr-8 text-sm text-ink-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-400"
          >
            <option value="">All branches</option>
            {PICKUP_BRANCHES.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </div>

        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search collector, check #, payee, payor, receipt no., bank, or branch... (press /)"
            className="border-ink-200 pl-9 pr-8 text-sm focus-visible:ring-teal-500"
            aria-label="Search collector name, check number, payee, payor, receipt no., bank, or branch"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600" aria-label="Clear search">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="relative shrink-0">
          <button
            onClick={() => setSortMenuOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 sm:w-auto"
            aria-haspopup="listbox"
            aria-expanded={sortMenuOpen}
          >
            <span className="flex items-center gap-1.5">
              <ArrowUpDown className="h-3.5 w-3.5" />
              {activeSortLabel}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-ink-400" />
          </button>
          {sortMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setSortMenuOpen(false)} />
              <div role="listbox" className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-ink-200 bg-white py-1 shadow-lg">
                {SORT_OPTIONS.filter((o) => o.tabs.includes(tab)).map((o) => (
                  <button
                    key={o.value}
                    role="option"
                    aria-selected={sortBy === o.value}
                    onClick={() => {
                      setSortBy(o.value)
                      setSortMenuOpen(false)
                    }}
                    className={cn('flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-ink-50', sortBy === o.value ? 'text-teal-700' : 'text-ink-600')}
                  >
                    {o.label}
                    {sortBy === o.value && <Check className="h-3.5 w-3.5" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {loadError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {loadError}
          </span>
          <button onClick={() => load(loading)} className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100">
            Retry
          </button>
        </div>
      )}

      {selectable && visibleReservations.length > 0 && !loading && (
        <div className="mb-2 flex items-center gap-2 px-1">
          <button onClick={toggleSelectAllVisible} className="flex items-center gap-1.5 text-xs font-medium text-ink-500 hover:text-ink-700">
            {allVisibleSelected ? <CheckSquare className="h-4 w-4 text-teal-600" /> : someVisibleSelected ? <MinusSquare className="h-4 w-4 text-teal-600" /> : <Square className="h-4 w-4" />}
            {allVisibleSelected ? 'Deselect all' : 'Select all'}
          </button>
          {selectedIds.size > 0 && <span className="text-xs text-ink-400">{selectedIds.size} selected</span>}
        </div>
      )}

      {loading ? (
        <ListSkeleton />
      ) : visibleReservations.length === 0 ? (
        <EmptyState tab={tab} hasFilter={!!searchTerm.trim() || !!bankFilter || (isAdmin && !!branchFilter) || quickFilter !== 'all'} />
      ) : (
        <div className="space-y-2.5">
          {visibleReservations.map((r) => {
            const items = sortedLineItems(r, tab)
            const hasExpiry = tab === 'active' || tab === 'pending_approval'
            return (
              <ReservationRow
                key={r.id}
                reservation={r}
                items={items}
                total={orderTotal(items)}
                tab={tab}
                minutesLeft={hasExpiry ? minutesLeft(r.expires_at) : null}
                countdownLabel={hasExpiry ? formatCountdown(r.expires_at) : null}
                urgencyLevel={hasExpiry ? urgency(r.expires_at) : 'normal'}
                expanded={expandedIds.has(r.id)}
                onToggleExpand={() => toggleExpand(r.id)}
                selectable={selectable}
                selected={selectedIds.has(r.id)}
                onToggleSelect={() => toggleSelect(r.id)}
                onConfirmPickup={() => openConfirm('submit', r)}
                onRecall={() => openConfirm('recall', r)}
                locked={actioningIds.has(r.id)}
              />
            )
          })}
        </div>
      )}

      {selectable && selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-100 bg-white px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] sm:sticky sm:mt-4 sm:rounded-lg sm:border sm:shadow-sm">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <span className="text-sm font-medium text-ink-700">{selectedIds.size} order{selectedIds.size === 1 ? '' : 's'} selected</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setSelectedIds(new Set())} className="rounded-md px-3 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50">
                Clear
              </button>
              {tab === 'pending_approval' && (
                <button onClick={openBulkRecallConfirm} className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50">
                  <RotateCcw className="h-3.5 w-3.5" />
                  Recall selected
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <ActionModal
          action={confirmAction}
          checks={confirmChecks}
          total={confirmTotal}
          onCancel={closeConfirm}
          onConfirm={runAction}
          loading={isActioning}
          error={actionError}
          successFlash={successFlash}
        />
      )}

      {toast && <Toast message={toast.message} variant={toast.variant} />}
    </div>
  )
}

function LiveRelativeTime({ timestamp, now }) {
  const secs = Math.max(0, Math.round((now - timestamp) / 1000))
  if (secs < 5) return <span>just now</span>
  if (secs < 60) return <span>{secs}s ago</span>
  const mins = Math.floor(secs / 60)
  return <span>{mins}m ago</span>
}

function Toast({ message, variant }) {
  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 sm:bottom-6">
      <div className={cn('flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium text-white shadow-lg', variant === 'warning' ? 'bg-orange-600' : 'bg-ink-900')}>
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        {message}
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={cn('rounded px-3.5 py-1.5 text-sm font-medium transition', active ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-50')}>
      {children}
    </button>
  )
}

function KpiCard({ icon: Icon, label, value, secondary, accent = 'ink', onClick, active }) {
  const accents = {
    teal: { ring: 'border-teal-200', badge: 'bg-teal-100 text-teal-700', activeRing: 'ring-teal-400' },
    lightTeal: { ring: 'border-teal-200', badge: 'bg-teal-50 text-teal-600', activeRing: 'ring-teal-400' },
    sky: { ring: 'border-sky-200', badge: 'bg-sky-50 text-sky-600', activeRing: 'ring-sky-400' },
    orange: { ring: 'border-orange-200', badge: 'bg-orange-100 text-orange-600', activeRing: 'ring-orange-400' },
    amber: { ring: 'border-amber-200', badge: 'bg-amber-100 text-amber-700', activeRing: 'ring-amber-400' },
    red: { ring: 'border-red-200', badge: 'bg-red-100 text-red-600', activeRing: 'ring-red-400' },
    ink: { ring: 'border-ink-100', badge: 'bg-ink-100 text-ink-600', activeRing: 'ring-ink-400' },
  }
  const style = accents[accent] || accents.ink
  const isLoading = value === null || value === undefined
  const isInteractive = typeof onClick === 'function'

  const card = (
    <Card className={cn('relative overflow-hidden p-3 transition', isInteractive && 'hover:border-ink-200 hover:shadow-sm', active && cn('ring-2', style.activeRing))}>
      <div className={cn('pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed', style.ring)} aria-hidden="true" />
      <div className="relative flex items-start gap-2.5">
        <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', style.badge)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? <div className="h-5 w-12 animate-pulse rounded bg-ink-100" /> : <p className="truncate font-display text-sm font-semibold text-ink-900">{value}</p>}
          <p className="truncate text-[10px] font-medium uppercase tracking-wide text-ink-400">{label}</p>
          {!isLoading && secondary && <p className="mt-0.5 truncate text-[10px] text-ink-500">{secondary}</p>}
        </div>
      </div>
    </Card>
  )

  if (isInteractive) {
    return (
      <button type="button" onClick={onClick} className="text-left" aria-pressed={!!active}>
        {card}
      </button>
    )
  }
  return card
}

function StatusBadge({ status }) {
  const styles = {
    reserved: 'bg-teal-100 text-teal-700',
    pending_approval: 'bg-amber-100 text-amber-700',
    picked_up: 'bg-teal-100 text-teal-700',
    partial: 'bg-amber-100 text-amber-700',
    expired: 'bg-slate-100 text-slate-500',
    cancelled: 'bg-orange-100 text-orange-700',
  }
  const labels = {
    reserved: 'Reserved',
    pending_approval: 'Pending approval',
    picked_up: 'Picked up',
    partial: 'Partially picked up',
    expired: 'Expired',
    cancelled: 'Released',
  }
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-medium', styles[status] || 'bg-ink-100 text-ink-600')}>
      {labels[status] || status || 'Unknown'}
    </span>
  )
}

function ActiveCheckStatusBadge({ status }) {
  if (status === 'returned') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        <RotateCcw className="h-3 w-3" />
        Returned
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">
      Reserved
    </span>
  )
}

function BankBadge({ bank }) {
  if (!bank) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-ink-200 px-2 py-0.5 text-[11px] font-medium text-ink-400">
        <Landmark className="h-3 w-3" />
        Unknown
      </span>
    )
  }
  return (
    <span className="inline-flex max-w-[150px] items-center gap-1 truncate rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700" title={bank}>
      <Landmark className="h-3 w-3 shrink-0" />
      <span className="truncate">{bank}</span>
    </span>
  )
}

function BranchBadge({ branch }) {
  if (!branch) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-ink-200 px-2 py-0.5 text-[11px] font-medium text-ink-400">
        <Building2 className="h-3 w-3" />
        Unknown
      </span>
    )
  }
  const label = PICKUP_BRANCH_LABELS[branch] || branch
  return (
    <span className="inline-flex max-w-[150px] items-center gap-1 truncate rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700" title={label}>
      <Building2 className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}

function OutcomeBadge({ outcome }) {
  if (outcome === 'picked_up' || outcome === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">
        <Check className="h-3 w-3" />
        Approved &amp; picked up
      </span>
    )
  }
  if (outcome === 'submitted_for_approval') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-700">
        <Send className="h-3 w-3" />
        Submitted
      </span>
    )
  }
  if (outcome === 'released') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
        <Undo2 className="h-3 w-3" />
        Released
      </span>
    )
  }
  if (outcome === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
        <XCircle className="h-3 w-3" />
        Rejected by approver
      </span>
    )
  }
  if (outcome === 'returned') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        <RotateCcw className="h-3 w-3" />
        Returned for correction
      </span>
    )
  }
  if (outcome === 'recalled') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">
        <Undo2 className="h-3 w-3" />
        Recalled for correction
      </span>
    )
  }
  if (outcome === 'expired') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">
        <AlertTriangle className="h-3 w-3" />
        Expired
      </span>
    )
  }
  return null
}

function ReservationRow({
  reservation, items, total, tab, countdownLabel, urgencyLevel,
  expanded, onToggleExpand, selectable, selected, onToggleSelect, onConfirmPickup, onRecall, locked,
}) {
  const checkCount = items.length
  const preview = payeePreview(items)
  const isHistory = tab === 'history'
  const isPending = tab === 'pending_approval'
  const isActive = tab === 'active'
  const hasExpiry = isActive || isPending
  const anyReturned = isActive && items.some((c) => c.checkStatus === 'returned')
  const returnedCount = isActive ? items.filter((c) => c.checkStatus === 'returned').length : 0

  const pickedCount = isHistory ? items.filter((c) => c.outcome === 'picked_up').length : 0
  const releasedCount = isHistory ? items.filter((c) => c.outcome === 'released').length : 0

  const collectorIdLabel = (isPending || isHistory) ? formatCollectorId(reservation) : null

  const reservationBranch = items[0]?.pickupBranch || null
  const queueCode = formatQueueCode(reservationBranch, reservation.queue_number)

  const borderClass =
    urgencyLevel === 'critical' ? 'border-red-300'
    : urgencyLevel === 'warning' ? 'border-orange-300'
    : anyReturned ? 'border-amber-300'
    : 'border-ink-100'

  return (
    <Card className={cn('overflow-hidden p-0', borderClass)}>
      <div className="flex items-start gap-2.5 px-3 py-3 sm:items-center sm:px-4">
        {selectable && (
          <button onClick={onToggleSelect} className="mt-0.5 shrink-0 text-ink-300 hover:text-teal-600 sm:mt-0" aria-label={selected ? 'Deselect order' : 'Select order'}>
            {selected ? <CheckSquare className="h-4.5 w-4.5 text-teal-600" /> : <Square className="h-4.5 w-4.5" />}
          </button>
        )}

        <button onClick={onToggleExpand} className="flex min-w-0 flex-1 flex-col gap-1.5 text-left sm:flex-row sm:items-center sm:gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <User className="h-4 w-4 shrink-0 text-ink-400" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                {queueCode && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-ink-900 px-2 py-0.5 font-mono text-[11px] font-bold text-white">
                    <Hash className="h-3 w-3" />
                    {queueCode}
                  </span>
                )}
                <span className="truncate font-medium text-ink-900">{reservation.collector_name || 'Unknown collector'}</span>
                <StatusBadge status={reservation.status} />
                {locked && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Processing
                  </span>
                )}
                {anyReturned && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    <RotateCcw className="h-3 w-3" />
                    {returnedCount} returned for correction
                  </span>
                )}
              </div>
              {collectorIdLabel && (
                <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] font-medium text-ink-500">
                  <CreditCard className="h-3 w-3 shrink-0 text-ink-300" />
                  {collectorIdLabel}
                </p>
              )}
              {preview && <p className="truncate text-xs text-ink-400">{preview}</p>}
              {reservation.status === 'partial' && (
                <p className="mt-0.5 text-[11px] font-medium text-amber-600">
                  {pickedCount} picked up · {releasedCount} released
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-ink-500 sm:pl-0">
            <span className="flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 font-medium text-ink-600">
              <Layers className="h-3 w-3" />
              {checkCount} check{checkCount === 1 ? '' : 's'}
            </span>
            <span className="font-mono font-semibold text-ink-800">{formatCurrency(total)}</span>
            {hasExpiry ? (
              <span className={cn('flex items-center gap-1 font-mono font-medium', urgencyLevel === 'critical' ? 'text-red-600' : urgencyLevel === 'warning' ? 'text-orange-600' : 'text-teal-700')}>
                <Clock className="h-3.5 w-3.5" />
                {countdownLabel}
              </span>
            ) : (
              <span>
                Reserved {formatDate(reservation.reserved_at)}
                {reservation.picked_up_at && ` · Resolved ${formatDate(reservation.picked_up_at)}`}
              </span>
            )}
            {expanded ? <ChevronUp className="h-4 w-4 text-ink-300" /> : <ChevronDown className="h-4 w-4 text-ink-300" />}
          </div>
        </button>
      </div>

      {expanded && (
        <>
          {checkCount === 0 ? (
            <p className="border-t border-ink-100 px-4 py-3 text-xs text-ink-400">
              {isHistory ? "No logged activity found for this order yet." : 'No linked checks found for this order.'}
            </p>
          ) : (
            <div className="overflow-x-auto border-t border-ink-100">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-ink-50 text-left text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="px-4 py-2 font-medium">#</th>
                    <th className="px-2 py-2 font-medium">Bank</th>
                    <th className="px-2 py-2 font-medium">Branch</th>
                    <th className="px-2 py-2 font-medium">Check no.</th>
                    <th className="px-2 py-2 font-medium">Payee</th>
                    <th className="px-2 py-2 font-medium">Payor</th>
                    <th className="px-2 py-2 font-medium">Check date</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    {isActive && <th className="px-2 py-2 font-medium">Status</th>}
                    {isActive && anyReturned && <th className="px-2 py-2 font-medium">Return reason</th>}
                    {isActive && anyReturned && <th className="px-2 py-2 font-medium">Returned by</th>}
                    {isActive && anyReturned && <th className="px-4 py-2 font-medium">Returned at</th>}
                    {isPending && <th className="px-2 py-2 font-medium">Receipt no.</th>}
                    {isPending && <th className="px-4 py-2 font-medium">Remarks</th>}
                    {isHistory && <th className="px-2 py-2 font-medium">Outcome</th>}
                    {isHistory && <th className="px-2 py-2 font-medium">Receipt no.</th>}
                    {isHistory && <th className="px-4 py-2 font-medium">Remarks</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {items.map((c, idx) => (
                    <tr key={c.id ?? `${reservation.id}-${idx}`} className={cn(isActive && c.checkStatus === 'returned' && 'bg-amber-50/60')}>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-400">{idx + 1}</td>
                      <td className="px-2 py-2.5"><BankBadge bank={c.bank} /></td>
                      <td className="px-2 py-2.5"><BranchBadge branch={c.pickupBranch} /></td>
                      <td className="px-2 py-2.5 font-mono text-xs text-ink-700">
                        <span className="flex items-center gap-1">
                          <Hash className="h-3 w-3 text-ink-300" />
                          {c.check_no || '—'}
                        </span>
                      </td>
                      <td className="max-w-[180px] truncate px-2 py-2.5 font-medium text-ink-900" title={c.payee || undefined}>{c.payee || '—'}</td>
                      <td className="max-w-[180px] truncate px-2 py-2.5 text-ink-600" title={c.payor || undefined}>{c.payor || '—'}</td>
                      <td className="px-2 py-2.5 text-xs text-ink-500">
                        <span className="flex items-center gap-1">
                          <CalendarDays className="h-3 w-3 text-ink-300" />
                          {c.check_date ? formatDate(c.check_date) : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-medium text-ink-700">{formatCurrency(c.amount)}</td>
                      {isActive && <td className="px-2 py-2.5"><ActiveCheckStatusBadge status={c.checkStatus} /></td>}
                      {isActive && anyReturned && (
                        <td className="max-w-[220px] px-2 py-2.5 text-xs text-ink-600">
                          {c.checkStatus === 'returned' ? <span title={c.returnReason || undefined}>{c.returnReason || '—'}</span> : <span className="text-ink-300">—</span>}
                        </td>
                      )}
                      {isActive && anyReturned && (
                        <td className="px-2 py-2.5 text-xs text-ink-600">
                          {c.checkStatus === 'returned' ? c.returnedByName || '—' : <span className="text-ink-300">—</span>}
                        </td>
                      )}
                      {isActive && anyReturned && (
                        <td className="px-4 py-2.5 text-xs text-ink-500">
                          {c.checkStatus === 'returned' ? formatDateTime(c.returnedAt) : <span className="text-ink-300">—</span>}
                        </td>
                      )}
                      {isPending && <td className="px-2 py-2.5 font-mono text-xs text-ink-600">{c.or_no || '—'}</td>}
                      {isPending && <td className="max-w-[220px] px-4 py-2.5 text-xs text-ink-500">{c.remarks || '—'}</td>}
                      {isHistory && <td className="px-2 py-2.5"><OutcomeBadge outcome={c.outcome} /></td>}
                      {isHistory && <td className="px-2 py-2.5 font-mono text-xs text-ink-600">{c.or_no || '—'}</td>}
                      {isHistory && <td className="max-w-[220px] px-4 py-2.5 text-xs text-ink-500">{c.remarks || '—'}</td>}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-100 bg-ink-50/40">
                    <td colSpan={7} className="px-4 py-2 text-right text-xs font-medium text-ink-500">Order total</td>
                    <td className="px-4 py-2 text-right font-mono font-semibold text-ink-900">{formatCurrency(total)}</td>
                    {isHistory && <td colSpan={3} />}
                    {isPending && <td colSpan={2} />}
                    {isActive && <td colSpan={anyReturned ? 4 : 1} />}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {tab === 'active' && (
            <div className="flex items-center justify-end gap-2 border-t border-ink-100 bg-white px-4 py-3">
              <button
                onClick={onConfirmPickup}
                disabled={locked}
                className="flex items-center gap-1.5 rounded-md bg-orange-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {locked ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {anyReturned ? 'Fix & Resubmit for Approval' : 'Submit for Approval'}
              </button>
            </div>
          )}

          {tab === 'pending_approval' && (
            <div className="flex items-center justify-between gap-2 border-t border-ink-100 bg-white px-4 py-3">
              <p className="flex items-center gap-1.5 text-xs text-ink-400">
                <ShieldCheck className="h-3.5 w-3.5" />
                Waiting on an approver to verify these checks.
              </p>
              <button
                onClick={onRecall}
                disabled={locked}
                className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="Pull this submission back to make corrections"
              >
                {locked ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Recall for edits
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function buildInitialCheckEntries(checks) {
  const initial = {}
  checks.forEach((c) => {
    initial[c.checkId] = { include: true, receiptType: '', receiptNo: '', remarks: '' }
  })
  return initial
}

function ActionModal({ action, checks, total, onCancel, onConfirm, loading, error, successFlash }) {
  const isSubmit = action.type === 'submit'
  const isRecall = action.type === 'recall'
  const isBulkRecall = action.type === 'bulk-recall'
  const reservation = action.reservation
  const checkCount = checks.length
  const dialogRef = useRef(null)
  const cancelButtonRef = useRef(null)
  const reasonFieldRef = useRef(null)
  const collectorIdTypeRef = useRef(null)
  const firstReceiptFieldRef = useRef(null)

  const [orEntries, setOrEntries] = useState(() => buildInitialCheckEntries(checks))
  const [reason, setReason] = useState('')
  const [collectorId, setCollectorId] = useState({ idType: '', idTypeOther: '', idNumber: '' })

  const updateInclude = useCallback((checkId, value) => {
    setOrEntries((prev) => ({
      ...prev,
      [checkId]: {
        ...prev[checkId],
        include: value,
        receiptType: value ? prev[checkId]?.receiptType || '' : '',
        receiptNo: value ? prev[checkId]?.receiptNo || '' : '',
        remarks: '',
      },
    }))
  }, [])

  const updateReceiptType = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], receiptType: value, receiptNo: '' } }))
  }, [])

  const updateReceiptNo = useCallback((checkId, value) => {
    const digitsOnly = value.replace(/\D/g, '')
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], receiptNo: digitsOnly.slice(0, RECEIPT_NUMBER_MAX_LENGTH) } }))
  }, [])

  const updateRemarks = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], remarks: value } }))
  }, [])

  const updateIdType = useCallback((value) => {
    setCollectorId((prev) => ({ ...prev, idType: value, idTypeOther: value === 'other' ? prev.idTypeOther : '' }))
  }, [])

  const updateIdTypeOther = useCallback((value) => {
    setCollectorId((prev) => ({ ...prev, idTypeOther: value.slice(0, COLLECTOR_ID_OTHER_LABEL_MAX_LENGTH) }))
  }, [])

  const updateIdNumber = useCallback((value) => {
    setCollectorId((prev) => ({ ...prev, idNumber: value.slice(0, COLLECTOR_ID_NUMBER_MAX_LENGTH) }))
  }, [])

  const { completedCount, duplicateOrNos, includeCount } = useMemo(() => {
    const seenCounts = {}
    let completed = 0
    let included = 0
    checks.forEach((c) => {
      const entry = orEntries[c.checkId]
      if (!entry) return
      if (entry.include) {
        included += 1
        const orNo = composeReceiptNo(entry)
        if (orNo) {
          completed += 1
          const key = orNo.toLowerCase()
          seenCounts[key] = (seenCounts[key] || 0) + 1
        }
      } else if (entry.remarks?.trim()) {
        completed += 1
      }
    })
    const duplicates = new Set(Object.entries(seenCounts).filter(([, count]) => count > 1).map(([key]) => key))
    return { completedCount: completed, duplicateOrNos: duplicates, includeCount: included }
  }, [orEntries, checks])

  const hasDuplicates = duplicateOrNos.size > 0
  const collectorIdComplete = !isSubmit || isCollectorIdComplete(collectorId)
  const allComplete = !isSubmit || (checkCount > 0 && completedCount === checkCount && !hasDuplicates && collectorIdComplete)
  const hasReason = reason.trim().length > 0
  const releaseCount = checkCount - includeCount
  const submitTotalAmount = useMemo(
    () => checks.reduce((sum, c) => (orEntries[c.checkId]?.include ? sum + (Number(c.amount) || 0) : sum), 0),
    [checks, orEntries],
  )

  useEffect(() => {
    const previouslyFocused = document.activeElement
    if (isSubmit && collectorIdTypeRef.current) collectorIdTypeRef.current.focus()
    else if ((isRecall || isBulkRecall) && reasonFieldRef.current) reasonFieldRef.current.focus()
    else cancelButtonRef.current?.focus()

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = prevOverflow
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && !loading) {
        onCancel()
        return
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
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
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [loading, onCancel])

  function handleConfirmClick() {
    if (loading) return
    if (isSubmit && !allComplete) return
    if ((isRecall || isBulkRecall) && !hasReason) return
    onConfirm(isSubmit ? { checkOutcomes: orEntries, collectorId } : isRecall || isBulkRecall ? { reason: reason.trim() } : undefined)
  }

  const title = isSubmit ? 'Submit pickup for approval' : isBulkRecall ? 'Recall selected submissions' : 'Recall submission'

  const subtitle = isSubmit
    ? checkCount === 1
      ? '1 check will be sent to an approver for verification before it can be marked picked up.'
      : `${checkCount} checks will be reviewed here, then sent to an approver for verification.`
    : isBulkRecall
    ? `Pulls ${action.reservations?.length ?? 0} submissions back to Active so corrections can be made.`
    : "Pulls this submission back to your Active list so you can fix a mistake before resubmitting."

  const confirmLabel = isSubmit
    ? includeCount === 0
      ? 'Release All'
      : includeCount === checkCount
      ? 'Submit for Approval'
      : 'Submit Partial for Approval'
    : isBulkRecall
    ? `Recall ${action.reservations.length}`
    : 'Recall for Edits'

  const HeaderIcon = isSubmit ? Send : RotateCcw

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/50 p-4 sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget && !loading && !successFlash) onCancel() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="pickup-action-title" className={cn('relative flex w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl', isSubmit ? 'max-h-[65vh] max-w-6xl' : 'max-h-[75vh] max-w-3xl')}>
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-100 px-7 py-5">
          <div className="flex items-start gap-3">
            <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', isSubmit ? 'bg-orange-500/10 text-orange-600' : 'bg-amber-500/10 text-amber-600')}>
              <HeaderIcon className="h-5 w-5" />
            </div>
            <div>
              <h2 id="pickup-action-title" className="text-lg font-semibold text-ink-900">{title}</h2>
              <p className="mt-0.5 text-sm text-ink-400">{subtitle}</p>
            </div>
          </div>
          <button onClick={onCancel} disabled={loading} className="shrink-0 rounded-full p-1.5 text-ink-300 hover:bg-ink-50 hover:text-ink-600 disabled:opacity-40" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className={cn('flex-1 overflow-y-auto px-7 py-6', (isSubmit || isRecall || isBulkRecall) && 'bg-ink-50/40')}>
          {isBulkRecall && (
            <div className="max-h-56 overflow-y-auto rounded-xl border border-ink-100">
              <ul className="divide-y divide-ink-50 text-sm">
                {action.reservations.map((r) => (
                  <li key={r.id} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-ink-800">{r.collector_name || 'Unknown collector'}</span>
                    <span className="text-xs text-ink-400">{(r.checks || []).length} check{(r.checks || []).length === 1 ? '' : 's'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {isRecall && (
            <p className="text-sm text-ink-600">
              This pulls <span className="font-medium text-ink-900">{reservation.collector_name}</span>'s submission of {checkCount} check{checkCount === 1 ? '' : 's'} back out of the approval queue so you can fix a mistake before resubmitting. It goes back to your Active list; nothing is released to the pool.
            </p>
          )}

          {isSubmit && checkCount > 0 && (
            <div className="mt-4 rounded-xl border border-ink-100 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <CreditCard className="h-3.5 w-3.5" />
                Collector ID verification <span className="normal-case text-orange-500">(required)</span>
              </div>
              <p className="mb-3 flex items-center gap-1.5 text-sm text-ink-700">
                <UserRound className="h-3.5 w-3.5 text-ink-400" />
                Verifying ID for <span className="font-semibold text-ink-900">{reservation.collector_name || 'Unknown collector'}</span>
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-400">ID type</label>
                  <select ref={collectorIdTypeRef} value={collectorId.idType} onChange={(e) => updateIdType(e.target.value)} aria-label="Collector ID type" className="w-full rounded-md border border-ink-200 px-2.5 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40">
                    <option value="">Select ID type</option>
                    {COLLECTOR_ID_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>

                {collectorId.idType === 'other' && (
                  <div>
                    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-400">Specify ID type</label>
                    <input type="text" value={collectorId.idTypeOther} onChange={(e) => updateIdTypeOther(e.target.value)} placeholder="e.g. Company ID" maxLength={COLLECTOR_ID_OTHER_LABEL_MAX_LENGTH} aria-label="Specify collector ID type" className="w-full rounded-md border border-ink-200 px-2.5 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40" />
                  </div>
                )}

                <div>
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-400">ID number</label>
                  <input type="text" value={collectorId.idNumber} onChange={(e) => updateIdNumber(e.target.value)} onBlur={(e) => updateIdNumber(e.target.value.trim())} placeholder="ID number" maxLength={COLLECTOR_ID_NUMBER_MAX_LENGTH} aria-label="Collector ID number" className="w-full rounded-md border border-ink-200 px-2.5 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40" />
                </div>
              </div>
              {!collectorIdComplete && (
                <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-amber-700">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  Record the collector's ID type and number before submitting.
                </p>
              )}
            </div>
          )}

          {isRecall && checkCount > 0 && (
            <div className="mt-4 rounded-xl border border-ink-100 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2.5">
                  <UserRound className="h-4 w-4 text-ink-400" />
                  <div>
                    <p className="text-sm font-semibold text-ink-900">{reservation.collector_name || 'Unknown collector'}</p>
                    <p className="text-xs text-ink-400">Every check in this submission will move back to Active.</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <SummaryPill label="checks" value={checkCount} tone="neutral" />
                  <SummaryPill label="total value" value={formatCurrency(total)} tone="neutral" mono />
                </div>
              </div>
            </div>
          )}

          {isSubmit && checkCount > 0 && (
            <div className="mt-5">
              <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <ClipboardList className="h-3.5 w-3.5" />
                Per-check outcome
              </div>

              <div className="flex flex-col gap-3">
                {checks.map((c, idx) => {
                  const entry = orEntries[c.checkId] || { include: true, receiptType: '', receiptNo: '', remarks: '' }
                  const composedReceipt = composeReceiptNo(entry)
                  const isDuplicate = entry.include && composedReceipt && duplicateOrNos.has(composedReceipt.toLowerCase())
                  const needsReason = !entry.include
                  const missingReason = needsReason && !entry.remarks?.trim()
                  const rowIncomplete = entry.include ? !composedReceipt : missingReason
                  const wasReturned = c.checkStatus === 'returned'
                  const rowComplete = !rowIncomplete && !isDuplicate

                  return (
                    <div
                      key={c.checkId ?? idx}
                      className={cn(
                        'rounded-xl border bg-white shadow-sm transition-colors',
                        !entry.include && 'border-ink-100',
                        entry.include && isDuplicate && 'border-red-300 ring-1 ring-red-100',
                        entry.include && !isDuplicate && rowIncomplete && 'border-amber-200',
                        entry.include && rowComplete && 'border-teal-300/70',
                      )}
                    >
                      {wasReturned && (
                        <div className="flex flex-wrap items-start gap-1.5 rounded-t-xl border-b border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
                          <RotateCcw className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>
                            <span className="font-semibold">Returned:</span> {c.returnReason || 'No reason given'}
                            <span className="text-amber-600"> — {formatDateTime(c.returnedAt)}{c.returnedByName ? ` · ${c.returnedByName}` : ''}</span>
                          </span>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => updateInclude(c.checkId, !entry.include)}
                            aria-pressed={entry.include}
                            aria-label={entry.include ? `Mark check ${c.check_no || idx + 1} as not picked up` : `Mark check ${c.check_no || idx + 1} as picked up`}
                            className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition', entry.include ? 'text-teal-600 hover:bg-teal-50' : 'text-ink-300 hover:bg-ink-50 hover:text-ink-500')}
                          >
                            {entry.include ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                            {entry.include ? 'Picking up' : 'Not today'}
                          </button>
                          <div className="h-6 w-px bg-ink-100" />
                          <BankBadge bank={c.bank} />
                          <BranchBadge branch={c.pickupBranch} />
                          <div>
                            <p className="text-sm font-semibold text-ink-900">{c.payee || '—'}</p>
                            <p className="font-mono text-[11px] text-ink-400">Check {c.check_no || '—'}{c.payor ? ` · from ${c.payor}` : ''}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-semibold text-ink-800">{formatCurrency(c.amount)}</span>
                          {entry.include && (
                            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', isDuplicate ? 'bg-red-100 text-red-700' : rowComplete ? 'bg-teal-100 text-teal-700' : 'bg-amber-100 text-amber-700')}>
                              {isDuplicate ? <><AlertTriangle className="h-3 w-3" /> Duplicate receipt</> : rowComplete ? <><Check className="h-3 w-3" /> Complete</> : <><AlertTriangle className="h-3 w-3" /> Incomplete</>}
                            </span>
                          )}
                        </div>
                      </div>

                      {entry.include ? (
                        <div className="px-4 py-4">
                          <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                            <ReceiptText className="h-3 w-3" />
                            Receipt
                          </label>
                          <div className="flex max-w-sm gap-1.5">
                            <select ref={idx === 0 ? firstReceiptFieldRef : undefined} value={entry.receiptType} onChange={(e) => updateReceiptType(c.checkId, e.target.value)} aria-label={`Receipt type for check ${c.check_no || idx + 1}`} className="w-24 rounded-md border border-ink-200 px-2 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40">
                              <option value="">Type</option>
                              {RECEIPT_TYPES.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
                            </select>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={entry.receiptNo}
                              onChange={(e) => updateReceiptNo(c.checkId, e.target.value)}
                              placeholder="Number"
                              maxLength={RECEIPT_NUMBER_MAX_LENGTH}
                              disabled={!entry.receiptType}
                              aria-label={`Receipt number for check ${c.check_no || idx + 1}`}
                              className={cn('min-w-0 flex-1 rounded-md border px-2 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40 disabled:bg-ink-50 disabled:text-ink-300', isDuplicate ? 'border-red-400' : 'border-ink-200')}
                            />
                          </div>
                          {isDuplicate && <p className="mt-1 text-[10px] font-medium text-red-600">Already used above</p>}
                        </div>
                      ) : (
                        <div className="px-4 py-4">
                          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                            Reason <span className="text-orange-500">(required)</span>
                          </label>
                          <input
                            type="text"
                            value={entry.remarks}
                            onChange={(e) => updateRemarks(c.checkId, e.target.value)}
                            placeholder="Why isn&rsquo;t this being picked up today?"
                            maxLength={200}
                            aria-label={`Reason for check ${c.check_no || idx + 1}`}
                            className={cn('w-full max-w-md rounded-md border px-2.5 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40', missingReason ? 'border-orange-400' : 'border-ink-200')}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {!allComplete && (
                <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-700">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {hasDuplicates ? 'Each check being picked up needs its own unique receipt type + number.' : 'Every check needs an outcome: a receipt type & number if picking up, or a reason if not.'}
                </p>
              )}
            </div>
          )}

          {isRecall && checkCount > 0 && (
            <div className="mt-4">
              <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <ClipboardList className="h-3.5 w-3.5" />
                Checks in this submission
              </div>
              <div className="flex flex-col gap-2">
                {checks.map((c, idx) => (
                  <div key={c.checkId ?? idx} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-100 bg-white px-4 py-3 shadow-sm">
                    <div className="flex items-center gap-3">
                      <BankBadge bank={c.bank} />
                      <BranchBadge branch={c.pickupBranch} />
                      <div>
                        <p className="text-sm font-semibold text-ink-900">{c.payee || '—'}</p>
                        <p className="font-mono text-[11px] text-ink-400">Check {c.check_no || '—'}{c.payor ? ` · from ${c.payor}` : ''}</p>
                      </div>
                    </div>
                    <span className="font-mono text-sm font-semibold text-ink-800">{formatCurrency(c.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(isRecall || isBulkRecall) && (
            <div className="mt-4">
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                Reason for recall <span className="text-orange-500">(required)</span>
              </label>
              <textarea
                ref={reasonFieldRef}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What needs to be corrected before resubmitting?"
                maxLength={300}
                rows={3}
                aria-label="Reason for recall"
                className={cn('w-full rounded-md border bg-white px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40', !hasReason ? 'border-amber-300' : 'border-ink-200')}
              />
              {!hasReason && (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  A reason is required before this can be recalled.
                </p>
              )}
            </div>
          )}

          {(isRecall || isBulkRecall) && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-700">
              <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {isBulkRecall ? 'These will need to be resubmitted for approval after you make your corrections.' : "This will need to be resubmitted for approval after you make your corrections."}
            </div>
          )}

          {error && (
            <p className="mt-4 flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-ink-100 bg-white px-7 py-4">
          <p className="hidden text-xs text-ink-400 sm:block">
            {isSubmit ? `${completedCount} of ${checkCount} checks ready · ${formatCurrency(submitTotalAmount)} submitting` : null}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button ref={cancelButtonRef} onClick={onCancel} disabled={loading} className="rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40">
              Cancel
            </button>
            <button
              onClick={handleConfirmClick}
              disabled={loading || (isSubmit && !allComplete) || ((isRecall || isBulkRecall) && !hasReason)}
              title={isSubmit && !allComplete ? 'Every check needs a complete outcome before submitting' : (isRecall || isBulkRecall) && !hasReason ? 'Enter a reason before recalling' : undefined}
              className={cn('flex items-center gap-2 rounded-md px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60', isSubmit ? 'bg-orange-500 hover:bg-orange-600' : 'bg-ink-900 hover:bg-ink-800')}
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirmLabel}
            </button>
          </div>
        </div>

        {successFlash && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 backdrop-blur-sm">
            <style>{`
              @keyframes pickupSuccessPop {
                0% { transform: scale(0.6); opacity: 0; }
                60% { transform: scale(1.08); opacity: 1; }
                100% { transform: scale(1); }
              }
              .pickup-success-icon { animation: pickupSuccessPop 0.35s ease-out; }
            `}</style>
            <div className="pickup-success-icon flex h-14 w-14 items-center justify-center rounded-full bg-teal-100">
              <Check className="h-7 w-7 text-teal-600" strokeWidth={3} />
            </div>
            <p className="text-sm font-semibold text-ink-800">{successFlash.message}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function SummaryPill({ label, value, tone = 'neutral', mono = false }) {
  const tones = {
    neutral: 'bg-ink-50 text-ink-700',
    positive: 'bg-teal-100 text-teal-700',
    warning: 'bg-amber-100 text-amber-700',
  }
  return (
    <div className={cn('rounded-lg px-3 py-2 text-right', tones[tone] || tones.neutral)}>
      <p className={cn('text-sm font-semibold leading-tight', mono && 'font-mono')}>{value}</p>
      <p className="text-[9px] uppercase tracking-wide opacity-70">{label}</p>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg border border-ink-100 bg-ink-50/60" />
      ))}
    </div>
  )
}

function EmptyState({ tab, hasFilter }) {
  const copy = {
    active: { title: 'No active reservations', body: 'Orders reserved by collectors will show up here until submitted or expired.' },
    pending_approval: { title: 'Nothing awaiting approval', body: 'Pickups you submit will show up here until an approver decides on them.' },
    history: { title: 'No history yet', body: 'Completed, expired, released, and rejected orders will appear here.' },
  }[tab]

  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-ink-200 px-4 py-16 text-center">
      <Clock className="h-8 w-8 text-ink-200" />
      <p className="mt-3 text-lg font-semibold text-ink-700">{hasFilter ? 'No matching reservations' : copy.title}</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">{hasFilter ? 'Try a different search, or clear the filters.' : copy.body}</p>
    </div>
  )
}