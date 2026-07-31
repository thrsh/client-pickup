// lib/staleChecks.js
//
// Single source of truth for two unrelated-but-frequently-paired concerns
// in the Verifier flow:
//
//   1. "Is this check stale, nearing stale, or normal?" — driven entirely
//      by check_date, using a fixed business rule (STALE_FIXED_MONTHS).
//      Used by VerifierChecks.jsx (KPI counts + row tinting) and
//      StaleWatchPanel.jsx (the Stale Watch tab's grouping/badges).
//
//   2. Collector name normalization/deduping — so "john doe",
//      "John Doe", and "JOHN   DOE" are treated as the same collector
//      everywhere (filters, suggestions, and what actually gets saved).
//
// Both are deliberately kept in one small, dependency-free module so any
// screen that needs either can import from exactly one place. If you add
// a third place that needs to decide "is this check stale" (a new report,
// a new dashboard, etc.), import STALE_FIXED_MONTHS / isStale from here
// rather than hardcoding another threshold — see the note below about
// AdminReports.jsx, which currently does NOT import from this file and
// should be pointed here to avoid two independent definitions of "stale"
// drifting apart.

// ---------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------

// Fixed business rule: a check is "stale" once its check_date is this
// many months in the past. Intentionally not configurable at runtime —
// every caller (KPI counts, the Stale Watch tab, any report) must agree
// on the same number or the different screens will disagree about which
// checks are stale.
export const STALE_FIXED_MONTHS = 6

// A check enters the "nearing stale" warning window when it is within
// this many days of crossing the STALE_FIXED_MONTHS threshold.
export const WARNING_WINDOW_DAYS = 7

export const STALE_BUCKETS = Object.freeze({
  NORMAL: 'normal',
  WARNING: 'warning',
  STALE: 'stale',
})

// ---- date helpers ------------------------------------------------------
//
// All built from local Y/M/D parts rather than toISOString() (which is
// UTC-based and can silently roll a date backward/forward by a day near
// midnight in the user's timezone). This matters here because these
// values are compared directly against a `date` column (check_date),
// where an off-by-one-day error would misclassify checks right at the
// boundary.

function pad2(n) {
  return String(n).padStart(2, '0')
}

function toDateInputValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Today, as a "YYYY-MM-DD" string. */
export function todayDateInputValue() {
  return toDateInputValue(new Date())
}

/** The date exactly `months` calendar months before today, as "YYYY-MM-DD". */
export function monthsAgoDateInputValue(months) {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return toDateInputValue(d)
}

/** The date exactly `days` calendar days before today, as "YYYY-MM-DD". */
export function daysAgoDateInputValue(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return toDateInputValue(d)
}

/**
 * The check_date cutoff for "already stale": any check dated on or
 * before this day has crossed the STALE_FIXED_MONTHS threshold.
 * `check_date <= staleCutoffDateInputValue()` ⇒ stale.
 */
export function staleCutoffDateInputValue() {
  return monthsAgoDateInputValue(STALE_FIXED_MONTHS)
}

/**
 * The check_date cutoff for "nearing stale": any check dated on or
 * before this day (but strictly after the stale cutoff) will cross the
 * STALE_FIXED_MONTHS threshold within WARNING_WINDOW_DAYS days.
 *
 * This is LATER (more recent) than staleCutoffDateInputValue() — it's
 * the stale cutoff shifted forward by WARNING_WINDOW_DAYS days, since a
 * check dated closer to today is "younger" and therefore further from
 * going stale. So:
 *   check_date <= staleCutoffDateInputValue()                       -> stale
 *   staleCutoffDateInputValue() < check_date <= warningCutoff...()  -> nearing
 *   check_date > warningCutoffDateInputValue()                     -> normal
 */
export function warningCutoffDateInputValue() {
  const cutoff = new Date(staleCutoffDateInputValue())
  cutoff.setDate(cutoff.getDate() + WARNING_WINDOW_DAYS)
  return toDateInputValue(cutoff)
}

// Parses a "YYYY-MM-DD" (or any Date-parseable) value defensively.
// Returns null for missing/invalid input instead of throwing or
// producing an "Invalid Date" that silently poisons comparisons.
function safeParseDate(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Classifies a check_date into STALE_BUCKETS.{STALE,WARNING,NORMAL}.
 * Missing or unparseable dates are treated as NORMAL (never flagged) —
 * a check with no date on file shouldn't silently show up as an urgent
 * bank-return item.
 */
export function getStaleBucket(checkDate) {
  const parsed = safeParseDate(checkDate)
  if (!parsed) return STALE_BUCKETS.NORMAL

  const value = toDateInputValue(parsed)
  if (value <= staleCutoffDateInputValue()) return STALE_BUCKETS.STALE
  if (value <= warningCutoffDateInputValue()) return STALE_BUCKETS.WARNING
  return STALE_BUCKETS.NORMAL
}

/** Convenience boolean — equivalent to getStaleBucket(...) === STALE. */
export function isStale(checkDate) {
  return getStaleBucket(checkDate) === STALE_BUCKETS.STALE
}

/** Convenience boolean — equivalent to getStaleBucket(...) === WARNING. */
export function isNearingStale(checkDate) {
  return getStaleBucket(checkDate) === STALE_BUCKETS.WARNING
}

/**
 * Whole calendar days between `checkDate` and today (>= 0). Returns null
 * for a missing/unparseable date. Useful for an "Aging (Days)" column —
 * NOT the same measurement as the age-since-upload used elsewhere in
 * the app (see AdminReports.jsx's daysBetween, which measures from
 * created_at instead); this one is always relative to check_date.
 */
export function daysSinceCheckDate(checkDate) {
  const parsed = safeParseDate(checkDate)
  if (!parsed) return null
  const start = new Date(parsed)
  const end = new Date()
  start.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)
  const diff = Math.round((end - start) / 86400000)
  return diff < 0 ? 0 : diff
}

// ---------------------------------------------------------------------
// Collector name normalization
// ---------------------------------------------------------------------

/**
 * Normalizes a collector name for STORAGE and for exact-match filtering:
 * trims leading/trailing whitespace and collapses any run of internal
 * whitespace (spaces, tabs, newlines) down to a single space.
 *
 * Casing is deliberately left exactly as typed — a person's name is
 * theirs to capitalize how they like, and the app never silently
 * rewrites it to Title Case or similar. What actually prevents "John
 * Doe" / "john doe" / "JOHN DOE" from being treated as different
 * collectors is that every comparison against a stored name uses a
 * case-insensitive match (ilike in Supabase filters, or
 * collatorEquals()/dedupeCollectorNames() below in JS) — never a
 * case-sensitive one.
 *
 * Returns '' for null/undefined/non-string input rather than throwing,
 * so callers can safely do `if (!normalizeCollectorName(x)) { ... }`
 * to detect "effectively empty" input.
 */
export function normalizeCollectorName(name) {
  if (typeof name !== 'string') return ''
  return name.trim().replace(/\s+/g, ' ')
}

// Locale-aware, case-insensitive comparator used for both the dedupe
// logic below and any UI sorting of collector names. Falls back to a
// simple lowercase comparison if Intl.Collator isn't available for some
// reason (very old environments) — never throws.
let _collator = null
function getCollator() {
  if (_collator) return _collator
  try {
    _collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  } catch {
    _collator = { compare: (a, b) => a.localeCompare(b) }
  }
  return _collator
}

/**
 * True if two collector names are the same person once normalized for
 * whitespace and compared case-insensitively (locale-aware — so accented
 * variants like "José"/"jose" that a simple .toLowerCase() might miss in
 * some locales are still treated consistently by the same rule used for
 * sorting/deduping below).
 */
export function collectorNamesMatch(a, b) {
  const normA = normalizeCollectorName(a)
  const normB = normalizeCollectorName(b)
  if (!normA || !normB) return normA === normB
  return getCollator().compare(normA, normB) === 0
}

/**
 * De-duplicates a list of raw collector-name strings (as pulled from
 * `checks.picked_up_by` / `checks.collector_name`, which can contain
 * inconsistent casing/whitespace for the same real person) down to one
 * entry per distinct person.
 *
 * For each group of names that only differ by case/whitespace, the
 * MOST FREQUENTLY occurring exact surface form is kept as the canonical
 * display value (ties broken by whichever was seen first) — this tends
 * to surface however that collector's name is usually typed, rather
 * than an arbitrary "first one we happened to see" pick.
 *
 * Falsy entries (null/undefined/empty/whitespace-only) are dropped. The
 * result is sorted alphabetically (locale-aware, case-insensitive) so
 * it's ready to drop straight into a suggestion list.
 */
export function dedupeCollectorNames(rawNames) {
  if (!Array.isArray(rawNames)) return []

  // key -> { counts: Map<surfaceForm, count>, firstSeenOrder: number }
  const groups = new Map()
  let order = 0

  for (const raw of rawNames) {
    const normalized = normalizeCollectorName(raw)
    if (!normalized) continue

    const key = normalized.toLocaleLowerCase()
    if (!groups.has(key)) {
      groups.set(key, { counts: new Map(), firstSeenOrder: order++ })
    }
    const group = groups.get(key)
    group.counts.set(normalized, (group.counts.get(normalized) || 0) + 1)
  }

  const result = []
  for (const group of groups.values()) {
    let bestForm = null
    let bestCount = -1
    for (const [form, count] of group.counts) {
      if (count > bestCount) {
        bestForm = form
        bestCount = count
      }
    }
    if (bestForm) result.push(bestForm)
  }

  return result.sort((a, b) => getCollator().compare(a, b))
}