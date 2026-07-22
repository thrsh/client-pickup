// AdminPickups.jsx
//
// FLOW CHANGE: admins no longer confirm a pickup directly. Instead, an
// admin enters the per-check pickup data (OR no., whether AR was
// collected, remarks) and SUBMITS IT FOR APPROVAL. An approver
// (see ApproverHome.jsx) then physically verifies each check and makes
// one of three decisions:
//   - Approve   -> check is finally marked picked_up.
//   - Reject    -> check is released straight back into the general
//                  available pool for any collector to reserve.
//   - Return    -> check goes back to THIS reservation's Active tab as
//                  'returned' (a distinct status from 'reserved' -- see
//                  the check-status note below) so the admin can fix a
//                  mistake (e.g. a mistyped OR number) and resubmit — it
//                  is NOT released to the pool.
// Checks the admin marks as "not being picked up today" at submission
// time skip approval entirely and are released immediately, same as
// before — there's nothing for an approver to verify on a check nobody
// is claiming.
//
// RECEIPT TYPE NOTE (added — read before touching the submit modal):
//   The submit-for-approval modal used to have a single free-text "OR
//   no." field, implicitly assuming every pickup produces an Official
//   Receipt. In practice collectors can come back with a PR
//   (Provisional Receipt), CR (Collection Receipt), or AR (Acknowledgment
//   Receipt) instead. The schema only has one text column for this
//   (checks.or_no — see the CREATE TABLE), so rather than adding a
//   migration for a new column, the admin now picks a receipt TYPE from
//   a dropdown (PR / CR / AR / OR) and only then sees a field for the
//   receipt NUMBER; the two are folded into that single column as
//   "TYPE-NUMBER" (e.g. "OR-12345") by composeReceiptNo() below. Every
//   other page that reads checks.or_no (ApproverHome.jsx,
//   ApproverHistory.jsx, this file's own Pending Approval / History tabs
//   and CSV export) already just displays whatever string is in that
//   column, so they need no changes — they'll simply show "OR-12345"
//   instead of "12345". AR collected and 2307 Attached are untouched by
//   this change; they were already separate yes/no answers, not part of
//   the receipt number.
//
// CHECK-STATUS NOTE (read before touching the Active tab):
//   A reservation can hold checks in several different states at once —
//   e.g. one check already approved (picked_up), one still awaiting
//   approval (pending_approval), and one just returned for correction
//   (returned). The reservation row itself only carries a single status
//   column, so the Active tab must NEVER assume "reservation.status ===
//   reserved" implies every embedded check is itself reserved. This file
//   always re-filters the embedded `checks` array down to the specific
//   check statuses that belong in this tab (currently 'reserved' and
//   'returned') both in load() and defensively again in lineItems().
//   Skipping either filter is what previously caused already-approved
//   checks to keep showing up in the Active tab as if the whole batch had
//   been sent back for correction.
//
// HISTORY-TAB DATA NOTE:
//   The History tab reads from check_activity_log rather than the live
//   `checks` table, because a released/rejected check goes back to
//   'available' and can be re-reserved by someone else — at which point
//   its live row no longer points back to this reservation, but the
//   activity log entry still does. That log is fetched in TWO separate
//   queries (activity rows, then the referenced checks by id) instead of
//   a single embedded `checks(...)` select. The previous single-query
//   embed depended on PostgREST correctly inferring the
//   check_activity_log -> checks relationship; when that inference
//   failed or errored, the embed silently came back null for every row,
//   `lineItems()` filtered every entry out (it drops any activity row
//   whose `checks` is falsy), and the whole order rendered as "No linked
//   checks found for this order" even though it had a full pickup
//   history including approvals and returns. Doing the two fetches by
//   hand and merging client-side removes that dependency entirely.
//
// Requires migration_approval_workflow.sql AND migration_return_tracking.sql
// to have been run first. Together they provide, at minimum:
//   - checks.status extended with 'pending_approval' and 'returned'
//   - checks.or_no / ar_collected / attached_2307 / remarks / submitted_by / submitted_by_name / submitted_at
//   - checks.return_reason / returned_at / returned_by / returned_by_name
//   - pickup_reservations.status extended with 'pending_approval'
//   - admin_submit_for_approval(p_reservation_id uuid, p_check_outcomes jsonb)
//     (clears return_reason/returned_at/returned_by[_name] on resubmit)
//   - admin_recall_submission(p_reservation_id uuid, p_check_ids uuid[])
//   - approver_decide(p_reservation_id uuid, p_decisions jsonb) where each
//     decision is { check_id, decision: 'approve' | 'reject' | 'return', remarks }
//     and a 'return' decision touches ONLY that check_id (status ->
//     'returned', return_reason/returned_at/returned_by[_name] stamped) —
//     every other check in the same submission keeps whatever decision
//     was made for it.
//   - check_activity_log.action extended with 'rejected' | 'returned'
//   - check_activity_log.check_id references checks.id
// Deploying this component without those migrations will break both this
// file and ApproverHome.jsx.
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
  Filter,
  CheckCircle2,
  ShieldCheck,
  XCircle,
  Hourglass,
  Wallet,
  Timer,
  Flame,
  Landmark,
  ClipboardList,
  ReceiptText,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Input } from '../../components/ui/input'
import { Card } from '../../components/ui/card'
import { formatCurrency, formatDate, cn } from '../../lib/utils'
// Same fixed bank list AdminChecks.jsx uses, pulled from one shared module
// so the two pages can never drift apart on what counts as a valid bank.
import { BANKS } from '../../lib/banks'

const POLL_INTERVAL_MS = 20000
const EXPIRING_SOON_MINUTES = 15
const CRITICAL_MINUTES = 5
// How long the success checkmark stays on screen before the modal closes.
const SUCCESS_FLASH_MS = 900
// Thresholds for flagging a submission that's been sitting in the approval
// queue too long. Keep these in sync with the matching constants in
// ApproverHome.jsx so the two pages agree on what "stale" means.
const PENDING_WARN_MINUTES = 60
const PENDING_CRITICAL_MINUTES = 240

// Receipt types an admin can pick between when recording what a collector
// produced at pickup — see the RECEIPT TYPE NOTE at the top of this file.
// checks.or_no is the only schema column available for this, so the type
// is captured alongside the number and folded into that single column by
// composeReceiptNo() below rather than requiring a new migration.
const RECEIPT_TYPES = ['PR', 'CR', 'AR', 'OR']

// Check-level statuses that belong in the Active tab. A check that has
// been approved (picked_up), is awaiting approval (pending_approval), or
// has been released (available) does NOT belong here even if it still
// happens to reference this reservation_id.
const ACTIVE_TAB_CHECK_STATUSES = new Set(['reserved', 'returned'])

const SORT_OPTIONS = [
  { value: 'expires_asc', label: 'Expiring soonest', tabs: ['active'] },
  { value: 'submitted_asc', label: 'Oldest submitted', tabs: ['pending_approval'] },
  { value: 'submitted_desc', label: 'Newest submitted', tabs: ['pending_approval'] },
  { value: 'reserved_desc', label: 'Newest reserved', tabs: ['active', 'history'] },
  { value: 'reserved_asc', label: 'Oldest reserved', tabs: ['active', 'history'] },
  { value: 'amount_desc', label: 'Highest amount', tabs: ['active', 'pending_approval', 'history'] },
  { value: 'amount_asc', label: 'Lowest amount', tabs: ['active', 'pending_approval', 'history'] },
  { value: 'collector_asc', label: 'Collector A→Z', tabs: ['active', 'pending_approval', 'history'] },
]

// ----------------------------------------------------------------------------
// Line-item normalization
//
// - 'active' reads checks live off the reservation. Because a single
//   reservation can hold checks in mixed states (one picked_up, one still
//   pending_approval, one returned for correction), the checks embedded
//   here are ALREADY filtered in load() down to ACTIVE_TAB_CHECK_STATUSES.
//   This function filters again defensively — belt and suspenders — so a
//   future change to load() can't silently regress the bug this fixes.
// - 'pending_approval' also reads checks live off the reservation, but the
//   embedded checks additionally carry the OR no. / AR collected / remarks
//   / submitted_at data the admin entered at submission time.
// - 'history' reads from check_activity_log instead, because a
//   released/rejected check goes back to 'available' and can be re-reserved
//   by someone else — at which point its live row no longer points back to
//   this reservation. The activity log is what still does. See the
//   HISTORY-TAB DATA NOTE at the top of this file for how that data is
//   fetched and merged in load().
// ----------------------------------------------------------------------------
function lineItems(reservation, tab) {
  if (tab === 'history') {
    const activity = Array.isArray(reservation.activity) ? reservation.activity : []

    // Multiple activity rows can exist for the same check — submitted,
    // returned, resubmitted, approved, etc. Collapse them to ONE entry per
    // check_id so History reflects the actual number of checks, not the
    // number of things that happened to them. The FINAL action (latest
    // performed_at) is the outcome shown, and its own remarks (e.g. a
    // return reason) stay attached only to that action. OR no. / AR
    // collected / 2307 Attached are filled from whichever row for this
    // check most recently set them, since a return/approve decision only
    // logs its own reason and doesn't re-log the original submission
    // details that were captured on the earlier submitted_for_approval row.
    const byCheck = new Map()
    activity
      .slice()
      .sort((a, b) => new Date(a.performed_at || 0) - new Date(b.performed_at || 0))
      .forEach((a) => {
        if (!a.check_id) return
        const entry = byCheck.get(a.check_id) || { or_no: null, ar_collected: null, attached_2307: null }
        entry.latest = a
        if (a.checks) entry.checks = a.checks
        if (a.or_no !== null && a.or_no !== undefined) entry.or_no = a.or_no
        if (a.ar_collected !== null && a.ar_collected !== undefined) entry.ar_collected = a.ar_collected
        if (a.attached_2307 !== null && a.attached_2307 !== undefined) entry.attached_2307 = a.attached_2307
        byCheck.set(a.check_id, entry)
      })

    return [...byCheck.values()]
      .map(({ latest, checks: c, or_no, ar_collected, attached_2307 }) => {
        if (!c) return null
        return {
          id: latest.id,
          checkId: c.id,
          row_number: c.row_number,
          bank: c.bank,
          payee: c.payee,
          payor: c.payor,
          check_no: c.check_no,
          check_date: c.check_date,
          amount: c.amount,
          outcome: latest.action, // 'picked_up' | 'released' | 'rejected' | 'returned' | 'expired'
          or_no,
          ar_collected,
          attached_2307,
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
    payee: c.payee,
    payor: c.payor,
    check_no: c.check_no,
    check_date: c.check_date,
    amount: c.amount,
    outcome: null,
    or_no: tab === 'pending_approval' ? c.or_no ?? null : null,
    ar_collected: tab === 'pending_approval' ? c.ar_collected ?? null : null,
    attached_2307: tab === 'pending_approval' ? c.attached_2307 ?? null : null,
    remarks: tab === 'pending_approval' ? c.remarks ?? null : null,
    submittedAt: tab === 'pending_approval' ? c.submitted_at ?? null : null,
    submittedByName: tab === 'pending_approval' ? c.submitted_by_name ?? null : null,
    // Only meaningful on the Active tab: whether this specific check is
    // sitting there because it was just reserved, or because an approver
    // sent it back for correction (and if so, why/when/by whom).
    checkStatus: tab === 'active' ? (isReturnedCheck(c) ? 'returned' : 'reserved') : null,
    returnReason: tab === 'active' ? c.return_reason ?? null : null,
    returnedAt: tab === 'active' ? c.returned_at ?? null : null,
    returnedByName: tab === 'active' ? c.returned_by_name ?? null : null,
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

function matchesCheckSearch(items, term) {
  if (!term) return true
  const needle = term.toLowerCase()
  return items.some((c) =>
    [c.payee, c.payor, c.check_no, c.or_no, c.bank]
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

// Earliest submitted_at across a pending-approval order's checks — that's
// the moment the clock starts ticking on "how long has this been waiting."
function earliestSubmittedAt(items) {
  const times = items.map((c) => c.submittedAt).filter(Boolean).map((t) => new Date(t).getTime())
  if (times.length === 0) return null
  return Math.min(...times)
}

// Determines whether a check counts as "returned" for display purposes.
// Deliberately does NOT rely solely on a strict `status === 'returned'`
// string match:
//   - normalizes case/whitespace, since a DB value like 'Returned' or
//     ' returned ' would otherwise silently fail a strict comparison and
//     fall back to looking like a plain reserved check
//   - ALSO treats the check as returned if any of return_reason /
//     returned_at / returned_by_name is present, even if `status` itself
//     doesn't say so — that combination of fields only ever gets written
//     by an approver's return decision, so if they're populated the
//     check plainly was returned regardless of what the status column
//     currently holds. This is what prevents "still shows Reserved" when
//     the badge alone was trusting a single column that may be stale,
//     miscased, or was written by an older version of the RPC.
function isReturnedCheck(c) {
  const normalizedStatus = String(c?.status ?? '').trim().toLowerCase()
  return (
    normalizedStatus === 'returned' ||
    !!c?.return_reason ||
    !!c?.returned_at ||
    !!c?.returned_by_name
  )
}

// Formats a full date + time (not just a date) — used for "returned at"
// so admins can see exactly when an approver sent a check back, not just
// which day.
function formatDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Combines the selected receipt type (PR/CR/AR/OR) and its number into the
// single string actually persisted to checks.or_no — see the RECEIPT TYPE
// NOTE at the top of this file for why there's no separate column for the
// type. Returns '' whenever either half is missing, so every caller
// (validation, duplicate detection, the RPC payload) can treat "not fully
// entered yet" as one simple falsy check instead of two.
function composeReceiptNo(entry) {
  const type = entry?.receiptType || ''
  const no = entry?.receiptNo?.trim() || ''
  if (!type || !no) return ''
  return `${type}-${no}`
}

export default function AdminPickups() {
  const [tab, setTab] = useState('active') // 'active' | 'pending_approval' | 'history'
  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [collectorFilter, setCollectorFilter] = useState('')
  const [bankFilter, setBankFilter] = useState('')
  const [checkSearch, setCheckSearch] = useState('')
  const [quickFilter, setQuickFilter] = useState('all') // 'all' | 'expiring' | 'stale' | 'returned' | history outcome keys
  const [sortBy, setSortBy] = useState('expires_asc')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [lastUpdated, setLastUpdated] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  // confirmAction.type: 'submit' | 'release' | 'bulk-release' | 'recall' | 'bulk-recall'
  const [confirmAction, setConfirmAction] = useState(null)
  const [actioning, setActioning] = useState(false)
  const [actionError, setActionError] = useState('')
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [toast, setToast] = useState(null)
  // Brief "success" state shown inside the modal right after an action
  // completes, before the modal itself closes. Null when not showing.
  const [successFlash, setSuccessFlash] = useState(null)

  const debounceRef = useRef(null)
  const toastTimerRef = useRef(null)
  const searchInputRef = useRef(null)
  const isMountedRef = useRef(true)
  const successTimerRef = useRef(null)
  // Guards against overlapping fetches (e.g. a poll firing while a manual
  // refresh is still in flight) and against a stale response landing after
  // a newer request has already resolved.
  const requestIdRef = useRef(0)
  const inFlightRef = useRef(false)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      clearTimeout(successTimerRef.current)
    }
  }, [])

  useEffect(() => {
    load(true)
    setSelectedIds(new Set())
    setQuickFilter('all')
    setSortBy(
      tab === 'active' ? 'expires_asc' : tab === 'pending_approval' ? 'submitted_asc' : 'reserved_desc'
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Debounced re-fetch when the collector or bank filter changes
  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load(false), 250)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectorFilter, bankFilter])

  // Keep countdowns/wait-timers live and periodically pull fresh data
  // (also catches reservations that expired naturally, or got decided by
  // an approver, without anyone touching this page).
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

  // "/" focuses the search box, Escape clears it — quick keyboard access
  // for admins triaging a long list.
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

        const statusFilter =
          tab === 'active'
            ? ['reserved']
            : tab === 'pending_approval'
            ? ['pending_approval']
            : ['picked_up', 'partial', 'expired', 'cancelled']

        // Active and Pending Approval both embed checks directly (nothing's
        // been logged to history yet). The Active tab additionally selects
        // each check's own `status` plus the return_* columns, because a
        // reservation can hold checks in mixed states (see the file header
        // CHECK-STATUS NOTE) — without `status` here there would be no way
        // to tell a plain reserved check apart from one an approver just
        // returned for correction, or to keep an already-approved check
        // from wrongly reappearing here. Both tabs also select `bank` so
        // the check's issuing bank can be shown/filtered here without a
        // second round trip. Pending Approval additionally pulls the OR
        // no. / AR collected / remarks / submitted_at the admin entered
        // when submitting. History fetches the audit log separately below
        // — see the HISTORY-TAB DATA NOTE at the top of this file for why.
        //
        // When a bank filter is active, the embedded `checks` resource is
        // aliased with `!inner` instead of a plain left embed. PostgREST
        // treats a bare `checks(...)` embed as a LEFT join — filtering it
        // with `.eq('checks.bank', ...)` only trims which child rows come
        // back, it does NOT exclude parent reservations that simply have
        // no checks from that bank (they'd still show up with an empty
        // checks array). `checks!inner(...)` makes it an INNER join, so
        // `.eq('checks.bank', ...)` below actually restricts which
        // reservations are returned at all, not just which of their
        // checks are embedded.
        const checksJoin = bankFilter && tab !== 'history' ? 'checks!inner' : 'checks'
        const selectClause =
          tab === 'active'
            ? `id, collector_name, status, reserved_at, expires_at, picked_up_at, ${checksJoin}(id, row_number, bank, payee, payor, check_no, check_date, amount, status, return_reason, returned_at, returned_by_name)`
            : tab === 'pending_approval'
            ? `id, collector_name, status, reserved_at, expires_at, ${checksJoin}(id, row_number, bank, payee, payor, check_no, check_date, amount, or_no, ar_collected, attached_2307, remarks, submitted_at, submitted_by_name)`
            : 'id, collector_name, status, reserved_at, expires_at, picked_up_at'

        let req = supabase
          .from('pickup_reservations')
          .select(selectClause)
          .in('status', statusFilter)
          .order('reserved_at', { ascending: false })
          .limit(150)

        const trimmedFilter = collectorFilter.trim()
        if (trimmedFilter) {
          req = req.ilike('collector_name', `%${trimmedFilter}%`)
        }

        // With `checksJoin` set to `checks!inner` above whenever a bank
        // filter is active, this `.eq()` does two things at once: it
        // restricts which pickup_reservations rows come back at all (only
        // ones with ≥1 matching check survive the inner join), AND it
        // trims the embedded `checks` array down to just the matching
        // checks — so the table only ever renders checks from the
        // selected bank. History doesn't embed checks in this query at
        // all (its checks come from a separate lookup below), so its bank
        // filter is applied client-side after that data is merged.
        if (bankFilter && tab !== 'history') {
          req = req.eq('checks.bank', bankFilter)
        }

        const { data, error } = await req

        // If a newer request has since started, or we've unmounted, drop
        // this result on the floor.
        if (!isMountedRef.current || requestId !== requestIdRef.current) return

        if (error) {
          setLoadError(error.message || 'Failed to load reservations. Please try again.')
          return
        }

        let rows = Array.isArray(data) ? data : []

        // A reservation can stay at status='reserved' while some of its
        // checks have already been approved (picked_up) or are mid-flight
        // (pending_approval) elsewhere — e.g. a partial approval where one
        // check was approved and another was returned for correction. Only
        // the checks that are actually still 'reserved' or 'returned'
        // belong in this tab; anything else tied to the same reservation_id
        // must NOT be shown here, or an approved check ends up looking like
        // it, too, got sent back for correction.
        if (tab === 'active') {
          rows = rows.map((r) => ({
            ...r,
            checks: (Array.isArray(r.checks) ? r.checks : []).filter((c) => {
              const normalizedStatus = String(c?.status ?? 'reserved').trim().toLowerCase()
              return ACTIVE_TAB_CHECK_STATUSES.has(normalizedStatus) || isReturnedCheck(c)
            }),
          }))
        }

        // Belt-and-suspenders, matching the same pattern used for
        // ACTIVE_TAB_CHECK_STATUSES above: the `checks!inner` + `.eq()`
        // combo already does the real filtering server-side, but
        // re-filtering client-side means a future change to the select
        // clause (e.g. someone drops the `!inner`) can't silently regress
        // into showing checks from the wrong bank.
        if (bankFilter && tab !== 'history') {
          rows = rows.map((r) => ({
            ...r,
            checks: (Array.isArray(r.checks) ? r.checks : []).filter((c) => c.bank === bankFilter),
          }))
        }

        if (tab === 'history' && rows.length > 0) {
          const ids = rows.map((r) => r.id)

          // Two separate queries instead of a single embedded
          // `checks(...)` select — see the HISTORY-TAB DATA NOTE at the
          // top of this file for why the embed was unreliable.
          const { data: activity, error: activityError } = await supabase
            .from('check_activity_log')
            .select(
              'id, reservation_id, check_id, action, or_no, ar_collected, attached_2307, remarks, performed_at'
            )
            .in('reservation_id', ids)
            .order('performed_at', { ascending: true })

          if (!isMountedRef.current || requestId !== requestIdRef.current) return

          if (activityError) {
            // Non-fatal: reservations still render, just without their
            // check breakdown until the next successful refresh.
            console.error('check_activity_log fetch failed:', activityError)
          } else {
            const activityRows = activity || []
            const checkIds = [...new Set(activityRows.map((a) => a.check_id).filter(Boolean))]

            let checksById = new Map()
            if (checkIds.length > 0) {
              const { data: checksData, error: checksError } = await supabase
                .from('checks')
                .select('id, row_number, bank, payee, payor, check_no, check_date, amount')
                .in('id', checkIds)

              if (!isMountedRef.current || requestId !== requestIdRef.current) return

              if (checksError) {
                // Still non-fatal — activity rows will just render without
                // check details (payee/amount/etc.) until the check lookup
                // succeeds on a later refresh.
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
            rows = rows.map((r) => ({ ...r, activity: byReservation.get(r.id) || [] }))

            // History's bank filter is applied here, client-side, since the
            // checks for this tab come from the separate lookup above
            // rather than an embed the query itself can filter on. A
            // reservation is kept only if at least one of its logged
            // checks matches the selected bank; lineItems()/matchesCheckSearch
            // will still only ever *display* checks matching whatever the
            // bank column says, so this just controls which orders appear
            // at all.
            if (bankFilter) {
              rows = rows.filter((r) =>
                (r.activity || []).some((a) => a.checks && a.checks.bank === bankFilter)
              )
            }
          }
        }

        setReservations(rows)
        setLastUpdated(Date.now())
        // Drop selections that no longer exist in the fresh data (e.g.
        // something else picked them up, or an approver decided them,
        // between polls).
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
    [tab, collectorFilter, bankFilter]
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

  function minutesWaiting(submittedAtMs) {
    if (!submittedAtMs) return 0
    return Math.max(0, Math.round((now - submittedAtMs) / 60000))
  }

  function formatWaiting(submittedAtMs) {
    if (!submittedAtMs) return '—'
    const mins = minutesWaiting(submittedAtMs)
    if (mins < 60) return `Waiting ${mins}m`
    const hrs = Math.floor(mins / 60)
    const rem = mins % 60
    return `Waiting ${hrs}h ${rem}m`
  }

  function pendingUrgency(submittedAtMs) {
    const mins = minutesWaiting(submittedAtMs)
    if (mins >= PENDING_CRITICAL_MINUTES) return 'critical'
    if (mins >= PENDING_WARN_MINUTES) return 'warning'
    return 'normal'
  }

  // Combines the (already server-filtered-by-collector/bank) list with the
  // client-side check search, the quick filter (expiring / stale / returned
  // / history outcome depending on tab), and sort.
  const visibleReservations = useMemo(() => {
    const term = checkSearch.trim()
    let list = reservations.filter((r) => matchesCheckSearch(sortedLineItems(r, tab), term))

    if (tab === 'active' && quickFilter === 'expiring') {
      list = list.filter((r) => minutesLeft(r.expires_at) <= EXPIRING_SOON_MINUTES)
    }
    if (tab === 'active' && quickFilter === 'returned') {
      list = list.filter((r) => sortedLineItems(r, 'active').some((c) => c.checkStatus === 'returned'))
    }
    if (tab === 'pending_approval' && quickFilter === 'stale') {
      list = list.filter((r) => {
        const submittedAtMs = earliestSubmittedAt(sortedLineItems(r, 'pending_approval'))
        return submittedAtMs && minutesWaiting(submittedAtMs) >= PENDING_WARN_MINUTES
      })
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
  }, [reservations, checkSearch, quickFilter, sortBy, tab, now])

 const activeSummary = useMemo(() => {
    if (tab !== 'active') return null
    const minutesLeftAll = reservations.map((r) => minutesLeft(r.expires_at))
    const expiringSoon = minutesLeftAll.filter((m) => m <= EXPIRING_SOON_MINUTES).length
    const critical = minutesLeftAll.filter((m) => m <= CRITICAL_MINUTES).length
    // `reservations[].checks` is already filtered down to
    // ACTIVE_TAB_CHECK_STATUSES in load(), so totalChecks / totalValue here
    // never include checks that were actually approved or are still
    // pending elsewhere.
    const totalChecks = reservations.reduce(
      (sum, r) => sum + (Array.isArray(r.checks) ? r.checks.length : 0),
      0
    )
    const returnedCount = reservations.reduce(
      (sum, r) => sum + (Array.isArray(r.checks) ? r.checks.filter((c) => isReturnedCheck(c)).length : 0),
      0
    )
    const totalValue = reservations.reduce((sum, r) => sum + orderTotal(lineItems(r, 'active')), 0)
    const avgChecksPerOrder = reservations.length ? (totalChecks / reservations.length).toFixed(1) : '0'
    return {
      total: reservations.length,
      expiringSoon,
      critical,
      totalChecks,
      totalValue,
      avgChecksPerOrder,
      returnedCount,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, tab, now])

  const pendingSummary = useMemo(() => {
    if (tab !== 'pending_approval') return null
    let totalChecks = 0
    let stale = 0
    let critical = 0
    let totalValue = 0
    let earliestMs = null
    reservations.forEach((r) => {
      const items = sortedLineItems(r, 'pending_approval')
      totalChecks += items.length
      totalValue += orderTotal(items)
      const submittedAtMs = earliestSubmittedAt(items)
      if (submittedAtMs) {
        const waited = minutesWaiting(submittedAtMs)
        if (waited >= PENDING_WARN_MINUTES) stale += 1
        if (waited >= PENDING_CRITICAL_MINUTES) critical += 1
        if (earliestMs === null || submittedAtMs < earliestMs) earliestMs = submittedAtMs
      }
    })
    return {
      total: reservations.length,
      totalChecks,
      totalValue,
      stale,
      critical,
      oldestWaitingLabel: earliestMs ? formatWaiting(earliestMs) : null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, tab, now])

  // History KPI summary: breaks every logged outcome down by type so an
  // admin can see at a glance how many checks were approved, released,
  // rejected, returned, or expired across the currently loaded orders —
  // mirroring the KPI treatment already used on Active / Pending Approval.
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
    return {
      total: reservations.length,
      totalChecks,
      totalValue,
      approved,
      released,
      rejected,
      returned,
      expired,
    }
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
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ type, reservation })
  }

  function openBulkReleaseConfirm() {
    if (selectedReservations.length === 0) return
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ type: 'bulk-release', reservations: selectedReservations })
  }

  function openBulkRecallConfirm() {
    if (selectedReservations.length === 0) return
    setActionError('')
    setSuccessFlash(null)
    setConfirmAction({ type: 'bulk-recall', reservations: selectedReservations })
  }

  // Stable close handler for the modal. This used to be an inline arrow
  // function passed at the JSX call site (`onCancel={() => setConfirmAction(null)}`),
  // which gets a brand-new identity every time this component re-renders —
  // including every second, since the live countdown/wait-timer ticks `now`
  // here. ActionModal's keyboard-trap effect depended on `onCancel`, so
  // that constant identity churn was re-running its "focus something"
  // logic once a second, yanking focus back to the close button while an
  // admin was mid-keystroke elsewhere in the modal. Keeping this identity
  // stable fixes that.
  const closeConfirm = useCallback(() => {
    clearTimeout(successTimerRef.current)
    setSuccessFlash(null)
    setConfirmAction(null)
  }, [])

  // Recomputed only when the confirm target actually changes, instead of
  // on every render of this component (e.g. every countdown tick).
  const confirmChecks = useMemo(() => {
    if (!confirmAction?.reservation) return []
    const sourceTab = confirmAction.type === 'recall' ? 'pending_approval' : 'active'
    return sortedLineItems(confirmAction.reservation, sourceTab)
  }, [confirmAction])
  const confirmTotal = useMemo(() => orderTotal(confirmChecks), [confirmChecks])

  // Validates that every check in the order has an explicit outcome: either
  // "picking up" with a non-empty, unique receipt (type + number) and a
  // collected answer (plus a reason if AR wasn't collected), or "not
  // picking up" with a reason. Used both to gate the submit button in the
  // UI and as a server-call guard so a race between state updates can
  // never slip an incomplete payload through.
  function findIncompleteEntry(checks, orData) {
    const seenOrNos = new Map() // normalized "TYPE-number" -> check id, to catch duplicates
    for (const c of checks) {
      const entry = orData?.[c.checkId]
      if (!entry) return { reason: 'incomplete', checkId: c.checkId }

      if (entry.include) {
        const orNo = composeReceiptNo(entry)
        if (
          !orNo ||
          entry.collected === null ||
          entry.collected === undefined ||
          entry.attached2307 === null ||
          entry.attached2307 === undefined
        ) {
          return { reason: 'incomplete', checkId: c.checkId }
        }
        const normalized = orNo.toLowerCase()
        if (seenOrNos.has(normalized)) {
          return { reason: 'duplicate', checkId: c.checkId }
        }
        seenOrNos.set(normalized, c.checkId)
      } else if (!entry.remarks?.trim()) {
        return { reason: 'missing-reason', checkId: c.checkId }
      }
    }
    return null
  }

  async function runAction(orData) {
    if (!confirmAction || actioning) return
    setActioning(true)
    setActionError('')

    try {
      if (confirmAction.type === 'bulk-release' || confirmAction.type === 'bulk-recall') {
        const isRecall = confirmAction.type === 'bulk-recall'
        const results = await Promise.allSettled(
          confirmAction.reservations.map((r) =>
            isRecall
              ? supabase.rpc('admin_recall_submission', {
                  p_reservation_id: r.id,
                  p_check_ids: sortedLineItems(r, 'pending_approval').map((c) => c.checkId),
                })
              : supabase.rpc('admin_release_reservation', { p_reservation_id: r.id })
          )
        )
        const failed = results.filter(
          (res) => res.status === 'rejected' || res.value?.error
        ).length
        const succeeded = results.length - failed

        if (!isMountedRef.current) return

        if (failed > 0 && succeeded === 0) {
          setActionError(
            `Could not ${isRecall ? 'recall' : 'return'} the selected reservations. Please try again.`
          )
          return
        }

        setConfirmAction(null)
        setSelectedIds(new Set())
        load(false)
        showToast(
          failed > 0
            ? `${isRecall ? 'Recalled' : 'Returned'} ${succeeded} of ${results.length}. ${failed} failed — try again.`
            : `${isRecall ? 'Recalled' : 'Returned'} ${succeeded} reservation${succeeded === 1 ? '' : 's'}.`,
          failed > 0 ? 'warning' : 'success'
        )
        return
      }

      const isSubmit = confirmAction.type === 'submit'
      const isRecall = confirmAction.type === 'recall'
      const fn = isSubmit
        ? 'admin_submit_for_approval'
        : isRecall
        ? 'admin_recall_submission'
        : 'admin_release_reservation'
      const rpcParams = { p_reservation_id: confirmAction.reservation.id }

      let pickedCount = 0
      let releasedCount = 0

      if (isSubmit) {
        // Defense in depth: the modal already disables the submit button
        // until every row has a complete outcome, but never trust the
        // client alone before writing to the database.
        const problem = findIncompleteEntry(confirmChecks, orData)
        if (problem) {
          setActionError(
            problem.reason === 'duplicate'
              ? 'Each check being picked up needs its own unique receipt type + number.'
              : problem.reason === 'missing-reason'
              ? 'Enter a reason for every check left off the pickup.'
              : 'Select a receipt type, enter its number, and set AR collected and 2307 Attached status for every check being picked up.'
          )
          return
        }

        // Pass a plain array/object here — supabase-js already serializes
        // this to JSON for the `jsonb` RPC param. Do NOT JSON.stringify()
        // it yourself, or Postgres receives a jsonb *string* instead of a
        // jsonb *array*, and jsonb_array_elements() blows up with
        // "cannot extract elements from a scalar".
        rpcParams.p_check_outcomes = confirmChecks.map((c) => {
          const entry = orData[c.checkId]
          if (entry.include) {
            pickedCount += 1
            return {
              check_id: c.checkId,
              picked_up: true,
              // "TYPE-number" (e.g. "OR-12345") — see composeReceiptNo()
              // and the RECEIPT TYPE NOTE at the top of this file.
              or_no: composeReceiptNo(entry),
              ar_collected: entry.collected,
              attached_2307: entry.attached2307,
              remarks: null,
            }
          }
          releasedCount += 1
          return {
            check_id: c.checkId,
            picked_up: false,
            remarks: entry.remarks.trim(),
          }
        })
      } else if (isRecall) {
        rpcParams.p_check_ids = confirmChecks.map((c) => c.checkId)
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
        // Show a brief success checkmark inside the modal, then close it.
        // The toast still fires immediately so there's a persistent
        // confirmation even after the modal is gone.
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
          : isRecall
          ? `Recalled ${collectorName}'s submission for edits.`
          : `Returned ${collectorName}'s reservation.`
      )
    } catch (err) {
      if (!isMountedRef.current) return
      setActionError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      if (isMountedRef.current) setActioning(false)
    }
  }

  function exportCsv() {
    const isHistory = tab === 'history'
    const isPending = tab === 'pending_approval'
    const isActive = tab === 'active'
    const headers = isHistory
      ? ['Collector', 'Status', 'Reserved at', 'Resolved at', 'Bank', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'Outcome', 'OR no.', 'AR collected', '2307 Attached', 'Remarks']
      : isPending
      ? ['Collector', 'Status', 'Reserved at', 'Bank', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'OR no.', 'AR collected', '2307 Attached', 'Remarks', 'Submitted by', 'Submitted at']
      : isActive
      ? ['Collector', 'Status', 'Reserved at', 'Bank', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount', 'Check status', 'Return reason', 'Returned by', 'Returned at']
      : ['Collector', 'Status', 'Reserved at', 'Bank', 'Check no.', 'Payee', 'Payor', 'Check date', 'Amount']

    const rows = [headers]
    visibleReservations.forEach((r) => {
      const items = sortedLineItems(r, tab)
      if (items.length === 0) {
        rows.push(
          isHistory
            ? [r.collector_name || '', r.status || '', r.reserved_at || '', r.picked_up_at || '', '', '', '', '', '', '', '', '', '', '', '']
            : isPending
            ? [r.collector_name || '', r.status || '', r.reserved_at || '', '', '', '', '', '', '', '', '', '', '', '', '']
            : isActive
            ? [r.collector_name || '', r.status || '', r.reserved_at || '', '', '', '', '', '', '', '', '', '', '']
            : [r.collector_name || '', r.status || '', r.reserved_at || '', '', '', '', '', '', '']
        )
        return
      }
      items.forEach((c) => {
        rows.push(
          isHistory
            ? [
                r.collector_name || '',
                r.status || '',
                r.reserved_at || '',
                r.picked_up_at || '',
                c.bank || '',
                c.check_no || '',
                c.payee || '',
                c.payor || '',
                c.check_date || '',
                c.amount ?? '',
                c.outcome || '',
                c.or_no || '',
                c.ar_collected === null || c.ar_collected === undefined ? '' : c.ar_collected ? 'Yes' : 'No',
                c.attached_2307 === null || c.attached_2307 === undefined ? '' : c.attached_2307 ? 'Yes' : 'No',
                c.remarks || '',
              ]
            : isPending
            ? [
                r.collector_name || '',
                r.status || '',
                r.reserved_at || '',
                c.bank || '',
                c.check_no || '',
                c.payee || '',
                c.payor || '',
                c.check_date || '',
                c.amount ?? '',
                c.or_no || '',
                c.ar_collected === null || c.ar_collected === undefined ? '' : c.ar_collected ? 'Yes' : 'No',
                c.attached_2307 === null || c.attached_2307 === undefined ? '' : c.attached_2307 ? 'Yes' : 'No',
                c.remarks || '',
                c.submittedByName || '',
                c.submittedAt || '',
              ]
            : isActive
            ? [
                r.collector_name || '',
                r.status || '',
                r.reserved_at || '',
                c.bank || '',
                c.check_no || '',
                c.payee || '',
                c.payor || '',
                c.check_date || '',
                c.amount ?? '',
                c.checkStatus === 'returned' ? 'Returned' : 'Reserved',
                c.returnReason || '',
                c.returnedByName || '',
                c.returnedAt || '',
              ]
            : [
                r.collector_name || '',
                r.status || '',
                r.reserved_at || '',
                c.bank || '',
                c.check_no || '',
                c.payee || '',
                c.payor || '',
                c.check_date || '',
                c.amount ?? '',
              ]
        )
      })
    })

    const csv = rows
      .map((row) =>
        row
          .map((cell) => {
            const str = String(cell ?? '')
            return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
          })
          .join(',')
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

  const allVisibleSelected =
    visibleReservations.length > 0 && visibleReservations.every((r) => selectedIds.has(r.id))
  const someVisibleSelected = visibleReservations.some((r) => selectedIds.has(r.id))

  const activeSortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label || 'Sort'
  const selectable = tab === 'active' || tab === 'pending_approval'

  return (
    <div className="pb-20 sm:pb-0">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-900">Pending pickups</h1>
          <p className="mt-1 text-sm text-ink-400">
            Checks collectors have reserved and their remaining pickup window. Submitting a pickup
            sends it to an approver for verification before it's final — nothing leaves the
            building without a second set of eyes.
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

   {tab === 'active' && activeSummary && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard
            icon={User}
            label="Active orders"
            value={loading ? null : activeSummary.total}
            secondary={loading ? null : `${activeSummary.avgChecksPerOrder} checks/order avg`}
            accent="lightTeal"
          />
          <KpiCard
            icon={Layers}
            label="Checks on hold"
            value={loading ? null : activeSummary.totalChecks}
            secondary={loading ? null : formatCurrency(activeSummary.totalValue)}
            accent="ink"
          />
          <KpiCard
            icon={Wallet}
            label="Total value"
            value={loading ? null : formatCurrency(activeSummary.totalValue)}
            secondary={
              loading
                ? null
                : `${formatCurrency(activeSummary.totalValue / (activeSummary.total || 1))} avg/order`
            }
            accent="sky"
          />
          <KpiCard
            icon={Timer}
            label={`Expiring ≤ ${EXPIRING_SOON_MINUTES}m`}
            value={loading ? null : activeSummary.expiringSoon}
            secondary={loading ? null : `${activeSummary.critical} of these ≤ ${CRITICAL_MINUTES}m`}
            accent={!loading && activeSummary.expiringSoon > 0 ? 'orange' : 'ink'}
            active={quickFilter === 'expiring'}
            onClick={() => setQuickFilter((f) => (f === 'expiring' ? 'all' : 'expiring'))}
          />
          <KpiCard
            icon={Flame}
            label={`Critical ≤ ${CRITICAL_MINUTES}m`}
            value={loading ? null : activeSummary.critical}
            secondary={!loading && activeSummary.critical > 0 ? 'Needs immediate attention' : null}
            accent={!loading && activeSummary.critical > 0 ? 'red' : 'ink'}
          />
          <KpiCard
            icon={RotateCcw}
            label="Returned for correction"
            value={loading ? null : activeSummary.returnedCount}
            secondary={!loading && activeSummary.returnedCount > 0 ? 'An approver sent these back' : null}
            accent={!loading && activeSummary.returnedCount > 0 ? 'amber' : 'ink'}
            active={quickFilter === 'returned'}
            onClick={() => setQuickFilter((f) => (f === 'returned' ? 'all' : 'returned'))}
          />
        </div>
      )}   
{tab === 'pending_approval' && pendingSummary && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiCard
            icon={ShieldCheck}
            label="Awaiting approval"
            value={loading ? null : pendingSummary.total}
            secondary={loading ? null : pendingSummary.oldestWaitingLabel ? `Oldest: ${pendingSummary.oldestWaitingLabel}` : null}
            accent="lightTeal"
          />
          <KpiCard
            icon={Hash}
            label="Checks submitted"
            value={loading ? null : pendingSummary.totalChecks}
            secondary={loading ? null : formatCurrency(pendingSummary.totalValue)}
            accent="ink"
          />
          <KpiCard
            icon={Wallet}
            label="Total value"
            value={loading ? null : formatCurrency(pendingSummary.totalValue)}
            secondary={
              loading
                ? null
                : `${formatCurrency(pendingSummary.totalValue / (pendingSummary.total || 1))} avg/submission`
            }
            accent="sky"
          />
          <KpiCard
            icon={Hourglass}
            label={`Waiting ${PENDING_WARN_MINUTES}m+`}
            value={loading ? null : pendingSummary.stale}
            secondary={loading ? null : `${pendingSummary.critical} of these ${PENDING_CRITICAL_MINUTES}m+`}
            accent={!loading && pendingSummary.stale > 0 ? 'amber' : 'ink'}
            active={quickFilter === 'stale'}
            onClick={() => setQuickFilter((f) => (f === 'stale' ? 'all' : 'stale'))}
          />
          <KpiCard
            icon={Flame}
            label={`Critical ${PENDING_CRITICAL_MINUTES}m+`}
            value={loading ? null : pendingSummary.critical}
            secondary={!loading && pendingSummary.critical > 0 ? 'Escalate to an approver' : null}
            accent={!loading && pendingSummary.critical > 0 ? 'red' : 'ink'}
          />
        </div>
      )}

      {tab === 'history' && historySummary && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard
            icon={Layers}
            label="Orders"
            value={loading ? null : historySummary.total}
            secondary={loading ? null : `${historySummary.totalChecks} checks total`}
            accent="lightTeal"
          />
          <KpiCard
            icon={Wallet}
            label="Total value"
            value={loading ? null : formatCurrency(historySummary.totalValue)}
            secondary={loading ? null : `${historySummary.totalChecks} checks`}
            accent="sky"
          />
          <KpiCard
            icon={CheckCircle2}
            label="Approved & picked up"
            value={loading ? null : historySummary.approved}
            secondary="Confirmed by an approver"
            accent="teal"
            active={quickFilter === 'picked_up'}
            onClick={() => setQuickFilter((f) => (f === 'picked_up' ? 'all' : 'picked_up'))}
          />
          <KpiCard
            icon={Undo2}
            label="Released"
            value={loading ? null : historySummary.released}
            secondary="Left off at submission"
            accent="ink"
            active={quickFilter === 'released'}
            onClick={() => setQuickFilter((f) => (f === 'released' ? 'all' : 'released'))}
          />
          <KpiCard
            icon={XCircle}
            label="Rejected"
            value={loading ? null : historySummary.rejected}
            secondary={!loading && historySummary.rejected > 0 ? 'Sent back to the pool' : null}
            accent={!loading && historySummary.rejected > 0 ? 'red' : 'ink'}
            active={quickFilter === 'rejected'}
            onClick={() => setQuickFilter((f) => (f === 'rejected' ? 'all' : 'rejected'))}
          />
          <KpiCard
            icon={RotateCcw}
            label="Returned / Expired"
            value={loading ? null : historySummary.returned + historySummary.expired}
            secondary={
              !loading
                ? `${historySummary.returned} returned · ${historySummary.expired} expired`
                : null
            }
            accent={!loading && historySummary.returned + historySummary.expired > 0 ? 'amber' : 'ink'}
            active={quickFilter === 'returned' || quickFilter === 'expired'}
            onClick={() => setQuickFilter((f) => (f === 'returned' ? 'all' : 'returned'))}
          />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md border border-ink-200 p-1">
          <TabButton active={tab === 'active'} onClick={() => setTab('active')}>
            Active
          </TabButton>
          <TabButton active={tab === 'pending_approval'} onClick={() => setTab('pending_approval')}>
            Pending Approval
          </TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
            History
          </TabButton>
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
        <div className="relative flex-1">
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
              aria-label="Clear collector filter"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

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
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>

        <div className="relative flex-1">
          <Filter className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input
            ref={searchInputRef}
            value={checkSearch}
            onChange={(e) => setCheckSearch(e.target.value)}
            placeholder="Search check #, payee, payor, OR no., or bank... (press /)"
            className="border-ink-200 pl-9 pr-8 text-sm focus-visible:ring-teal-500"
            aria-label="Search checks by number, payee, payor, OR no., or bank"
          />
          {checkSearch && (
            <button
              onClick={() => setCheckSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600"
              aria-label="Clear check search"
            >
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
              <div
                role="listbox"
                className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-ink-200 bg-white py-1 shadow-lg"
              >
                {SORT_OPTIONS.filter((o) => o.tabs.includes(tab)).map((o) => (
                  <button
                    key={o.value}
                    role="option"
                    aria-selected={sortBy === o.value}
                    onClick={() => {
                      setSortBy(o.value)
                      setSortMenuOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-ink-50',
                      sortBy === o.value ? 'text-teal-700' : 'text-ink-600'
                    )}
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
          <button
            onClick={() => load(loading)}
            className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      )}

      {selectable && visibleReservations.length > 0 && !loading && (
        <div className="mb-2 flex items-center gap-2 px-1">
          <button
            onClick={toggleSelectAllVisible}
            className="flex items-center gap-1.5 text-xs font-medium text-ink-500 hover:text-ink-700"
          >
            {allVisibleSelected ? (
              <CheckSquare className="h-4 w-4 text-teal-600" />
            ) : someVisibleSelected ? (
              <MinusSquare className="h-4 w-4 text-teal-600" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            {allVisibleSelected ? 'Deselect all' : 'Select all'}
          </button>
          {selectedIds.size > 0 && (
            <span className="text-xs text-ink-400">{selectedIds.size} selected</span>
          )}
        </div>
      )}

      {loading ? (
        <ListSkeleton />
      ) : visibleReservations.length === 0 ? (
        <EmptyState
          tab={tab}
          hasFilter={!!collectorFilter.trim() || !!bankFilter || !!checkSearch.trim() || quickFilter !== 'all'}
        />
      ) : (
        <div className="space-y-2.5">
          {visibleReservations.map((r) => {
            const items = sortedLineItems(r, tab)
            const submittedAtMs = tab === 'pending_approval' ? earliestSubmittedAt(items) : null
            return (
              <ReservationRow
                key={r.id}
                reservation={r}
                items={items}
                total={orderTotal(items)}
                tab={tab}
                minutesLeft={tab === 'active' ? minutesLeft(r.expires_at) : null}
                countdownLabel={tab === 'active' ? formatCountdown(r.expires_at) : null}
                urgencyLevel={
                  tab === 'active'
                    ? urgency(r.expires_at)
                    : tab === 'pending_approval'
                    ? pendingUrgency(submittedAtMs)
                    : 'normal'
                }
                waitingLabel={tab === 'pending_approval' ? formatWaiting(submittedAtMs) : null}
                expanded={expandedIds.has(r.id)}
                onToggleExpand={() => toggleExpand(r.id)}
                selectable={selectable}
                selected={selectedIds.has(r.id)}
                onToggleSelect={() => toggleSelect(r.id)}
                onConfirmPickup={() => openConfirm('submit', r)}
                onRelease={() => openConfirm('release', r)}
                onRecall={() => openConfirm('recall', r)}
              />
            )
          })}
        </div>
      )}

      {selectable && selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-100 bg-white px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] sm:sticky sm:mt-4 sm:rounded-lg sm:border sm:shadow-sm">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <span className="text-sm font-medium text-ink-700">
              {selectedIds.size} order{selectedIds.size === 1 ? '' : 's'} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedIds(new Set())}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50"
              >
                Clear
              </button>
              {tab === 'active' && (
                <button
                  onClick={openBulkReleaseConfirm}
                  className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Return selected
                </button>
              )}
              {tab === 'pending_approval' && (
                <button
                  onClick={openBulkRecallConfirm}
                  className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                >
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
          loading={actioning}
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
      <div
        className={cn(
          'flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium text-white shadow-lg',
          variant === 'warning' ? 'bg-orange-600' : 'bg-ink-900'
        )}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        {message}
      </div>
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

// KPI card design shared across all three tabs (Active / Pending Approval /
// History), deliberately matching the compact card language used on the
// Checks Register page (AdminChecks.jsx): a small icon in a tinted circle,
// a dashed decorative ring in the top-right corner, and compact
// value/label/secondary typography. Kept in this file (rather than a
// shared component) since the two pages currently don't share a UI module,
// but the visual language — sizing, spacing, and the accent-color system —
// is intentionally identical so the two pages read as one product.
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
    <Card
      className={cn(
        'relative overflow-hidden p-3 transition',
        isInteractive && 'hover:border-ink-200 hover:shadow-sm',
        active && cn('ring-2', style.activeRing),
      )}
    >
      <div
        className={cn(
          'pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed',
          style.ring,
        )}
        aria-hidden="true"
      />
      <div className="relative flex items-start gap-2.5">
        <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', style.badge)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-5 w-12 animate-pulse rounded bg-ink-100" />
          ) : (
            <p className="truncate font-display text-sm font-semibold text-ink-900">{value}</p>
          )}
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

// Per-check status badge for the ACTIVE tab specifically. This is what
// tells an admin apart a check that's simply reserved (never submitted, or
// resubmitted and waiting) from one an approver just sent back for
// correction. Deliberately distinct from StatusBadge above, which is for
// the reservation as a whole.
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

// Small pill for the bank a check came from, matching the treatment used on
// the Checks Register page (AdminChecks.jsx's BankBadge) so the two pages
// read as one product. Falls back to a dashed "Unknown" pill for any check
// that predates the bank column, or for banks somehow outside the fixed
// BANKS list, rather than rendering blank or crashing.
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
    <span
      className="inline-flex max-w-[160px] items-center gap-1 truncate rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700"
      title={bank}
    >
      <Landmark className="h-3 w-3 shrink-0" />
      <span className="truncate">{bank}</span>
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
  reservation,
  items,
  total,
  tab,
  minutesLeft,
  countdownLabel,
  urgencyLevel,
  waitingLabel,
  expanded,
  onToggleExpand,
  selectable,
  selected,
  onToggleSelect,
  onConfirmPickup,
  onRelease,
  onRecall,
}) {
  const checkCount = items.length
  const preview = payeePreview(items)
  const isHistory = tab === 'history'
  const isPending = tab === 'pending_approval'
  const isActive = tab === 'active'
  // Whether this specific order currently has one or more checks sitting
  // in the Active tab because an approver returned them for correction —
  // drives the extra "Status / Return reason / Returned by / Returned at"
  // columns below, and an at-a-glance banner on the collapsed row.
  const anyReturned = isActive && items.some((c) => c.checkStatus === 'returned')
  const returnedCount = isActive ? items.filter((c) => c.checkStatus === 'returned').length : 0

  const pickedCount = isHistory ? items.filter((c) => c.outcome === 'picked_up').length : 0
  const releasedCount = isHistory ? items.filter((c) => c.outcome === 'released').length : 0

  const borderClass =
    urgencyLevel === 'critical'
      ? 'border-red-300'
      : urgencyLevel === 'warning'
      ? 'border-orange-300'
      : anyReturned
      ? 'border-amber-300'
      : 'border-ink-100'

  return (
    <Card className={cn('overflow-hidden p-0', borderClass)}>
      <div className="flex items-start gap-2.5 px-3 py-3 sm:items-center sm:px-4">
        {selectable && (
          <button
            onClick={onToggleSelect}
            className="mt-0.5 shrink-0 text-ink-300 hover:text-teal-600 sm:mt-0"
            aria-label={selected ? 'Deselect order' : 'Select order'}
          >
            {selected ? (
              <CheckSquare className="h-4.5 w-4.5 text-teal-600" />
            ) : (
              <Square className="h-4.5 w-4.5" />
            )}
          </button>
        )}

        <button
          onClick={onToggleExpand}
          className="flex min-w-0 flex-1 flex-col gap-1.5 text-left sm:flex-row sm:items-center sm:gap-3"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <User className="h-4 w-4 shrink-0 text-ink-400" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-medium text-ink-900">
                  {reservation.collector_name || 'Unknown collector'}
                </span>
                <StatusBadge status={reservation.status} />
                {anyReturned && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    <RotateCcw className="h-3 w-3" />
                    {returnedCount} returned for correction
                  </span>
                )}
              </div>
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
            {tab === 'active' ? (
              <span
                className={cn(
                  'flex items-center gap-1 font-mono font-medium',
                  urgencyLevel === 'critical'
                    ? 'text-red-600'
                    : urgencyLevel === 'warning'
                    ? 'text-orange-600'
                    : 'text-teal-700'
                )}
              >
                <Clock className="h-3.5 w-3.5" />
                {countdownLabel}
              </span>
            ) : isPending ? (
              <span
                className={cn(
                  'flex items-center gap-1 font-mono font-medium',
                  urgencyLevel === 'critical'
                    ? 'text-red-600'
                    : urgencyLevel === 'warning'
                    ? 'text-orange-600'
                    : 'text-amber-600'
                )}
              >
                <Hourglass className="h-3.5 w-3.5" />
                {waitingLabel}
              </span>
            ) : (
              <span>
                Reserved {formatDate(reservation.reserved_at)}
                {reservation.picked_up_at && ` · Resolved ${formatDate(reservation.picked_up_at)}`}
              </span>
            )}
            {expanded ? (
              <ChevronUp className="h-4 w-4 text-ink-300" />
            ) : (
              <ChevronDown className="h-4 w-4 text-ink-300" />
            )}
          </div>
        </button>
      </div>

      {expanded && (
        <>
          {checkCount === 0 ? (
            <p className="border-t border-ink-100 px-4 py-3 text-xs text-ink-400">
              {isHistory
                ? "No logged activity found for this order yet — it may not have been fully processed, or its activity log entries couldn't be matched to a check."
                : 'No linked checks found for this order.'}
            </p>
          ) : (
            <div className="overflow-x-auto border-t border-ink-100">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-ink-50 text-left text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="px-4 py-2 font-medium">#</th>
                    <th className="px-2 py-2 font-medium">Bank</th>
                    <th className="px-2 py-2 font-medium">Check no.</th>
                    <th className="px-2 py-2 font-medium">Payee</th>
                    <th className="px-2 py-2 font-medium">Payor</th>
                    <th className="px-2 py-2 font-medium">Check date</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    {isActive && <th className="px-2 py-2 font-medium">Status</th>}
                    {isActive && anyReturned && <th className="px-2 py-2 font-medium">Return reason</th>}
                    {isActive && anyReturned && <th className="px-2 py-2 font-medium">Returned by</th>}
                    {isActive && anyReturned && <th className="px-4 py-2 font-medium">Returned at</th>}
                    {isPending && <th className="px-2 py-2 font-medium">OR no.</th>}
                    {isPending && <th className="px-2 py-2 font-medium">AR collected</th>}
                    {isPending && <th className="px-2 py-2 font-medium">2307 Attached</th>}
                    {isPending && <th className="px-4 py-2 font-medium">Remarks</th>}
                    {isHistory && <th className="px-2 py-2 font-medium">Outcome</th>}
                    {isHistory && <th className="px-2 py-2 font-medium">OR no.</th>}
                    {isHistory && <th className="px-2 py-2 font-medium">AR collected</th>}
                    {isHistory && <th className="px-2 py-2 font-medium">2307 Attached</th>}
                    {isHistory && <th className="px-4 py-2 font-medium">Remarks</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {items.map((c, idx) => (
                    <tr
                      key={c.id ?? `${reservation.id}-${idx}`}
                      className={cn(isActive && c.checkStatus === 'returned' && 'bg-amber-50/60')}
                    >
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-400">{idx + 1}</td>
                      <td className="px-2 py-2.5">
                        <BankBadge bank={c.bank} />
                      </td>
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
                      {isActive && (
                        <td className="px-2 py-2.5">
                          <ActiveCheckStatusBadge status={c.checkStatus} />
                        </td>
                      )}
                      {isActive && anyReturned && (
                        <td className="max-w-[220px] px-2 py-2.5 text-xs text-ink-600">
                          {c.checkStatus === 'returned' ? (
                            <span title={c.returnReason || undefined}>{c.returnReason || '—'}</span>
                          ) : (
                            <span className="text-ink-300">—</span>
                          )}
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
                      {isPending && (
                        <td className="px-2 py-2.5 font-mono text-xs text-ink-600">{c.or_no || '—'}</td>
                      )}
                      {isPending && (
                        <td className="px-2 py-2.5">
                          {c.ar_collected === null || c.ar_collected === undefined ? (
                            '—'
                          ) : c.ar_collected ? (
                            <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
                          ) : (
                            <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
                          )}
                        </td>
                      )}
                      {isPending && (
                        <td className="px-2 py-2.5">
                          {c.attached_2307 === null || c.attached_2307 === undefined ? (
                            '—'
                          ) : c.attached_2307 ? (
                            <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
                          ) : (
                            <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
                          )}
                        </td>
                      )}
                      {isPending && (
                        <td className="max-w-[220px] px-4 py-2.5 text-xs text-ink-500">{c.remarks || '—'}</td>
                      )}
                      {isHistory && (
                        <td className="px-2 py-2.5">
                          <OutcomeBadge outcome={c.outcome} />
                        </td>
                      )}
                     {isHistory && (
  <td className="px-2 py-2.5 font-mono text-xs text-ink-600">{c.or_no || '—'}</td>
)}
{isHistory && (
  <td className="px-2 py-2.5">
    {c.ar_collected === null || c.ar_collected === undefined ? (
      '—'
    ) : c.ar_collected ? (
      <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
    ) : (
      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
    )}
  </td>
)}
{isHistory && (
  <td className="px-2 py-2.5">
    {c.attached_2307 === null || c.attached_2307 === undefined ? (
      '—'
    ) : c.attached_2307 ? (
      <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700">Yes</span>
    ) : (
      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">No</span>
    )}
  </td>
)}
{isHistory && (
  <td className="max-w-[220px] px-4 py-2.5 text-xs text-ink-500">
    {c.remarks || '—'}
  </td>
)}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-100 bg-ink-50/40">
                    <td colSpan={6} className="px-4 py-2 text-right text-xs font-medium text-ink-500">
                      Order total
                    </td>
                    <td className="px-4 py-2 text-right font-mono font-semibold text-ink-900">
                      {formatCurrency(total)}
                    </td>
                 {isHistory && <td colSpan={5} />}
{isPending && <td colSpan={4} />}
{isActive && <td colSpan={anyReturned ? 4 : 1} />}
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
                Return
              </button>
              <button
                onClick={onConfirmPickup}
                className="flex items-center gap-1.5 rounded-md bg-orange-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-600"
              >
                <Send className="h-3.5 w-3.5" />
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
                className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50"
                title="Pull this submission back to make corrections"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Recall for edits
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// Builds the initial per-check entry map: every check starts "included"
// (assumed picked up) with no receipt type/number chosen yet and no "AR
// collected" answer, so the admin's default action is a full pickup — they
// only need to touch rows for checks that are actually being left behind.
function buildInitialCheckEntries(checks) {
  const initial = {}
  checks.forEach((c) => {
    initial[c.checkId] = {
      include: true,
      receiptType: '',
      receiptNo: '',
      collected: null,
      attached2307: null,
      remarks: '',
    }
  })
  return initial
}

// ---------------------------------------------------------------------------
// Action modal
//
// Shared by five action types (submit / release / recall / bulk-release /
// bulk-recall), so the container and header/footer chrome stay one
// consistent shell — but the SUBMIT flow is the data-heavy one, so its body
// is laid out to match the Submit-for-Approval modal on the Checks
// Register page (AdminChecks.jsx): a summary strip up top, then one clearly
// separated row-card per check instead of a dense table, so an admin
// entering receipt/AR/2307 data for several checks at once always has a
// clear place to look. The simpler release/recall confirmations keep a
// compact review table, since there's nothing to edit there — just checks
// to confirm.
// ---------------------------------------------------------------------------
function ActionModal({ action, checks, total, onCancel, onConfirm, loading, error, successFlash }) {
  const isSubmit = action.type === 'submit'
  const isRelease = action.type === 'release'
  const isRecall = action.type === 'recall'
  const isBulkRelease = action.type === 'bulk-release'
  const isBulkRecall = action.type === 'bulk-recall'
  const reservation = action.reservation
  const checkCount = checks.length
  const dialogRef = useRef(null)
  const cancelButtonRef = useRef(null)
  // Focuses the first row's receipt-TYPE dropdown on open (see the mount
  // effect below) — the number field for that row doesn't exist until a
  // type is picked, so the dropdown is the right thing to land focus on,
  // not the (not-yet-rendered) number input.
  const firstReceiptFieldRef = useRef(null)

  // Whether any check in THIS submit flow was previously returned by an
  // approver — if so we surface the reason/who/when right in the outcome
  // cards so the admin knows exactly what to fix before resubmitting.
  const anyReturnedInModal = isSubmit && checks.some((c) => c.checkStatus === 'returned')

  // Per-check state for the submit flow: whether it's included in this
  // pickup, its receipt type + number and AR collected answer if so, its
  // 2307 attached answer, and a reason (required only when the check
  // isn't included at all). Irrelevant for the release/recall flows.
  const [orEntries, setOrEntries] = useState(() => buildInitialCheckEntries(checks))

  const updateInclude = useCallback((checkId, value) => {
    setOrEntries((prev) => ({
      ...prev,
      [checkId]: {
        ...prev[checkId],
        include: value,
        receiptType: value ? prev[checkId]?.receiptType || '' : '',
        receiptNo: value ? prev[checkId]?.receiptNo || '' : '',
        collected: value ? prev[checkId]?.collected ?? null : null,
        attached2307: value ? prev[checkId]?.attached2307 ?? null : null,
        remarks: '',
      },
    }))
  }, [])

  // Changing the receipt type clears any previously entered number — a
  // number typed while "OR" was selected shouldn't silently carry over and
  // get treated as, say, a "CR" number just because the admin corrected a
  // wrong type selection.
  const updateReceiptType = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], receiptType: value, receiptNo: '' } }))
  }, [])

  const updateReceiptNo = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], receiptNo: value } }))
  }, [])

  const updateCollected = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], collected: value } }))
  }, [])

  const updateAttached2307 = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], attached2307: value } }))
  }, [])

  const updateRemarks = useCallback((checkId, value) => {
    setOrEntries((prev) => ({ ...prev, [checkId]: { ...prev[checkId], remarks: value } }))
  }, [])

  // How many checks currently have a complete outcome, how many are
  // included (being submitted for pickup), and whether any composed
  // receipt values (type + number together) collide.
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
        const hasCollectedAnswer = entry.collected !== null && entry.collected !== undefined
        const hasAttachedAnswer = entry.attached2307 !== null && entry.attached2307 !== undefined
        if (orNo && hasCollectedAnswer && hasAttachedAnswer) {
          completed += 1
        }
        if (orNo) {
          const key = orNo.toLowerCase()
          seenCounts[key] = (seenCounts[key] || 0) + 1
        }
      } else if (entry.remarks?.trim()) {
        completed += 1
      }
    })
    const duplicates = new Set(
      Object.entries(seenCounts)
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
    )
    return { completedCount: completed, duplicateOrNos: duplicates, includeCount: included }
  }, [orEntries, checks])

  const hasDuplicates = duplicateOrNos.size > 0
  const allComplete = !isSubmit || (checkCount > 0 && completedCount === checkCount && !hasDuplicates)
  const releaseCount = checkCount - includeCount
  const submitTotalAmount = useMemo(
    () => checks.reduce((sum, c) => (orEntries[c.checkId]?.include ? sum + (Number(c.amount) || 0) : sum), 0),
    [checks, orEntries],
  )

  // Runs once on mount: focuses the first row's receipt-type dropdown (so
  // an admin can start choosing immediately) or, if there's nothing to
  // interact with, the Cancel button as a safe default. Deliberately an
  // empty dependency array — this must NOT re-run whenever
  // `onCancel`/`loading` change, or it steals focus back away from
  // whatever the admin is doing every time this component re-renders for
  // an unrelated reason.
  useEffect(() => {
    const previouslyFocused = document.activeElement
    if (isSubmit && firstReceiptFieldRef.current) {
      firstReceiptFieldRef.current.focus()
    } else {
      cancelButtonRef.current?.focus()
    }

    // Prevent the page behind the modal from scrolling while it's open.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = prevOverflow
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape-to-close and a light focus trap so keyboard users aren't
  // dropped out of the modal into the page behind it. Kept separate from
  // the mount effect above so updating `loading`/`onCancel` only rebinds
  // the listener — it never touches focus.
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
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [loading, onCancel])

  function handleConfirmClick() {
    if (isSubmit && !allComplete) return
    onConfirm(isSubmit ? orEntries : undefined)
  }

  const title = isSubmit
    ? 'Submit pickup for approval'
    : isRecall
    ? 'Recall submission'
    : isBulkRecall
    ? 'Recall selected submissions'
    : isBulkRelease
    ? 'Return selected orders'
    : 'Return reservation'

  const subtitle = isSubmit
    ? checkCount === 1
      ? '1 check will be sent to an approver for verification before it can be marked picked up.'
      : `${checkCount} checks will be reviewed here, then sent to an approver for verification.`
    : isRecall
    ? "Pulls this submission back to your Active list so you can fix a mistake before resubmitting."
    : isBulkRecall
    ? `Pulls ${action.reservations?.length ?? 0} submissions back to Active so corrections can be made.`
    : isBulkRelease
    ? `Returns ${action.reservations?.length ?? 0} orders to the available pool immediately.`
    : 'Returns this order to the available pool immediately.'

  const confirmLabel = isSubmit
    ? includeCount === 0
      ? 'Release All'
      : includeCount === checkCount
      ? 'Submit for Approval'
      : 'Submit Partial for Approval'
    : isRecall
    ? 'Recall for Edits'
    : isBulkRecall
    ? `Recall ${action.reservations.length}`
    : isBulkRelease
    ? `Return ${action.reservations.length}`
    : 'Return'

  const isSimpleList = isRelease || isRecall
  // The submit flow needs real editing room; the other four flows are just
  // a review-and-confirm list, so they stay in a smaller, non-scrolling-body
  // dialog rather than stretching to fill the viewport for no reason.
  const HeaderIcon = isSubmit ? Send : isRecall || isBulkRecall ? RotateCcw : Undo2

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/50 p-4 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading && !successFlash) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pickup-action-title"
        className={cn(
          'relative flex w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl',
          isSubmit ? 'h-[90vh] max-w-6xl' : 'max-h-[85vh] max-w-2xl',
        )}
      >
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-100 px-7 py-5">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
                isSubmit
                  ? 'bg-orange-500/10 text-orange-600'
                  : isRecall || isBulkRecall
                  ? 'bg-amber-500/10 text-amber-600'
                  : 'bg-ink-100 text-ink-600',
              )}
            >
              <HeaderIcon className="h-5 w-5" />
            </div>
            <div>
              <h2 id="pickup-action-title" className="text-lg font-semibold text-ink-900">
                {title}
              </h2>
              <p className="mt-0.5 text-sm text-ink-400">{subtitle}</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            disabled={loading}
            className="shrink-0 rounded-full p-1.5 text-ink-300 hover:bg-ink-50 hover:text-ink-600 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ── Body ─────────────────────────────────────────────────── */}
        <div className={cn('flex-1 overflow-y-auto px-7 py-6', isSubmit && 'bg-ink-50/40')}>
          {(isBulkRelease || isBulkRecall) && (
            <div className="max-h-72 overflow-y-auto rounded-xl border border-ink-100">
              <ul className="divide-y divide-ink-50 text-sm">
                {action.reservations.map((r) => (
                  <li key={r.id} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-ink-800">{r.collector_name || 'Unknown collector'}</span>
                    <span className="text-xs text-ink-400">
                      {(r.checks || []).length} check{(r.checks || []).length === 1 ? '' : 's'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(isRelease || isRecall) && (
            <p className="text-sm text-ink-600">
              {isRecall ? (
                <>
                  This pulls <span className="font-medium text-ink-900">{reservation.collector_name}</span>
                  's submission of {checkCount} check{checkCount === 1 ? '' : 's'} back out of the
                  approval queue so you can fix a mistake — a wrong OR number, for example — before
                  resubmitting. It goes back to your Active list; nothing is released to the pool.
                </>
              ) : (
                <>
                  This returns this order of {checkCount} check{checkCount === 1 ? '' : 's'} held for{' '}
                  <span className="font-medium text-ink-900">{reservation.collector_name}</span> back into the
                  available pool immediately. Use this if the collector cancelled or won't be coming.
                </>
              )}
            </p>
          )}

          {/* ── Submit flow: collector summary strip ────────────────── */}
          {isSubmit && checkCount > 0 && (
            <div className="rounded-xl border border-ink-100 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2.5">
                  <UserRound className="h-4 w-4 text-ink-400" />
                  <div>
                    <p className="text-sm font-semibold text-ink-900">
                      {reservation.collector_name || 'Unknown collector'}
                    </p>
                    <p className="text-xs text-ink-400">
                      Confirm what's actually being picked up right now — uncheck anything the
                      collector isn't taking today.
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <SummaryPill label="to submit" value={includeCount} tone="neutral" />
                  {releaseCount > 0 && <SummaryPill label="to release" value={releaseCount} tone="warning" />}
                  <SummaryPill
                    label="details entered"
                    value={`${completedCount}/${checkCount}`}
                    tone={allComplete ? 'positive' : 'warning'}
                  />
                  <SummaryPill label="submitting amount" value={formatCurrency(submitTotalAmount)} tone="neutral" mono />
                </div>
              </div>
            </div>
          )}

          {/* ── Submit flow: per-check cards ─────────────────────────── */}
          {isSubmit && checkCount > 0 && (
            <div className="mt-5">
              <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <ClipboardList className="h-3.5 w-3.5" />
                Per-check outcome
              </div>

              <div className="flex flex-col gap-3">
                {checks.map((c, idx) => {
                  const entry =
                    orEntries[c.checkId] || {
                      include: true,
                      receiptType: '',
                      receiptNo: '',
                      collected: null,
                      attached2307: null,
                      remarks: '',
                    }
                  const composedReceipt = composeReceiptNo(entry)
                  const isDuplicate = entry.include && composedReceipt && duplicateOrNos.has(composedReceipt.toLowerCase())
                  // A free-text reason is only needed when a check is being
                  // released outright. AR collected and 2307 Attached are
                  // plain yes/no answers with no justification required.
                  const needsReason = !entry.include
                  const missingReason = needsReason && !entry.remarks?.trim()
                  const rowIncomplete = entry.include
                    ? !composedReceipt ||
                      entry.collected === null ||
                      entry.collected === undefined ||
                      entry.attached2307 === null ||
                      entry.attached2307 === undefined
                    : missingReason
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
                      {/* Returned-for-correction banner, shown only on checks
                          an approver actually sent back, so the admin sees
                          exactly what needs fixing before resubmitting. */}
                      {wasReturned && (
                        <div className="flex flex-wrap items-start gap-1.5 rounded-t-xl border-b border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
                          <RotateCcw className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>
                            <span className="font-semibold">Returned:</span>{' '}
                            {c.returnReason || 'No reason given'}
                            <span className="text-amber-600">
                              {' '}
                              — {formatDateTime(c.returnedAt)}
                              {c.returnedByName ? ` · ${c.returnedByName}` : ''}
                            </span>
                          </span>
                        </div>
                      )}

                      {/* Row header: check identity + include toggle + status */}
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => updateInclude(c.checkId, !entry.include)}
                            aria-pressed={entry.include}
                            aria-label={
                              entry.include
                                ? `Mark check ${c.check_no || idx + 1} as not picked up`
                                : `Mark check ${c.check_no || idx + 1} as picked up`
                            }
                            className={cn(
                              'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition',
                              entry.include
                                ? 'text-teal-600 hover:bg-teal-50'
                                : 'text-ink-300 hover:bg-ink-50 hover:text-ink-500',
                            )}
                          >
                            {entry.include ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                            {entry.include ? 'Picking up' : 'Not today'}
                          </button>
                          <div className="h-6 w-px bg-ink-100" />
                          <BankBadge bank={c.bank} />
                          <div>
                            <p className="text-sm font-semibold text-ink-900">{c.payee || '—'}</p>
                            <p className="font-mono text-[11px] text-ink-400">
                              Check {c.check_no || '—'}
                              {c.payor ? ` · from ${c.payor}` : ''}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-semibold text-ink-800">
                            {formatCurrency(c.amount)}
                          </span>
                          {entry.include && (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                                isDuplicate
                                  ? 'bg-red-100 text-red-700'
                                  : rowComplete
                                  ? 'bg-teal-100 text-teal-700'
                                  : 'bg-amber-100 text-amber-700',
                              )}
                            >
                              {isDuplicate ? (
                                <>
                                  <AlertTriangle className="h-3 w-3" /> Duplicate receipt
                                </>
                              ) : rowComplete ? (
                                <>
                                  <Check className="h-3 w-3" /> Complete
                                </>
                              ) : (
                                <>
                                  <AlertTriangle className="h-3 w-3" /> Incomplete
                                </>
                              )}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Row body: receipt / AR / 2307 / reason inputs */}
                      {entry.include ? (
                        <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
                          <div>
                            <label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                              <ReceiptText className="h-3 w-3" />
                              Receipt
                            </label>
                            <div className="flex gap-1.5">
                              <select
                                ref={idx === 0 ? firstReceiptFieldRef : undefined}
                                value={entry.receiptType}
                                onChange={(e) => updateReceiptType(c.checkId, e.target.value)}
                                aria-label={`Receipt type for check ${c.check_no || idx + 1}`}
                                className="w-20 rounded-md border border-ink-200 px-2 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40"
                              >
                                <option value="">Type</option>
                                {RECEIPT_TYPES.map((rt) => (
                                  <option key={rt} value={rt}>
                                    {rt}
                                  </option>
                                ))}
                              </select>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={entry.receiptNo}
                                onChange={(e) => updateReceiptNo(c.checkId, e.target.value)}
                                onBlur={(e) => updateReceiptNo(c.checkId, e.target.value.trim())}
                                placeholder="Number"
                                maxLength={40}
                                disabled={!entry.receiptType}
                                aria-label={`Receipt number for check ${c.check_no || idx + 1}`}
                                className={cn(
                                  'min-w-0 flex-1 rounded-md border px-2 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40 disabled:bg-ink-50 disabled:text-ink-300',
                                  isDuplicate ? 'border-red-400' : 'border-ink-200',
                                )}
                              />
                            </div>
                            {isDuplicate && (
                              <p className="mt-1 text-[10px] font-medium text-red-600">Already used above</p>
                            )}
                          </div>

                          <div>
                            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                              AR collected
                            </label>
                            <div
                              className="flex gap-1.5"
                              role="group"
                              aria-label={`AR collected for check ${c.check_no || idx + 1}`}
                            >
                              <YesNoButton
                                active={entry.collected === true}
                                onClick={() => updateCollected(c.checkId, true)}
                                label="Yes"
                                tone="positive"
                              />
                              <YesNoButton
                                active={entry.collected === false}
                                onClick={() => updateCollected(c.checkId, false)}
                                label="No"
                                tone="neutral"
                              />
                            </div>
                          </div>

                          <div>
                            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                              2307 Attached
                            </label>
                            <div
                              className="flex gap-1.5"
                              role="group"
                              aria-label={`2307 Attached for check ${c.check_no || idx + 1}`}
                            >
                              <YesNoButton
                                active={entry.attached2307 === true}
                                onClick={() => updateAttached2307(c.checkId, true)}
                                label="Yes"
                                tone="positive"
                              />
                              <YesNoButton
                                active={entry.attached2307 === false}
                                onClick={() => updateAttached2307(c.checkId, false)}
                                label="No"
                                tone="neutral"
                              />
                            </div>
                          </div>
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
                            className={cn(
                              'w-full max-w-md rounded-md border px-2.5 py-2 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-teal-500/40',
                              missingReason ? 'border-orange-400' : 'border-ink-200',
                            )}
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
                  {hasDuplicates
                    ? 'Each check being picked up needs its own unique receipt type + number.'
                    : 'Every check needs an outcome: receipt type & number, AR collected, and 2307 Attached status if picking up, or a reason if not.'}
                </p>
              )}
            </div>
          )}

          {isSimpleList && checkCount > 0 && (
            <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-ink-100">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-ink-50">
                  <tr className="text-left uppercase tracking-wide text-ink-400">
                    <th className="px-3 py-2 font-medium">Bank</th>
                    <th className="px-3 py-2 font-medium">Check no.</th>
                    <th className="px-3 py-2 font-medium">Payee</th>
                    <th className="px-3 py-2 font-medium">Payor</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {checks.map((c, idx) => (
                    <tr key={c.checkId ?? idx}>
                      <td className="px-3 py-2">
                        <BankBadge bank={c.bank} />
                      </td>
                      <td className="px-3 py-2 font-mono text-ink-700">{c.check_no || '—'}</td>
                      <td className="max-w-[110px] truncate px-3 py-2 text-ink-900">{c.payee || '—'}</td>
                      <td className="max-w-[110px] truncate px-3 py-2 text-ink-600">{c.payor || '—'}</td>
                      <td className="px-3 py-2 text-ink-500">
                        {c.check_date ? formatDate(c.check_date) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-ink-700">
                        {formatCurrency(c.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-100 bg-ink-50/60">
                    <td colSpan={5} className="px-3 py-2 text-right font-medium text-ink-500">
                      Total
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-ink-900">
                      {formatCurrency(total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {(isRelease || isBulkRelease) && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-orange-50 px-3 py-2.5 text-xs text-orange-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {isBulkRelease
                ? 'These reservations will be marked as not picked up.'
                : "This collector's reservation will be marked as not picked up."}
            </div>
          )}

          {(isRecall || isBulkRecall) && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-700">
              <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {isBulkRecall
                ? 'These will need to be resubmitted for approval after you make your corrections.'
                : "This will need to be resubmitted for approval after you make your corrections."}
            </div>
          )}

          {error && (
            <p className="mt-4 flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-ink-100 bg-white px-7 py-4">
          <p className="hidden text-xs text-ink-400 sm:block">
            {isSubmit
              ? `${completedCount} of ${checkCount} checks ready · ${formatCurrency(submitTotalAmount)} submitting`
              : null}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button
              ref={cancelButtonRef}
              onClick={onCancel}
              disabled={loading}
              className="rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmClick}
              disabled={loading || (isSubmit && !allComplete)}
              title={isSubmit && !allComplete ? 'Every check needs a complete outcome before submitting' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60',
                isSubmit ? 'bg-orange-500 hover:bg-orange-600' : 'bg-ink-900 hover:bg-ink-800'
              )}
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirmLabel}
            </button>
          </div>
        </div>

        {/* Success overlay: shown briefly right after the RPC call
            succeeds, covering the form so admins get a clear, celebratory
            "done" signal before the modal auto-closes. Purely presentational
            — the toast (rendered by the parent, outside this modal) is the
            durable confirmation that survives after this unmounts. */}
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

// Small labeled stat used in the submit modal's collector summary strip —
// matches SummaryPill in AdminChecks.jsx's SubmitApprovalModal so both
// submit flows read identically at a glance.
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

// Shared Yes/No toggle button used for the AR-collected and 2307-Attached
// controls in the submit modal — matches YesNoButton in AdminChecks.jsx.
function YesNoButton({ active, onClick, label, tone }) {
  const activeClass =
    tone === 'positive' ? 'border-teal-600 bg-teal-600 text-white' : 'border-ink-700 bg-ink-700 text-white'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex-1 rounded-md border px-2 py-2 text-xs font-medium transition',
        active ? activeClass : 'border-ink-200 text-ink-500 hover:bg-ink-50',
      )}
    >
      {label}
    </button>
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
    active: {
      title: 'No active reservations',
      body: 'Orders reserved by collectors will show up here until submitted or expired.',
    },
    pending_approval: {
      title: 'Nothing awaiting approval',
      body: 'Pickups you submit will show up here until an approver decides on them.',
    },
    history: {
      title: 'No history yet',
      body: 'Completed, expired, released, and rejected orders will appear here.',
    },
  }[tab]

  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-ink-200 px-4 py-16 text-center">
      <Clock className="h-8 w-8 text-ink-200" />
      <p className="mt-3 text-lg font-semibold text-ink-700">
        {hasFilter ? 'No matching reservations' : copy.title}
      </p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        {hasFilter ? 'Try a different search, or clear the filters.' : copy.body}
      </p>
    </div>
  )
}