import React, { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  ScrollText,
  FileBarChart2,
  Menu,
  X,
  ShieldCheck,
  ChevronsLeft,
  ChevronsRight,
  ChevronRight,
  UserCog,
} from 'lucide-react'

const NAV_ITEMS = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/audit', label: 'Activity logs', icon: ScrollText },
  { to: '/admin/users', label: 'Manage users', icon: Users },
  { to: '/admin/reports', label: 'Reports', icon: FileBarChart2 },
  { to: '/admin/account', label: 'Account', icon: UserCog },
]

const PAGE_TITLES = {
  '/admin': 'Dashboard',
  '/admin/audit': 'Activity logs',
  '/admin/users': 'Manage users',
  '/admin/reports': 'Reports',
  '/admin/account': 'Account',
}

const SIDEBAR_STORAGE_KEY = 'admin.sidebar.collapsed'

// ----------------------------------------------------------------------------
// Shared layout tokens. Exported so every admin page (Dashboard, Audit,
// Users, Reports, ...) pulls width/spacing/offset from this ONE place
// instead of each page hand-rolling its own container and risking drift.
// ----------------------------------------------------------------------------

// Your top navbar (email + sign-out) lives outside this component tree and
// is fixed/sticky, so it takes no space in normal document flow. Rather
// than hardcoding its height (which drifts out of sync with the real DOM
// and gets visibly wrong at different browser zoom levels), we measure the
// actual element at #app-topbar at runtime via useTopbarHeight() below and
// expose it as the --admin-topbar-h CSS variable. This constant is only a
// fallback for the brief window before that element is found (or if it's
// ever missing), so the layout never collapses to 0.
export const TOPBAR_HEIGHT_FALLBACK_PX = 64

// Sidebar width, expanded vs collapsed (rail). Previously this same pair of
// numbers was duplicated as separate Tailwind literals in two places — the
// sidebar's own `w-64`/`w-[72px]` and the content wrapper's matching
// `sm:pl-64`/`sm:pl-[72px]` — with nothing enforcing that they stayed
// equal. They usually did, but the two are computed independently, and any
// mismatch (a future edit to one and not the other, or the two Tailwind
// classes resolving from slightly different code paths at exactly 100%
// zoom) shows up as content rendering underneath the sidebar instead of
// beside it. Defining the widths once here and driving both the sidebar
// and the content offset from the same --admin-sidebar-w CSS variable
// (see AdminLayout below) makes that class of mismatch impossible instead
// of just unlikely.
export const SIDEBAR_WIDTH_EXPANDED_PX = 256 // matches w-64
export const SIDEBAR_WIDTH_COLLAPSED_PX = 72 // matches w-[72px]

/**
 * Measures the real height of the app's top navbar (`#app-topbar`) and
 * keeps that measurement live via ResizeObserver, so sidebar/content
 * offsets always match the actual rendered navbar — regardless of browser
 * zoom, font-size settings, responsive navbar wrapping, or future navbar
 * redesigns. Falls back to `fallbackPx` until the element is found.
 *
 * Height is rounded UP to the nearest whole CSS pixel (Math.ceil) before
 * being stored. `getBoundingClientRect().height` returns a fractional
 * value (e.g. 82.6px), and browsers only render that fraction crisply at
 * zoom levels where a CSS pixel maps cleanly to a device pixel — most
 * commonly exactly 100% zoom. At 100% you'd see a hairline gap or overlap
 * between the navbar and the sidebar/content below it; at other zoom
 * levels the browser's own scaling pass tends to blur that same fraction
 * away, which is why the layout can look "perfect" at, say, 90% and
 * subtly broken at 100% — it was never actually pixel-exact, one zoom
 * level just happened to hide the rounding error. Ceiling removes the
 * fraction at the source so the offset is exact at every zoom level.
 */
function useTopbarHeight(fallbackPx) {
  const [height, setHeight] = useState(fallbackPx)

  useEffect(() => {
    let observer
    let pollId
    let cancelled = false
    let detachResizeListener

    function attach(el) {
      if (!el || cancelled) return
      const update = () => setHeight(Math.ceil(el.getBoundingClientRect().height) || fallbackPx)
      update()
      observer = new ResizeObserver(update)
      observer.observe(el)

      // Belt-and-suspenders: browser page zoom (Ctrl/Cmd +/-) changes the
      // effective CSS-pixel viewport size, which fires a window `resize`
      // event in every major browser. The ResizeObserver above already
      // re-measures whenever #app-topbar's own box changes (e.g. its
      // h-16 -> h-20 breakpoint), but this listener re-measures
      // unconditionally too, as a fallback for edge cases (older
      // browsers, OS-level display scaling) where that isn't guaranteed.
      window.addEventListener('resize', update)
      detachResizeListener = () => window.removeEventListener('resize', update)
    }

    const existing = document.getElementById('app-topbar')
    if (existing) {
      attach(existing)
    } else {
      // The navbar can mount slightly after this layout (e.g. it's waiting
      // on auth state). Poll briefly rather than assuming it's already
      // in the DOM on first render.
      let attempts = 0
      pollId = window.setInterval(() => {
        attempts += 1
        const found = document.getElementById('app-topbar')
        if (found) {
          window.clearInterval(pollId)
          attach(found)
        } else if (attempts > 20) {
          window.clearInterval(pollId)
          console.warn(
            '[AdminLayout] Could not find #app-topbar in the DOM — falling back to a fixed height. ' +
              'Add id="app-topbar" to the top navbar so layout offsets stay accurate.'
          )
        }
      }, 100)
    }

    return () => {
      cancelled = true
      if (observer) observer.disconnect()
      if (pollId) window.clearInterval(pollId)
      if (detachResizeListener) detachResizeListener()
    }
  }, [fallbackPx])

  return height
}

// Capped (rather than full-bleed) so table rows and cards stay readable on
// ultrawide monitors instead of stretching edge to edge, while still using
// nearly the full width on laptop/desktop screens.
export const CONTENT_MAX_WIDTH_CLASS = 'max-w-[1600px]'

// Responsive horizontal/vertical rhythm for the page container. `min-w-0`
// is load-bearing: without it, a wide table or chart inside a flex/grid
// ancestor can force the whole page to overflow horizontally on narrow
// viewports instead of scrolling internally or wrapping.
export const PAGE_CONTAINER_CLASS = `mx-auto w-full min-w-0 ${CONTENT_MAX_WIDTH_CLASS} px-4 py-5 sm:px-6 sm:py-6 lg:px-8`

// Reusable KPI-grid column steps, tuned to avoid awkward uneven last rows.
// 2 → 4 (not 2 → 3 → 4) means 4- and 8-card sections always land on full
// rows instead of stranding 1-2 cards alone at the "sm" breakpoint.
//
// Single source of truth: AdminDashboard.jsx (and any other admin page
// using KPI cards) imports these from here instead of redefining them —
// two copies of the same class string is exactly how they end up
// silently drifting apart the next time either one is tuned.
export const KPI_GRID_CLASS = 'grid grid-cols-2 gap-2.5 min-[480px]:gap-3 md:grid-cols-4 md:gap-3'
export const KPI_GRID_2COL_CLASS = 'grid grid-cols-2 gap-2.5 min-[480px]:gap-3'

function readStoredCollapsed() {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'
  } catch {
    // Storage may be unavailable (private browsing, disabled cookies) —
    // fall back to expanded rather than throwing.
    return false
  }
}

// ----------------------------------------------------------------------------
// Sidebar nav link — handles both expanded (icon + label) and collapsed
// (icon only, with a hover tooltip so the destination is never a guess).
// ----------------------------------------------------------------------------

function SidebarLink({ to, label, icon: Icon, end, collapsed, onNavigate }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `group relative flex items-center rounded-lg text-sm font-medium transition-colors ${
          collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5'
        } ${
          isActive
            ? 'bg-teal-50 text-teal-700'
            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-teal-600 transition-opacity ${
              isActive ? 'opacity-100' : 'opacity-0'
            }`}
          />
          <Icon className="h-[18px] w-[18px] flex-shrink-0" />
          {!collapsed && <span className="truncate">{label}</span>}
          {collapsed && (
            <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
              {label}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

// ----------------------------------------------------------------------------
// Desktop sidebar — fixed, collapsible between full (w-64) and rail (w-[72px])
// widths. Collapse state persists across sessions. Purely navigational: the
// account switcher / sign-out control lives in the top navbar, not here, so
// there's a single source of truth for account actions.
// Sits below the top navbar via `top: var(--admin-topbar-h)` instead of
// `inset-y-0`, so it no longer tucks underneath it.
// ----------------------------------------------------------------------------

function DesktopSidebar({ collapsed, onToggleCollapsed }) {
  return (
    <aside
      style={{ top: 'var(--admin-topbar-h)', width: 'var(--admin-sidebar-w)' }}
      className="fixed bottom-0 left-0 z-30 hidden flex-col border-r border-gray-200 bg-white transition-[width] duration-200 ease-in-out sm:flex"
    >
      {/* Brand */}
      <div className={`flex h-16 flex-shrink-0 items-center border-b border-gray-100 ${collapsed ? 'justify-center px-2' : 'gap-2.5 px-4'}`}>
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-teal-50">
          <ShieldCheck className="h-4.5 w-4.5 text-teal-600" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight text-gray-800">Admin console</p>
            <p className="truncate text-[11px] leading-tight text-gray-400">Management panel</p>
          </div>
        )}
      </div>

      {/* Nav. Extra top padding (pt-6 vs the py-4 used elsewhere) plus the
          "Admin" label give the "Dashboard" link breathing room so it's not
          flush under the brand header. The label is plain, non-interactive
          text — not a link. */}
      <nav className={`flex-1 space-y-1 overflow-y-auto pb-4 pt-6 ${collapsed ? 'px-2.5' : 'px-3'}`}>
        {!collapsed && (
          <p className="select-none px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Admin
          </p>
        )}
        {NAV_ITEMS.map((item) => (
          <SidebarLink key={item.to} {...item} collapsed={collapsed} />
        ))}
      </nav>

      {/* Footer: collapse toggle only — account info/sign-out live in the top navbar */}
      <div className={`flex-shrink-0 border-t border-gray-100 ${collapsed ? 'px-2.5 py-3' : 'px-3 py-3'}`}>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expand sidebar' : undefined}
          className={`group relative flex w-full items-center rounded-lg text-xs font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 ${
            collapsed ? 'justify-center px-0 py-2.5' : 'gap-2 px-3 py-2.5'
          }`}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          {!collapsed && 'Collapse'}
        </button>
      </div>
    </aside>
  )
}

// ----------------------------------------------------------------------------
// Mobile: top bar + slide-over drawer (sidebar pattern doesn't fit a narrow
// viewport, so mobile keeps a drawer triggered from the top bar). The bar
// sticks just below the top navbar (`top: var(--admin-topbar-h)`), not at
// the very top of the viewport, so it never slides under the navbar on scroll.
// ----------------------------------------------------------------------------

function MobileTopBar({ title, onOpenMenu }) {
  return (
    <header
      style={{ top: 'var(--admin-topbar-h)' }}
      className="sticky z-20 flex h-14 flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 sm:hidden"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-teal-50">
          <ShieldCheck className="h-4 w-4 text-teal-600" />
        </div>
        <p className="truncate text-sm font-semibold text-gray-800">{title}</p>
      </div>
      <button
        type="button"
        onClick={onOpenMenu}
        className="flex-shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>
    </header>
  )
}

function MobileDrawer({ open, onClose }) {
  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 sm:hidden ${
          open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[80vw] flex-col bg-white shadow-xl transition-transform duration-200 ease-in-out sm:hidden ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Admin navigation"
      >
        <div className="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-100 px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50">
              <ShieldCheck className="h-4.5 w-4.5 text-teal-600" />
            </div>
            <p className="text-sm font-semibold text-gray-800">Admin console</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4 pt-6">
          <p className="select-none px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Admin
          </p>
          {NAV_ITEMS.map((item) => (
            <SidebarLink key={item.to} {...item} collapsed={false} onNavigate={onClose} />
          ))}
        </nav>
      </div>
    </>
  )
}

// ----------------------------------------------------------------------------
// Shell
// ----------------------------------------------------------------------------

export default function AdminLayout() {
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readStoredCollapsed)
  const topbarHeight = useTopbarHeight(TOPBAR_HEIGHT_FALLBACK_PX)
  const sidebarWidth = collapsed ? SIDEBAR_WIDTH_COLLAPSED_PX : SIDEBAR_WIDTH_EXPANDED_PX

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
      // Storage may be unavailable (private browsing, disabled cookies) —
      // collapse state just won't persist, which is a harmless degradation.
    }
  }, [collapsed])

  // Close the mobile drawer on route change so navigating never leaves it
  // open over the new page.
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  const currentTitle =
    PAGE_TITLES[location.pathname] ||
    NAV_ITEMS.find((item) => item.to !== '/admin' && location.pathname.startsWith(item.to))?.label ||
    'Admin'

  return (
    // `overflow-x-hidden` is a safety net: fixed/sticky children and wide
    // charts/tables should never be able to push the page into a horizontal
    // scrollbar. `overflow-y-auto` is written explicitly alongside it —
    // per the CSS overflow spec, setting only overflow-x to a non-visible
    // value silently forces overflow-y to `auto` anyway, so this makes
    // that behavior intentional and documented instead of an implicit
    // side effect someone has to rediscover later.
    // `--admin-topbar-h` is set from the LIVE measured height of
    // #app-topbar (see useTopbarHeight above), rounded to a whole pixel —
    // not a guessed constant and not a fractional value — so this stays
    // pixel-exact at any browser zoom level or if the navbar's own height
    // ever changes.
    <div
      className="min-h-screen overflow-x-hidden overflow-y-auto bg-gray-50"
      style={{
        '--admin-topbar-h': `${topbarHeight}px`,
        '--admin-sidebar-w': `${sidebarWidth}px`,
     
      }}
    >
      <DesktopSidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed((v) => !v)} />
      <MobileDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} />

      {/* Content offset now reads the SAME --admin-sidebar-w variable the
          sidebar itself is sized from (see DesktopSidebar above), instead
          of a second `sm:pl-64`/`sm:pl-[72px]` literal that had to be kept
          in sync by hand. `sm:` still gates it to desktop only — the
          sidebar doesn't exist below that breakpoint, so no offset should
          apply there. */}
      <div className="flex min-h-[calc(100vh-var(--admin-topbar-h))] min-w-0 flex-col transition-[padding] duration-200 ease-in-out sm:pl-[var(--admin-sidebar-w)]">
        <MobileTopBar title={currentTitle} onOpenMenu={() => setMobileOpen(true)} />

        {/* Desktop breadcrumb bar. Your top navbar (with email/sign-out) sits
            above this whole shell, so this strip is just a page-title anchor.
            Height is pinned to h-16 to exactly match the sidebar's brand row
            (see DesktopSidebar above) — previously this used py-3.5, which
            made the bar shorter than the sidebar header next to it, leaving
            a sliver of extra white space above the text where the two
            border lines didn't line up. Same height now, so the border
            reads as one continuous line across the sidebar and content. */}
        <header className="hidden h-16 flex-shrink-0 items-center border-b border-gray-200 bg-white px-6 sm:flex">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
            <NavLink to="/admin" className="font-medium text-gray-400 transition-colors hover:text-gray-600">
              Admin
            </NavLink>
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
            <span className="font-semibold text-gray-800">{currentTitle}</span>
          </nav>
        </header>

        {/* Shared page container: every admin page renders inside this, so
            width/padding is decided once here (PAGE_CONTAINER_CLASS) instead
            of duplicated per page. `min-w-0` on this and its ancestors above
            is what lets internal content (tables, wide charts) scroll
            within itself instead of blowing out the whole viewport width. */}
        <main className="min-w-0 flex-1">
          <div className={PAGE_CONTAINER_CLASS}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}