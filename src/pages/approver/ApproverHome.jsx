// src/pages/approver/ApproverHome.jsx
//
// Tab shell for the approver area. Hosts two independent workflows as
// tabs, each fully self-contained and each already safe to poll/refresh
// on its own:
//
//   - "pickup" -> <PickupApprovalsTab>   (formerly this file's content;
//                 see MIGRATION NOTE below)
//   - "stale"  -> <ApproverStaleReports> (lazy-loaded — see LAZY LOADING)
//
// Route-level access is enforced by <ProtectedRoute roles={['approver','admin']}>
// one level up; this shell still gates rendering on role so an
// unauthorized user never even triggers the lazy import for the stale
// tab (see "authorized" below).
//
// MIGRATION NOTE:
//   The component that used to live directly in this file path
//   (exported as `PickupApprovalsTab`, accepting `active` / `refreshToken`
//   / `onSynced` props) must be saved as its own file:
//     src/pages/approver/PickupApprovalsTab.jsx
//   No changes are required to that file's internals — its prop contract
//   already matches what this shell expects, which is why it was safe to
//   extract as-is.
//
// TAB STATE / URL SYNC:
//   Active tab is mirrored to `?tab=pickup|stale` in the URL via
//   history.replaceState (no router dependency assumed — if this app
//   already uses react-router, swap useTabQueryParam below for
//   useSearchParams; the rest of this file is unaffected either way).
//   Refreshing the page, or sharing/bookmarking the URL, lands back on
//   the same tab. Browser back/forward is also respected.
//
// LAZY LOADING:
//   ApproverStaleReports is only imported (React.lazy) the first time its
//   tab is actually selected — an approver who never opens "Stale
//   reports" in a session never pays for that chunk or its initial fetch.
//   Once loaded, BOTH tabs stay mounted (toggled via a `hidden` class,
//   not conditional rendering) so that switching tabs never discards a
//   tab's search/filter/pagination state. Each tab component receives
//   `active` so it can pause its own polling/realtime work while hidden
//   instead of wastefully running in the background.
//
// DESIGN PASS (visual polish, no behavioral changes to the above):
//   - The tab nav uses a single measured, sliding "pill" indicator
//     (indicatorStyle/recalcIndicator below) instead of restyling each
//     button independently — this is what makes switching tabs read as
//     one continuous motion rather than two buttons independently
//     flipping color/background.
//   - <TabPanel> gives each tab's content a brief fade + rise on
//     activation instead of an instant hard cut when the `hidden` class
//     toggles. Both the indicator and the panel transition respect
//     prefers-reduced-motion (see prefersReducedMotion()) and are
//     skipped outright for users who've asked for less motion.
//   - <TabLoadingSkeleton> mirrors the actual header / KPI-row / toolbar
//     / list-row shapes of ApproverStaleReports (rather than generic
//     gray bars), so the lazy-loaded tab's first paint doesn't visibly
//     jump around once real content arrives.
//   - Tab badge counts get a brief scale "flash" when they change
//     (useFlashOnChange), a small signal that the number just moved
//     without needing a toast for it.
//   - "Refresh all" gives immediate spin feedback on click, independent
//     of when each tab's own fetch actually resolves — clicking it
//     should never feel like it did nothing.
//
// RACE-CONDITION / ISOLATION NOTES:
//   - Each tab manages its own fetch lifecycle (AbortController, request
//     IDs) — see the top-of-file comments in PickupApprovalsTab.jsx and
//     ApproverStaleReports.jsx respectively. This shell does not need to
//     duplicate that logic; it only needs to avoid *causing* races, which
//     is why tabs are hidden rather than unmounted (unmounting mid-fetch
//     is already handled inside each tab via its own isMountedRef/abort
//     cleanup, but there's no reason to force that path on every tab
//     switch).
//   - `refreshToken` is a simple incrementing counter passed to both tabs.
//     Bumping it (via the header "Refresh all" button) asks both tabs to
//     silently re-fetch, independent of their own auto-refresh timers.
//   - `onSynced` lets each tab report back a lightweight
//     `{ count, lastUpdated }` summary for the tab badge, without this
//     shell needing to know anything about either tab's internal data
//     shape.
//   - <TabErrorBoundary> wraps the stale-reports tab only. A render
//     crash inside that tab shows a local "try again" fallback and never
//     takes down the pickup-approvals tab sitting right next to it. The
//     pickup tab is deliberately NOT wrapped the same way here — if you
//     want the same isolation for it, wrap it identically; it was left
//     alone only because it isn't part of this migration's blast radius.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, Suspense, lazy } from 'react'
import { RefreshCw, Stamp, FileClock, AlertTriangle, ShieldAlert, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useProfile, hasRole } from '../../context/ProfileContext'
import PickupApprovalsTab from './PickupApprovalsTab'

const ApproverStaleReportsTab = lazy(() => import('./ApproverStaleReports'))

const ALLOWED_ROLES = ['approver', 'admin']
const VALID_TABS = ['pickup', 'stale']
const DEFAULT_TAB = 'pickup'
const REFRESH_PULSE_MS = 700
const BADGE_FLASH_MS = 500

const TAB_CONFIG = [
  { key: 'pickup', label: 'Pickup approvals', icon: Stamp },
  { key: 'stale', label: 'Stale reports', icon: FileClock },
]

// One place to check for reduced-motion, used to skip every purely
// decorative transition in this file (the sliding tab indicator, the
// panel fade-in, the badge flash) — the underlying state changes are
// unaffected either way.
function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

// Reads/writes `?tab=` without pulling in a router dependency. Falls back
// to DEFAULT_TAB for any missing/invalid value so a bad or stale URL
// can't strand the user on a tab that doesn't exist.
function useTabQueryParam() {
  const [tab, setTabState] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_TAB
    const fromUrl = new URLSearchParams(window.location.search).get('tab')
    return VALID_TABS.includes(fromUrl) ? fromUrl : DEFAULT_TAB
  })

  const setTab = useCallback((next) => {
    if (!VALID_TABS.includes(next)) return
    setTabState(next)
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    params.set('tab', next)
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`)
  }, [])

  useEffect(() => {
    function handlePopState() {
      const fromUrl = new URLSearchParams(window.location.search).get('tab')
      setTabState(VALID_TABS.includes(fromUrl) ? fromUrl : DEFAULT_TAB)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  return [tab, setTab]
}

// Briefly reports `true` for BADGE_FLASH_MS right after `value` changes
// (and never on first mount) — used to give a tab's count badge a small
// scale-up pulse when a background refresh moves the number, so the
// change registers without needing a toast.
function useFlashOnChange(value) {
  const prevRef = useRef(value)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (value === prevRef.current) return
    prevRef.current = value
    if (prefersReducedMotion()) return
    setFlashing(true)
    const id = window.setTimeout(() => setFlashing(false), BADGE_FLASH_MS)
    return () => window.clearTimeout(id)
  }, [value])
  return flashing
}

// Isolates a render crash inside `children` so it can't take the rest of
// ApproverHome down with it. Deliberately a class component — error
// boundaries have no hooks-based equivalent.
class TabErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ApproverHome] stale reports tab crashed:', error, info)
  }
  handleRetry = () => this.setState({ hasError: false, error: null })
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-red-200 bg-red-50/40 px-4 py-16 text-center">
          <AlertTriangle className="h-8 w-8 text-red-300" />
          <p className="font-display text-lg font-semibold text-ink-700">This tab hit an error</p>
          <p className="max-w-sm text-sm text-ink-400">
            {this.state.error?.message || 'Something went wrong rendering this tab.'}
          </p>
          <button
            onClick={this.handleRetry}
            className="rounded-md border border-ink-200 px-3.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// Wraps a tab's content so activating it plays a short fade + rise
// instead of the instant hard cut a bare `hidden` toggle would give.
// Content is never unmounted on deactivation — only hidden — so a tab's
// internal state (filters, scroll position, selection) survives every
// switch; this wrapper only affects the transition on the way IN.
function TabPanel({ active, children }) {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (!active) {
      setEntered(false)
      return
    }
    if (prefersReducedMotion()) {
      setEntered(true)
      return
    }
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [active])

  return (
    <div className={!active ? 'hidden' : undefined}>
      <div
        className="tab-panel-fade"
        style={{
          opacity: entered ? 1 : 0,
          transform: entered ? 'translateY(0)' : 'translateY(4px)',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// Mirrors the real header / KPI-row / toolbar / list-row shapes of
// ApproverStaleReports rather than generic gray bars, so the lazy chunk's
// first paint doesn't visibly reflow once real content replaces it.
function TabLoadingSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-ink-100" />
        <div className="flex-1 space-y-2">
          <div className="h-2.5 w-32 animate-pulse rounded bg-ink-100" />
          <div className="h-5 w-56 animate-pulse rounded bg-ink-100" />
          <div className="h-3 w-full max-w-md animate-pulse rounded bg-ink-50" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-ink-100 p-4">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-ink-100" />
              <div className="h-2 w-14 animate-pulse rounded bg-ink-100" />
            </div>
            <div className="mt-2.5 h-5 w-10 animate-pulse rounded bg-ink-100" />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="h-9 min-w-[180px] flex-1 animate-pulse rounded-md border border-ink-100 bg-ink-50/60" />
        <div className="h-9 w-32 animate-pulse rounded-md border border-ink-100 bg-ink-50/60" />
        <div className="h-9 w-24 animate-pulse rounded-md border border-ink-100 bg-ink-50/60" />
      </div>

      <div className="space-y-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border border-ink-100 bg-white px-4 py-3">
            <div className="h-4.5 w-4.5 shrink-0 animate-pulse rounded bg-ink-100" />
            <div className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-ink-100" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-40 animate-pulse rounded bg-ink-100" />
              <div className="h-2.5 w-24 animate-pulse rounded bg-ink-50" />
            </div>
            <div className="h-3 w-16 shrink-0 animate-pulse rounded bg-ink-100" />
            <div className="h-3 w-14 shrink-0 animate-pulse rounded bg-ink-50" />
          </div>
        ))}
      </div>
    </div>
  )
}

function AccessDenied() {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-red-200 bg-red-50/40 px-4 py-16 text-center">
      <ShieldAlert className="h-8 w-8 text-red-300" />
      <p className="mt-3 text-lg font-semibold text-ink-700">You don't have access to this page</p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        This area requires the approver or admin role. If this seems wrong, ask an admin to check your account's role.
      </p>
    </div>
  )
}

export default function ApproverHome() {
  const { role, loading: profileLoading } = useProfile()
  const authorized = hasRole(role, ALLOWED_ROLES)

  const [tab, setTab] = useTabQueryParam()
  // The stale-reports chunk/tab only ever mounts once its tab has been
  // selected at least once in this session — this is what makes the
  // React.lazy import actually lazy in practice, not just in name.
  const [staleActivated, setStaleActivated] = useState(tab === 'stale')
  useEffect(() => {
    if (tab === 'stale') setStaleActivated(true)
  }, [tab])

  const [refreshToken, setRefreshToken] = useState(0)
  const [refreshPulsing, setRefreshPulsing] = useState(false)
  const [pickupMeta, setPickupMeta] = useState({ count: 0, lastUpdated: null })
  const [staleMeta, setStaleMeta] = useState({ count: 0, lastUpdated: null })

  const bumpRefresh = useCallback(() => {
    setRefreshToken((t) => t + 1)
    // Gives the button itself immediate feedback that the click landed,
    // independent of how long either tab's actual fetch takes to settle.
    setRefreshPulsing(true)
    window.setTimeout(() => setRefreshPulsing(false), REFRESH_PULSE_MS)
  }, [])

  // Stable callback identities so neither tab's polling effects re-fire
  // just because this shell re-rendered.
  const onPickupSynced = useCallback((meta) => setPickupMeta(meta), [])
  const onStaleSynced = useCallback((meta) => setStaleMeta(meta), [])

  const pickupFlash = useFlashOnChange(pickupMeta.count)
  const staleFlash = useFlashOnChange(staleMeta.count)
  const metaByTab = { pickup: pickupMeta, stale: staleMeta }
  const flashByTab = { pickup: pickupFlash, stale: staleFlash }

  // Measures the active tab button's position/width so the indicator
  // pill can slide to it, rather than each button independently flipping
  // its own background — this is the whole difference between "two
  // buttons that change color" and "one continuous piece of UI moving."
  const tabListRef = useRef(null)
  const tabButtonRefs = useRef({})
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false })
  const [indicatorTransitionsEnabled, setIndicatorTransitionsEnabled] = useState(false)

  const recalcIndicator = useCallback(() => {
    const listEl = tabListRef.current
    const activeEl = tabButtonRefs.current[tab]
    if (!listEl || !activeEl) return
    const listRect = listEl.getBoundingClientRect()
    const elRect = activeEl.getBoundingClientRect()
    setIndicator({ left: elRect.left - listRect.left, width: elRect.width, ready: true })
  }, [tab])

  // Computed synchronously before paint so the very first placement
  // never visibly animates in from the wrong spot; transitions are only
  // switched on one frame later, so every subsequent tab change slides.
  useLayoutEffect(() => {
    recalcIndicator()
  }, [recalcIndicator])

  useEffect(() => {
    const id = requestAnimationFrame(() => setIndicatorTransitionsEnabled(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    window.addEventListener('resize', recalcIndicator)
    return () => window.removeEventListener('resize', recalcIndicator)
  }, [recalcIndicator])

  if (profileLoading) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-ink-400">
        <Loader2 className="h-5 w-5 animate-spin text-ink-300" />
        <p className="text-sm">Loading…</p>
      </div>
    )
  }
  if (!authorized) {
    return <AccessDenied />
  }

  return (
    <div>
      {/* prefers-reduced-motion turns both transitions below into hard
          cuts — the indicator/panel still end up in the right place,
          just without the motion in between. */}
      <style>{`
        .tab-indicator-transition { transition: left 220ms cubic-bezier(0.4, 0, 0.2, 1), width 220ms cubic-bezier(0.4, 0, 0.2, 1); }
        .tab-panel-fade { transition: opacity 200ms ease, transform 200ms ease; }
        @media (prefers-reduced-motion: reduce) {
          .tab-indicator-transition { transition: none !important; }
          .tab-panel-fade { transition: none !important; }
        }
      `}</style>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-dashed border-ink-100 pb-4">
        <div ref={tabListRef} role="tablist" className="relative flex items-center gap-1 rounded-lg border border-ink-100 bg-ink-50/60 p-1 shadow-sm">
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-y-1 rounded-md bg-white shadow-sm ring-1 ring-ink-100',
              indicatorTransitionsEnabled && 'tab-indicator-transition'
            )}
            style={{ left: indicator.left, width: indicator.width, opacity: indicator.ready ? 1 : 0 }}
          />
          {TAB_CONFIG.map(({ key, label, icon: Icon }) => {
            const meta = metaByTab[key]
            const isActive = tab === key
            const flashing = flashByTab[key]
            return (
              <button
                key={key}
                ref={(el) => {
                  if (el) tabButtonRefs.current[key] = el
                  else delete tabButtonRefs.current[key]
                }}
                role="tab"
                aria-selected={isActive}
                onClick={() => setTab(key)}
                className={cn(
                  'relative z-10 flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors',
                  isActive ? 'text-ink-900' : 'text-ink-500 hover:text-ink-700'
                )}
              >
                <Icon className={cn('h-4 w-4', isActive ? 'text-ledger-stampDark' : 'text-ink-300')} />
                {label}
                {meta.count > 0 && (
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition-transform',
                      isActive ? 'bg-ledger-stamp/15 text-ledger-stampDark' : 'bg-ink-200 text-ink-600',
                      flashing && 'scale-110'
                    )}
                  >
                    {meta.count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <button
          onClick={bumpRefresh}
          className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50"
          title="Refresh both tabs"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshPulsing && 'animate-spin')} />
          Refresh all
        </button>
      </div>

      {/* Both tabs stay mounted after first activation — hidden via CSS,
          never unmounted — so filters/search/pagination survive a tab
          switch. `active` tells each tab whether it's the one currently
          visible, so the hidden one can pause its own polling/realtime
          subscriptions rather than working for nobody. */}
      <TabPanel active={tab === 'pickup'}>
        <PickupApprovalsTab active={tab === 'pickup'} refreshToken={refreshToken} onSynced={onPickupSynced} />
      </TabPanel>

      <TabPanel active={tab === 'stale'}>
        {staleActivated && (
          <TabErrorBoundary>
            <Suspense fallback={<TabLoadingSkeleton />}>
              <ApproverStaleReportsTab active={tab === 'stale'} refreshToken={refreshToken} onSynced={onStaleSynced} />
            </Suspense>
          </TabErrorBoundary>
        )}
      </TabPanel>
    </div>
  )
}
