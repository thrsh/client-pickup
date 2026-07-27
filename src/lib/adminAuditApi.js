import { supabase } from '../lib/supabaseClient'

/* ============================================================================
 * Constants
 * ==========================================================================*/

export const PAGE_SIZE = 15 // shared with UI so pagination math never drifts
const MAX_PER_PAGE = 200
const DEFAULT_PER_PAGE = 50

const ACTOR_CACHE_TTL_MS = 5 * 60 * 1000 // actor names/roles churn rarely
const SESSIONS_CACHE_TTL_MS = 30 * 1000 // login/logout status should feel near-live
const USER_CACHE_TTL_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 15000
const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 400

// How far back to look for login/logout events when computing each user's
// current session status. Wide enough to catch a user who logged in days
// ago and never logged out, capped so the query stays cheap.
const SESSION_LOOKBACK_DAYS = 30
const SESSION_EVENT_ROW_CAP = 5000

// A login with no matching logout after this long is treated as "offline,
// session expired" rather than "online" — guards against stale/zombie
// sessions (crashed tab, force-quit browser) reading as still active.
const SESSION_STALE_AFTER_MS = 12 * 60 * 60 * 1000 // 12 hours

const CHECK_ACTION_VALUES = new Set([
  'submitted_for_approval', 'approved', 'rejected', 'returned',
  'released', 'expired', 'picked_up', 'recalled', 'resubmitted',
])
const SYSTEM_ACTION_VALUES = new Set([
  'login', 'login_failed', 'logout',
  'account_created', 'password_reset_requested', 'password_reset_completed',
  'account_activated', 'account_deactivated', 'role_changed',
  'report_generated', 'report_exported', 'checks_uploaded',
])
const ROLE_VALUES = new Set(['admin', 'verifier', 'approver'])
const SORT_COLUMNS = { time: 'performed_at', action: 'action' }

// Validates a custom "from/to" date range. Returns { fromIso, toIso } or
// throws — never silently clamps, since a silently-wrong date range in an
// audit trail is worse than an explicit error telling the user to fix it.
function resolveDateRange({ sinceDays, fromDate, toDate }) {
  if (fromDate || toDate) {
    if (!fromDate || !toDate) {
      throw new AuditApiError('Both a start and end date are required for a custom range.', { code: 'INVALID_FILTER' })
    }
    const from = new Date(`${fromDate}T00:00:00.000Z`)
    const to = new Date(`${toDate}T23:59:59.999Z`)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new AuditApiError('Invalid date range.', { code: 'INVALID_FILTER' })
    }
    if (from > to) {
      throw new AuditApiError('Start date must be before end date.', { code: 'INVALID_FILTER' })
    }
    return { fromIso: from.toISOString(), toIso: to.toISOString() }
  }
  if (sinceDays) {
    return { fromIso: new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString(), toIso: null }
  }
  return { fromIso: null, toIso: null }
}

/* ============================================================================
 * Error handling
 *
 * Every failure this module throws is either:
 *   - an Error named 'AbortError' (the caller cancelled on purpose — a new
 *     filter superseded this request, or the component unmounted), or
 *   - an AuditApiError (a real failure: bad input, network, or a Postgres/
 *     PostgREST error), which callers can inspect via `.retryable` / `.code`.
 *
 * Callers should always check isAbortError(err) first and treat it as a
 * silent no-op — it is not a failure, it's an intentionally superseded
 * request.
 * ==========================================================================*/

export class AuditApiError extends Error {
  constructor(message, { cause, code = null, retryable = false } = {}) {
    super(message)
    this.name = 'AuditApiError'
    this.code = code
    this.retryable = retryable
    if (cause) this.cause = cause
  }
}

export function isAbortError(err) {
  return (
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    err?.code === 20 ||
    err?.code === 'ABORT_ERR' ||
    /abort/i.test(err?.message || '')
  )
}

function toAbortError(err) {
  const abortErr = new Error(err?.message || 'aborted')
  abortErr.name = 'AbortError'
  return abortErr
}

// Transient, worth-a-quiet-retry failures only — never validation errors,
// auth errors, or aborts. Keeps retries from masking real bugs.
function isRetryable(err) {
  if (isAbortError(err)) return false
  const msg = (err?.message || '').toLowerCase()
  return (
    err?.code === 'ECONNRESET' ||
    err?.code === '57014' || // Postgres statement_timeout
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs `fn` with quiet exponential-backoff retries on transient failures.
 * Aborts (signal already cancelled, or thrown mid-flight) always propagate
 * immediately without retrying — the caller no longer wants this request.
 */
async function withRetry(fn, { signal, retries = MAX_RETRIES } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw toAbortError(signal.reason ? { message: String(signal.reason) } : null)
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (isAbortError(err) || !isRetryable(err) || attempt === retries) throw err
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt)
    }
  }
  throw lastErr
}

/**
 * Combines the caller's cancellation signal with a hard request timeout, so
 * a hung request can never block the UI indefinitely even if the caller
 * never cancels. Always call the returned `cleanup()` in a finally block.
 */
function withTimeout(externalSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()

  function onExternalAbort() {
    controller.abort(externalSignal.reason)
  }

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason)
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  const timer = setTimeout(() => {
    const timeoutErr = typeof DOMException !== 'undefined'
      ? new DOMException('Request timed out', 'TimeoutError')
      : Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })
    controller.abort(timeoutErr)
  }, timeoutMs)

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

/* ============================================================================
 * Small utilities
 * ==========================================================================*/

// Escapes PostgREST ilike wildcards (% _) and the comma/paren characters
// that have special meaning inside .or() filter strings, so user-typed
// search text can't alter the query structure.
function escapeFilterValue(value) {
  return value.replace(/[%_,()]/g, (ch) => `\\${ch}`)
}

function clampPerPage(perPage) {
  const n = Number(perPage)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PER_PAGE
  return Math.min(n, MAX_PER_PAGE)
}

function normalizePage(page) {
  return Math.max(1, Number(page) || 1)
}

/* ============================================================================
 * Actor cache
 *
 * The actor list (who has ever performed_by on a check_activity_log row)
 * barely changes between requests, but was previously re-fetched on every
 * CheckActivityTab mount. Cached module-side with a TTL + in-flight
 * de-duplication so concurrent mounts share one request.
 * ==========================================================================*/

let actorCache = { data: null, expiresAt: 0, inflight: null }

export function invalidateActorCache() {
  actorCache = { data: null, expiresAt: 0, inflight: null }
}

export async function listCheckActivityActors({ signal, forceRefresh = false } = {}) {
  const now = Date.now()
  if (!forceRefresh && actorCache.data && actorCache.expiresAt > now) {
    return actorCache.data
  }
  if (!forceRefresh && actorCache.inflight) {
    return actorCache.inflight
  }

  const { signal: combinedSignal, cleanup } = withTimeout(signal)

  const request = (async () => {
    try {
      const result = await withRetry(async () => {
        const { data, error } = await supabase
          .from('check_activity_log')
          .select('performed_by, actor:profiles!check_activity_log_performed_by_profile_fkey(full_name)')
          .not('performed_by', 'is', null)
          .abortSignal(combinedSignal)

        if (error) {
          if (isAbortError(error)) throw toAbortError(error)
          throw new AuditApiError(error.message || 'Failed to load actors', { cause: error })
        }

        const seen = new Map()
        ;(data || []).forEach((row) => {
          if (row.performed_by && !seen.has(row.performed_by)) {
            seen.set(row.performed_by, row.actor?.full_name || 'Unknown')
          }
        })
        return [...seen.entries()]
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }, { signal: combinedSignal })

      actorCache = { data: result, expiresAt: Date.now() + ACTOR_CACHE_TTL_MS, inflight: null }
      return result
    } catch (err) {
      actorCache.inflight = null
      throw isAbortError(err) || err instanceof AuditApiError
        ? err
        : new AuditApiError(err?.message || 'Failed to load actors', { cause: err })
    } finally {
      cleanup()
    }
  })()

  actorCache.inflight = request
  return request
}

/* ============================================================================
 * Check activity log (Tab 1: submit / approve / reject / recall / resubmit
 * / return / expire / pick up)
 * ==========================================================================*/

/**
 * Fetch a page of check_activity_log, filtered and sorted server-side.
 *
 * Requires the check_activity_log_performed_by_profile_fkey FK so `profiles`
 * can be embedded directly, and the migration_recall_reason.sql migration
 * for the `previous_data` column (used by the audit-trail diff view).
 */
export async function listCheckActivityLog({
  page = 1,
  perPage = DEFAULT_PER_PAGE,
  search = '',
  role = 'all',
  action = 'all',
  actorId = '',
  sinceDays = null,
  fromDate = null, // 'YYYY-MM-DD', inclusive — takes precedence over sinceDays
  toDate = null,   // 'YYYY-MM-DD', inclusive
  sortKey = 'time',
  sortDir = 'desc',
  signal,
} = {}) {
  if (action !== 'all' && !CHECK_ACTION_VALUES.has(action)) {
    throw new AuditApiError(`Invalid action filter: ${action}`, { code: 'INVALID_FILTER' })
  }
  if (role !== 'all' && !ROLE_VALUES.has(role)) {
    throw new AuditApiError(`Invalid role filter: ${role}`, { code: 'INVALID_FILTER' })
  }

  const safePage = normalizePage(page)
  const safePerPage = clampPerPage(perPage)
  const from = (safePage - 1) * safePerPage
  const to = from + safePerPage - 1

  // A plain left-join embed (`profiles!fk(...)`) only trims which embedded
  // row comes back, it does NOT exclude parent rows — `.eq('actor.role', ...)`
  // alone silently fails to filter. `!inner` is required, and only added
  // when a role filter is actually active so the unfiltered case still
  // includes rows whose actor lookup is null.
  const actorJoin = role !== 'all'
    ? 'profiles!check_activity_log_performed_by_profile_fkey!inner'
    : 'profiles!check_activity_log_performed_by_profile_fkey'

  const { signal: combinedSignal, cleanup } = withTimeout(signal)

  try {
    return await withRetry(async () => {
      let query = supabase
        .from('check_activity_log')
        .select(
          `
          id, check_id, reservation_id, collector_name, action, or_no,
          ar_collected, remarks, performed_at, performed_by, submitted_by,
          approved_by, submitted_by_name, approved_by_name, attached_2307,
          previous_data,
          check:checks!check_activity_log_check_id_fkey ( check_no, payee, payor, amount, bank ),
          actor:${actorJoin} ( full_name, role )
          `,
          { count: 'exact' }
        )

      if (actorId) query = query.eq('performed_by', actorId)
      if (action !== 'all') query = query.eq('action', action)
      if (role !== 'all') query = query.eq('actor.role', role)
    const { fromIso, toIso } = resolveDateRange({ sinceDays, fromDate, toDate })
      if (fromIso) query = query.gte('performed_at', fromIso)
      if (toIso) query = query.lte('performed_at', toIso)

      const trimmed = search.trim()
      if (trimmed) {
        const term = `%${escapeFilterValue(trimmed)}%`
        query = query.or(
          [`collector_name.ilike.${term}`, `remarks.ilike.${term}`, `or_no.ilike.${term}`].join(',')
        )
        // Filtering on embedded checks.* columns (payee/payor/check_no) via
        // .or() isn't reliably supported by PostgREST alongside a second
        // embed filter in the same call. If check-level search is needed,
        // expose a Postgres RPC/view flattening the joined columns instead.
      }

      const sortColumn = SORT_COLUMNS[sortKey] || 'performed_at'
      query = query.order(sortColumn, { ascending: sortDir === 'asc' }).range(from, to)
      query = query.abortSignal(combinedSignal)

      const { data, error, count } = await query
      if (error) {
        if (isAbortError(error)) throw toAbortError(error)
        throw new AuditApiError(error.message || 'Failed to load activity log', { cause: error, retryable: true })
      }

      const logs = (data || []).map((row) => ({
        id: row.id,
        performed_at: row.performed_at,
        check_id: row.check_id,
        reservation_id: row.reservation_id,
        actor_id: row.performed_by,
        actor_name: row.actor?.full_name || null,
        actor_role: row.actor?.role || null,
        action: row.action,
        or_no: row.or_no,
        ar_collected: row.ar_collected,
        attached_2307: row.attached_2307,
        remarks: row.remarks,
        collector_name: row.collector_name,
        submitted_by_name: row.submitted_by_name,
        approved_by_name: row.approved_by_name,
        previous_data: row.previous_data || null,
        check: row.check || null,
      }))

      return { logs, total: count ?? logs.length, page: safePage, perPage: safePerPage }
    }, { signal: combinedSignal })
  } catch (err) {
    throw isAbortError(err) || err instanceof AuditApiError
      ? err
      : new AuditApiError(err?.message || 'Failed to load activity log', { cause: err })
  } finally {
    cleanup()
  }
}

// Backward-compatible alias for existing imports. Prefer listCheckActivityLog.
export const listAuditLogs = listCheckActivityLog

/** Full, unpaginated export for CSV — same filters, capped to a sane ceiling. */
export async function exportCheckActivityLog(filters = {}, { maxRows = 5000, signal } = {}) {
  const { logs } = await listCheckActivityLog({ ...filters, page: 1, perPage: maxRows, signal })
  return logs
}

/* ============================================================================
 * Account & system activity (Tab 2: logins, password resets, account status
 * changes, report/export events) — reads the separate audit_log table.
 * ==========================================================================*/

export async function listAuditLog({
  page = 1,
  perPage = DEFAULT_PER_PAGE,
  search = '',
  action = 'all',
  sinceDays = null,
  fromDate = null,   // ← this line
  toDate = null,     // ← and this line
  sortKey = 'time',
  sortDir = 'desc',
  signal,
} = {}) {
  if (action !== 'all' && !SYSTEM_ACTION_VALUES.has(action)) {
    throw new AuditApiError(`Invalid action filter: ${action}`, { code: 'INVALID_FILTER' })
  }

  const safePage = normalizePage(page)
  const safePerPage = clampPerPage(perPage)
  const from = (safePage - 1) * safePerPage
  const to = from + safePerPage - 1

  const { signal: combinedSignal, cleanup } = withTimeout(signal)

  try {
    return await withRetry(async () => {
      let query = supabase
        .from('audit_log')
        .select(
          `
          id, action, performed_by, target_type, target_id, metadata, performed_at,
          actor:profiles!audit_log_performed_by_fkey ( full_name, role )
          `,
          { count: 'exact' }
        )

      if (action !== 'all') query = query.eq('action', action)
   const { fromIso, toIso } = resolveDateRange({ sinceDays, fromDate, toDate })
      if (fromIso) query = query.gte('performed_at', fromIso)
      if (toIso) query = query.lte('performed_at', toIso)

      const trimmed = search.trim()
      if (trimmed) {
        const term = `%${escapeFilterValue(trimmed)}%`
        query = query.or([`target_type.ilike.${term}`, `target_id.ilike.${term}`].join(','))
        // Same embedded-column .or() limitation noted in listCheckActivityLog
        // above — this does not currently reach actor.full_name.
      }

      const sortColumn = sortKey === 'time' ? 'performed_at' : sortKey
      query = query.order(sortColumn, { ascending: sortDir === 'asc' }).range(from, to)
      query = query.abortSignal(combinedSignal)

      const { data, error, count } = await query
      if (error) {
        if (isAbortError(error)) throw toAbortError(error)
        throw new AuditApiError(error.message || 'Failed to load account activity', { cause: error, retryable: true })
      }

      const logs = (data || []).map((row) => ({
        id: row.id,
        performed_at: row.performed_at,
        performed_by_name: row.actor?.full_name || null,
        performed_by_role: row.actor?.role || null,
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        metadata: row.metadata || null,
      }))

      return { logs, total: count ?? logs.length, page: safePage, perPage: safePerPage }
    }, { signal: combinedSignal })
  } catch (err) {
    throw isAbortError(err) || err instanceof AuditApiError
      ? err
      : new AuditApiError(err?.message || 'Failed to load account activity', { cause: err })
  } finally {
    cleanup()
  }
}

/* ============================================================================
 * User sessions (login / logout status per user)
 *
 * Derives a "current session" view per user from the same audit_log table
 * that already stores 'login' / 'logout' / 'login_failed' events — no schema
 * change required. Because PostgREST has no "latest row per group" primitive
 * without a custom view/RPC, this pulls a bounded, recent window of
 * login/logout events and reduces it client-side to one summary per user.
 * That reduction is O(rows) and the window is capped, so it stays cheap even
 * on an active system.
 * ==========================================================================*/

let sessionsCache = { data: null, expiresAt: 0, inflight: null }

export function invalidateUserSessionsCache() {
  sessionsCache = { data: null, expiresAt: 0, inflight: null }
}

function computeSessionStatus(lastLogin, lastLogout, now = Date.now()) {
  if (!lastLogin) {
    return { status: 'never_logged_in', sessionDurationMs: null }
  }
  const loginTime = new Date(lastLogin).getTime()
  const logoutTime = lastLogout ? new Date(lastLogout).getTime() : null

  // A logout recorded after the last login closes out that session cleanly.
  if (logoutTime && logoutTime >= loginTime) {
    return { status: 'offline', sessionDurationMs: logoutTime - loginTime }
  }

  // No logout since the last login. Still "online" unless it's gone stale
  // (browser closed / crashed without ever firing the logout event).
  const elapsed = now - loginTime
  if (elapsed > SESSION_STALE_AFTER_MS) {
    return { status: 'stale', sessionDurationMs: elapsed }
  }
  return { status: 'online', sessionDurationMs: elapsed }
}
/* ============================================================================
 * Session status metadata — shared between AdminAuditTrail's User Sessions
 * tab and AdminUsers' online-status column, so both pages describe the same
 * four states identically instead of maintaining two copies.
 * ==========================================================================*/

export const SESSION_STATUS_LABELS = {
  online: 'Online',
  offline: 'Offline',
  stale: 'Session expired',
  never_logged_in: 'Never signed in',
}

export function getSessionStatusLabel(status) {
  return SESSION_STATUS_LABELS[status] || SESSION_STATUS_LABELS.offline
}
/**
 * Returns one row per known user: { id, name, role, lastLogin, lastLogout,
 * lastFailedLogin, status, sessionDurationMs }. `status` is one of
 * 'online' | 'offline' | 'stale' | 'never_logged_in'.
 *
 * Users who have a profile but no login/logout rows in the lookback window
 * still appear (as 'never_logged_in' or with only their most recent known
 * event), so the roster is never silently incomplete.
 */
export async function listUserSessions({ signal, forceRefresh = false } = {}) {
  const now = Date.now()
  if (!forceRefresh && sessionsCache.data && sessionsCache.expiresAt > now) {
    return sessionsCache.data
  }
  if (!forceRefresh && sessionsCache.inflight) {
    return sessionsCache.inflight
  }

  const { signal: combinedSignal, cleanup } = withTimeout(signal)

  const request = (async () => {
    try {
      const result = await withRetry(async () => {
        const cutoff = new Date(now - SESSION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

        const [profilesRes, eventsRes, createdRes] = await Promise.all([
          supabase
            .from('profiles')
            .select('id, full_name, role')
            .abortSignal(combinedSignal),
          supabase
            .from('audit_log')
            .select('performed_by, action, performed_at, target_id')
            .in('action', ['login', 'logout', 'login_failed'])
            .gte('performed_at', cutoff)
            .order('performed_at', { ascending: false })
            .limit(SESSION_EVENT_ROW_CAP)
            .abortSignal(combinedSignal),
          // account_created is logged against the *creating* admin as
          // performed_by, with the new user's id in target_id — so it's
          // looked up separately and matched on target_id, not performed_by.
          supabase
            .from('audit_log')
            .select('target_id, performed_at')
            .eq('action', 'account_created')
            .not('target_id', 'is', null)
            .order('performed_at', { ascending: false })
            .limit(SESSION_EVENT_ROW_CAP)
            .abortSignal(combinedSignal),
        ])

        if (profilesRes.error) {
          if (isAbortError(profilesRes.error)) throw toAbortError(profilesRes.error)
          throw new AuditApiError(profilesRes.error.message || 'Failed to load users', { cause: profilesRes.error })
        }
        if (eventsRes.error) {
          if (isAbortError(eventsRes.error)) throw toAbortError(eventsRes.error)
          throw new AuditApiError(eventsRes.error.message || 'Failed to load session events', { cause: eventsRes.error, retryable: true })
        }
        // account_created lookups are best-effort: older deployments may not
        // have this action logged yet, or target_id may not be populated for
        // historical rows. Never let that break the whole sessions view —
        // fall back to no creation timestamps instead of throwing.
        const createdByUser = new Map()
        if (!createdRes.error) {
          ;(createdRes.data || []).forEach((row) => {
            if (row.target_id && !createdByUser.has(row.target_id)) {
              createdByUser.set(row.target_id, row.performed_at)
            }
          })
        }

        // Events are already ordered newest-first, so the first time we see
        // a given (user, action) pair is that user's most recent one.
        const latestByUser = new Map()
        ;(eventsRes.data || []).forEach((row) => {
          if (!row.performed_by) return
          if (!latestByUser.has(row.performed_by)) {
            latestByUser.set(row.performed_by, { login: null, logout: null, login_failed: null })
          }
          const entry = latestByUser.get(row.performed_by)
          if (!entry[row.action]) entry[row.action] = row.performed_at
        })

        const sessions = (profilesRes.data || []).map((profile) => {
          const entry = latestByUser.get(profile.id) || { login: null, logout: null, login_failed: null }
          const { status, sessionDurationMs } = computeSessionStatus(entry.login, entry.logout, now)
          return {
            id: profile.id,
            name: profile.full_name || 'Unknown',
            role: profile.role || null,
            lastLogin: entry.login,
            lastLogout: entry.logout,
            lastFailedLogin: entry.login_failed,
            createdAt: createdByUser.get(profile.id) || null,
            status,
            sessionDurationMs,
          }
        })

        // Most recently active users first; users who've never logged in
        // sink to the bottom, most-recently-created first, rather than
        // interleaving unpredictably.
        sessions.sort((a, b) => {
          if (!a.lastLogin && !b.lastLogin) {
            if (a.createdAt && b.createdAt) return new Date(b.createdAt) - new Date(a.createdAt)
            if (a.createdAt) return -1
            if (b.createdAt) return 1
            return a.name.localeCompare(b.name)
          }
          if (!a.lastLogin) return 1
          if (!b.lastLogin) return -1
          return new Date(b.lastLogin) - new Date(a.lastLogin)
        })

        return sessions
      }, { signal: combinedSignal })

      sessionsCache = { data: result, expiresAt: Date.now() + SESSIONS_CACHE_TTL_MS, inflight: null }
      return result
    } catch (err) {
      sessionsCache.inflight = null
      throw isAbortError(err) || err instanceof AuditApiError
        ? err
        : new AuditApiError(err?.message || 'Failed to load user sessions', { cause: err })
    } finally {
      cleanup()
    }
  })()

  sessionsCache.inflight = request
  return request
}

/* ============================================================================
 * Audit event writer
 * ==========================================================================*/

let userCache = { id: null, expiresAt: 0 }

export function invalidateUserIdCache() {
  userCache = { id: null, expiresAt: 0 }
}

async function getCachedUserId() {
  const now = Date.now()
  if (userCache.id && userCache.expiresAt > now) return userCache.id
  const { data, error } = await supabase.auth.getUser()
  if (error) throw new AuditApiError(error.message || 'Not authenticated', { cause: error })
  userCache = { id: data?.user?.id ?? null, expiresAt: now + USER_CACHE_TTL_MS }
  return userCache.id
}

/**
 * Records a successful sign-in. Takes the user id explicitly (from the
 * auth.signIn() response) rather than relying on getCachedUserId(), so
 * there's no dependency on auth state having settled yet.
 */
export async function recordLogin(userId, metadata = {}) {
  if (!userId) return
  invalidateUserIdCache() // don't let a previous user's cached id leak in
  const { error } = await supabase.from('audit_log').insert({
    action: 'login',
    performed_by: userId,
    metadata,
  })
  if (error) throw new AuditApiError(error.message || 'Failed to log login', { cause: error })
  invalidateUserSessionsCache()
}

/**
 * Records a sign-out. MUST be called with the user id captured BEFORE
 * supabase.auth.signOut() runs — once signOut() completes there is no
 * session left, so anything relying on auth.getUser() to identify the
 * actor would fail silently (this was the actual root cause of logouts
 * never appearing: they were being logged AFTER signOut() using
 * getCachedUserId(), which by then had nothing to return).
 */
export async function recordLogout(userId, metadata = {}) {
  if (!userId) return
  const { error } = await supabase.from('audit_log').insert({
    action: 'logout',
    performed_by: userId,
    metadata,
  })
  invalidateUserIdCache()
  if (error) throw new AuditApiError(error.message || 'Failed to log logout', { cause: error })
  invalidateUserSessionsCache()
}

/** Records a failed sign-in attempt. userId may be null if the email/identifier didn't resolve to a known account. */
export async function recordLoginFailed(userId, metadata = {}) {
  const { error } = await supabase.from('audit_log').insert({
    action: 'login_failed',
    performed_by: userId,
    metadata,
  })
  if (error) throw new AuditApiError(error.message || 'Failed to log failed login', { cause: error })
}

/**
 * Logs that an admin created a new user account. `newUserId` is stored as
 * the audit row's target_id (the account acted upon), while performed_by
 * is automatically set to whichever admin is currently authenticated —
 * NOT the new user, since they haven't signed in yet.
 *
 * Call this immediately after the new profile row is successfully created,
 * e.g.:
 *   const { data: newUser, error } = await supabase.from('profiles').insert({...}).select().single()
 *   if (!error) logAccountCreated(newUser.id, { email: newUser.email, role: newUser.role }).catch(() => {})
 */
export async function logAccountCreated(newUserId, metadata = {}) {
  return logAuditEvent('account_created', metadata, 'profile', newUserId)
}

/**
 * Fire-and-forget write to audit_log. Callers in the UI already
 * `.catch(() => {})` this — a failed audit write should never block or
 * surface an error for the action the user actually cares about (e.g. a
 * CSV export that already succeeded locally).
 *
 * Deliberately NOT retried: a retried insert on a flaky connection risks
 * writing the same event twice, which is worse for an audit trail than
 * occasionally missing one entry.
 */
export async function logAuditEvent(action, metadata = {}, targetType = null, targetId = null) {
  try {
    const userId = await getCachedUserId()
    const { error } = await supabase.from('audit_log').insert({
      action,
      performed_by: userId,
      target_type: targetType,
      target_id: targetId,
      metadata,
    })
    if (error) throw new AuditApiError(error.message || 'Failed to log audit event', { cause: error })
  } catch (err) {
    throw err instanceof AuditApiError ? err : new AuditApiError(err?.message || 'Failed to log audit event', { cause: err })
  }
}