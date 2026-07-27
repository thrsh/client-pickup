import React, { useEffect, useRef, useState } from 'react'
import {
  Search,
  X,
  Package,
  MapPin,
  ArrowRight,
  Clock,
  Navigation,
  Frown,
  Sparkles,
  Landmark,
  Building2,
  ExternalLink,
  Route,
  Phone,
  Copy,
  Check,
  FileCheck,
  FileSignature,
  CreditCard,
  Map as MapIcon,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Input } from '../components/ui/input'

const SUGGESTION_MIN_CHARS = 3
const BANKS = [
  'BDO Unibank',
  'Bank of the Philippine Islands (BPI)',
  'Metrobank',
  'Land Bank of the Philippines',
  'Philippine National Bank (PNB)',
  'China Banking Corporation (Chinabank)',
  'Rizal Commercial Banking Corporation (RCBC)',
  'Security Bank',
  'UnionBank of the Philippines',
  'EastWest Bank',
  'Philippine Savings Bank (PSBank)',
]

// ---------------------------------------------------------------------------
// Branch / pickup-location configuration
// ---------------------------------------------------------------------------
// Matches the `pickup_branch` column on public.checks.
const BRANCH_FIELD = 'pickup_branch'

// Central registry of every pickup office. Adding a 3rd branch later means
// adding one more entry here — nothing else in the component needs to change.
// Generic, branch-agnostic checklist. Kept separate from OFFICES since this
// is standard pickup policy rather than a per-branch fact — confirm the
// exact wording with CSBA's ops/compliance team before treating it as final.
const PICKUP_REQUIREMENTS = [
  {
    icon: 'id',
    text: '1 valid government-issued ID',
    // Subtle hint of commonly-accepted ID types — confirm the exact
    // accepted list with CSBA's ops/compliance team before treating this
    // as final policy.
    examples: ["Passport", "Driver's License", 'National ID', 'Postal ID'],
  },
  { icon: 'auth', text: 'Authorization letter, if not the named payee' },
]

// Shared operating hours across branches, as provided. If a specific branch
// ever runs a different schedule, just set that office's own `hours` field
// to override this.
const OFFICE_HOURS = 'Mon–Thu 8:00 AM–7:00 PM · Fri 8:00 AM–7:30 PM'

const OFFICES = {
  'CSBA - PARQAL': {
    label: 'Parañaque Office',
    shortLabel: 'Parañaque',
    // Phone is intentionally left null (not fabricated) — fill in with a
    // confirmed number. The UI falls back to a generic "contact CSBA" line
    // whenever it's null, so it's safe to leave unset until confirmed.
    hours: OFFICE_HOURS,
    phone: null, // e.g. '+63 2 8888 0000'
    address: {
      line1: '4th Floor, Unit 407-408',
      line2: 'Kawayan Building 1, PARQAL',
      line3: 'Aseana City, D. Macapagal Ave.',
      line4: 'Brgy. Tambo, Parañaque City 1701',
    },
    lat: 14.52764285019307,
    lng: 120.9887007953413,
    // Live photographic panorama of the actual storefront/entrance — tied to
    // a specific panorama ID, so it always shows this exact spot.
    streetViewSrc:
      'https://www.google.com/maps/embed?pb=!4v1784790445760!6m8!1m7!1stp6zRb466QqO5055aEP0OQ!2m2!1d14.52764285019307!2d120.9887007953413!3f180.6539755155262!4f0.671128233677635!5f0.4000000000000002',
    placeId: null,
  },
  'CSBA - BGC': {
    label: 'Taguig Office',
    shortLabel: 'BGC, Taguig',
    hours: OFFICE_HOURS,
    phone: null,
    address: {
      line1: 'Bonifacio Technology Center',
      line2: '31st Street cor 2nd Avenue',
      line3: 'Bonifacio Global City',
      line4: 'Taguig, 1634',
    },
    // Verified via Google Places (place_id: ChIJnU0t-PnIlzMRraT9qk8Vp2s) —
    // this is Google's own coordinate for the Bonifacio Technology Center
    // building itself, not an eyeballed estimate.
    lat: 14.5547443,
    lng: 121.0444729,
    placeId: 'ChIJnU0t-PnIlzMRraT9qk8Vp2s',
    // No hand-curated panorama (heading/pitch/fov aimed at the entrance) has
    // been captured for this branch yet. Leaving this unset is safe: getStreetViewSrc()
    // below auto-derives a Street View embed from lat/lng, so the tab still
    // works today. Once someone grabs a proper embed code from Google Maps
    // (Share > Embed a map > Street View, aimed at the actual entrance),
    // paste its `pb=...` URL here for a sharper, pre-aimed shot — same
    // format as the Parañaque entry.
    streetViewSrc: null,
  },
}

// Builds a coordinate-pinned map (not an address-text search) so there is
// exactly one marker at the exact building, with no other nearby places
// competing for a pin — reused for both the embed and the directions link.
function getMapSrc(office) {
  return `https://www.google.com/maps?q=${office.lat},${office.lng}&z=19&output=embed`
}
function getDirectionsUrl(office) {
  return `https://www.google.com/maps/dir/?api=1&destination=${office.lat},${office.lng}`
}

// Resolves the Street View embed for an office:
// 1. A hand-curated `streetViewSrc` (specific panorama + heading/pitch/fov,
//    aimed at the entrance) always wins when present — highest precision.
// 2. Otherwise, auto-derive one directly from the office's lat/lng using
//    Google's no-API-key "svembed" endpoint. Google resolves this to
//    whichever real panorama is nearest those coordinates, so it degrades
//    gracefully instead of showing nothing — no manual pano-hunting required
//    to onboard a new branch.
// Returns null only if the office has no coordinates at all, so callers can
// safely hide the tab in that (should-never-happen) case.
function getStreetViewSrc(office) {
  if (office.streetViewSrc) return office.streetViewSrc
  if (office.lat == null || office.lng == null) return null
  return `https://www.google.com/maps?layer=c&cbll=${office.lat},${office.lng}&cbp=12,0,,0,0&output=svembed`
}

const DEFAULT_BRANCH_KEY = Object.keys(OFFICES)[0]

export default function PublicSearch() {
  const [bank, setBank] = useState('')

  const [payeeQuery, setPayeeQuery] = useState('')
  const [payorQuery, setPayorQuery] = useState('')
  const [matchedCount, setMatchedCount] = useState(0)
  // Per-branch counts for the current query, e.g. { 'CSBA - PARQAL': 3, 'CSBA - BGC': 1 }
  const [branchCounts, setBranchCounts] = useState({})
  const [loading, setLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const [payeeSuggestions, setPayeeSuggestions] = useState([])
  const [showPayeeSuggestions, setShowPayeeSuggestions] = useState(false)
  const payeeBoxRef = useRef(null)

  const [payorSuggestions, setPayorSuggestions] = useState([])
  const [showPayorSuggestions, setShowPayorSuggestions] = useState(false)
  const payorBoxRef = useRef(null)

  // Guards against out-of-order responses: if the user fires a second search
  // before the first one's Supabase round-trip resolves, only the response
  // matching the *latest* request id is allowed to update state. Without
  // this, a slow earlier request can resolve after a faster later one and
  // silently overwrite correct results (and correct branch/location
  // breakdown) with stale data.
  const requestIdRef = useRef(0)

  // Live suggestions effects
  useEffect(() => {
    const term = payeeQuery.trim()
    if (!term) {
      setPayeeSuggestions([])
      setShowPayeeSuggestions(false)
      return
    }
    const handle = setTimeout(() => fetchSuggestions('payee', term), 200)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payeeQuery, bank])

  useEffect(() => {
    const term = payorQuery.trim()
    if (!term) {
      setPayorSuggestions([])
      setShowPayorSuggestions(false)
      return
    }
    const handle = setTimeout(() => fetchSuggestions('payor', term), 200)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payorQuery, bank])

  useEffect(() => {
    function handleClickOutside(e) {
      if (payeeBoxRef.current && !payeeBoxRef.current.contains(e.target)) {
        setShowPayeeSuggestions(false)
      }
      if (payorBoxRef.current && !payorBoxRef.current.contains(e.target)) {
        setShowPayorSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Search logic and Supabase queries
  function buildBaseQuery(bankValue, payee, payor) {
    let req = supabase
      .from('checks')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'available')
      .eq('bank', bankValue)

    // Both fields use the same partial, case-insensitive matching strategy.
    // (Previously payor used an exact match with no wildcards — a single
    // missing middle name or extra space meant a real match, including one
    // split across two branches, would silently come back as zero results.)
    if (payee) req = req.ilike('payee', `%${payee}%`)
    if (payor) req = req.ilike('payor', `%${payor}%`)

    return req
  }

  async function fetchMatchCount(bankTerm, payeeTerm, payorTerm) {
    const bankValue = bankTerm.trim()
    const payee = payeeTerm.trim()
    const payor = payorTerm.trim()

    if (!bankValue || !payee || !payor) {
      setMatchedCount(0)
      setBranchCounts({})
      setLoading(false)
      return
    }

    const thisRequestId = ++requestIdRef.current
    setLoading(true)

    try {
      // Total count across all branches, plus a per-branch breakdown fired
      // in parallel — one lightweight head-count query per known office.
      const branchKeys = Object.keys(OFFICES)
      const [totalResult, ...branchResults] = await Promise.all([
        buildBaseQuery(bankValue, payee, payor),
        ...branchKeys.map((key) =>
          buildBaseQuery(bankValue, payee, payor).eq(BRANCH_FIELD, key)
        ),
      ])

      // A newer search has since been kicked off — drop this result rather
      // than let it clobber the more recent one.
      if (thisRequestId !== requestIdRef.current) return

      if (totalResult.error) throw totalResult.error

      const nextBranchCounts = {}
      branchKeys.forEach((key, idx) => {
        const result = branchResults[idx]
        if (!result.error) {
          nextBranchCounts[key] = result.count || 0
        }
      })

      setMatchedCount(totalResult.count || 0)
      setBranchCounts(nextBranchCounts)
    } catch (err) {
      if (thisRequestId !== requestIdRef.current) return
      console.error('Failed to fetch check matches:', err)
      setMatchedCount(0)
      setBranchCounts({})
    } finally {
      if (thisRequestId === requestIdRef.current) {
        setLoading(false)
      }
    }
  }

  async function fetchSuggestions(field, term) {
    const lowerTerm = term.toLowerCase()
    if (lowerTerm.length < SUGGESTION_MIN_CHARS) {
      if (field === 'payee') {
        setPayeeSuggestions([])
        setShowPayeeSuggestions(false)
      } else {
        setPayorSuggestions([])
        setShowPayorSuggestions(false)
      }
      return
    }

    let req = supabase
      .from('checks')
      .select(field)
      .eq('status', 'available')
      .ilike(field, `%${lowerTerm}%`)
      .limit(20)

    // Scope suggestions to the selected bank once one is chosen, so the
    // dropdown only ever offers names that will actually return results.
    if (bank.trim()) req = req.eq('bank', bank.trim())

    const { data, error } = await req

    if (!error) {
      const distinctNames = [...new Set((data || []).map((r) => r[field]))].slice(0, 6)
      if (field === 'payee') {
        setPayeeSuggestions(distinctNames)
        setShowPayeeSuggestions(distinctNames.length > 0)
      } else {
        setPayorSuggestions(distinctNames)
        setShowPayorSuggestions(distinctNames.length > 0)
      }
    }
  }

  function handleSearch() {
    if (!bank.trim() || !payeeQuery.trim() || !payorQuery.trim()) return
    setShowPayeeSuggestions(false)
    setShowPayorSuggestions(false)
    setHasSearched(true)
    fetchMatchCount(bank, payeeQuery, payorQuery)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSearch()
    }
  }

  function selectPayeeSuggestion(name) {
    setPayeeQuery(name)
    setShowPayeeSuggestions(false)
  }

  function selectPayorSuggestion(name) {
    setPayorQuery(name)
    setShowPayorSuggestions(false)
  }

  function clearAll() {
    setBank('')
    setPayeeQuery('')
    setPayorQuery('')
    setPayeeSuggestions([])
    setPayorSuggestions([])
    setShowPayeeSuggestions(false)
    setShowPayorSuggestions(false)
    setMatchedCount(0)
    setBranchCounts({})
    setHasSearched(false)
  }

  const hasQueryText = !!(bank.trim() && payeeQuery.trim() && payorQuery.trim())

  return (
    <div className="psp-page rider-app min-h-screen pb-20 relative overflow-hidden">
      <PageStyles />
      <BackgroundGeometry />

      <div className="relative z-10">
        <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6 sm:pt-10">
          <Hero />

          {/* Symmetrical Floating Rider Search Dock */}
          <div className="relative z-20 -mt-8 mb-10 mx-auto max-w-4xl rounded-2xl bg-white p-2 shadow-[0_12px_36px_rgba(13,148,136,0.14)] ring-1 ring-slate-100 sm:-mt-12">
            <div className="rounded-xl bg-slate-50 p-6 sm:p-8">
              <div className="mb-6">
                <label className="mb-2 block text-center text-[12px] font-semibold uppercase tracking-wide text-[var(--ink)]/55">
                  Bank
                </label>
                <div className="relative group mx-auto max-w-md">
                  <Landmark className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-[var(--brand)]" />
                  <select
                    value={bank}
                    onChange={(e) => setBank(e.target.value)}
                    aria-label="Select bank"
                    className="h-14 w-full appearance-none rounded-xl border border-slate-200 bg-white pl-12 pr-10 text-base font-medium text-[var(--ink)] shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:border-[var(--brand)]"
                  >
                    <option value="">Select a bank...</option>
                    {BANKS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <ArrowRight className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-slate-400" />
                </div>
              </div>

              <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
                <div ref={payeeBoxRef} className="relative flex-1">
                  <label className="mb-2 block text-center text-[12px] font-semibold uppercase tracking-wide text-[var(--ink)]/55">
                    Payee
                  </label>
                  <div className="relative group">
                    <MapPin className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-[var(--brand)]" />
                    <Input
                      value={payeeQuery}
                      onChange={(e) => setPayeeQuery(e.target.value)}
                      onKeyDown={handleKeyDown}
                      onFocus={() => payeeSuggestions.length > 0 && setShowPayeeSuggestions(true)}
                      placeholder="Enter payee..."
                      className="h-14 w-full rounded-xl border-slate-200 bg-white pl-12 pr-10 text-base shadow-sm transition-all focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:border-[var(--brand)]"
                      aria-label="Search by payee"
                      autoComplete="off"
                    />
                    {payeeQuery && (
                      <button
                        onClick={() => {
                          setPayeeQuery('')
                          setPayeeSuggestions([])
                          setShowPayeeSuggestions(false)
                        }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-slate-100 p-1.5 text-slate-400 transition hover:bg-[var(--brand-light)] hover:text-[var(--brand)]"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {showPayeeSuggestions && (
                    <div className="absolute z-30 mt-2 w-full overflow-hidden rounded-xl border border-slate-100 bg-white shadow-2xl scale-in">
                      {payeeSuggestions.map((name) => (
                        <button
                          key={name}
                          onClick={() => selectPayeeSuggestion(name)}
                          className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-medium text-[var(--ink)] transition hover:bg-[var(--brand-light)] hover:text-[var(--brand)]"
                        >
                          <MapPin className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                          {name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Symmetrical divider for desktop */}
                <div className="hidden sm:flex h-12 w-px bg-slate-200 mt-8"></div>

                <div ref={payorBoxRef} className="relative flex-1">
                  <label className="mb-2 block text-center text-[12px] font-semibold uppercase tracking-wide text-[var(--ink)]/55">
                    Payor
                  </label>
                  <div className="relative group">
                    <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-[var(--brand)]" />
                    <Input
                      value={payorQuery}
                      onChange={(e) => setPayorQuery(e.target.value)}
                      onKeyDown={handleKeyDown}
                      onFocus={() => payorSuggestions.length > 0 && setShowPayorSuggestions(true)}
                      placeholder="Enter payor..."
                      className="h-14 w-full rounded-xl border-slate-200 bg-white pl-12 pr-10 text-base shadow-sm transition-all focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:border-[var(--brand)]"
                      aria-label="Search by payor"
                      autoComplete="off"
                    />
                    {payorQuery && (
                      <button
                        onClick={() => {
                          setPayorQuery('')
                          setPayorSuggestions([])
                          setShowPayorSuggestions(false)
                        }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-slate-100 p-1.5 text-slate-400 transition hover:bg-[var(--brand-light)] hover:text-[var(--brand)]"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {showPayorSuggestions && (
                    <div className="absolute z-30 mt-2 w-full overflow-hidden rounded-xl border border-slate-100 bg-white shadow-2xl scale-in">
                      {payorSuggestions.map((name) => (
                        <button
                          key={name}
                          onClick={() => selectPayorSuggestion(name)}
                          className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-medium text-[var(--ink)] transition hover:bg-[var(--brand-light)] hover:text-[var(--brand)]"
                        >
                          <Search className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                          {name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-8 flex flex-col-reverse items-center justify-center gap-3 sm:flex-row">
                {(bank || payeeQuery || payorQuery) && (
                  <button
                    onClick={clearAll}
                    className="w-full sm:w-auto rounded-xl px-6 py-4 text-sm font-semibold text-slate-500 transition hover:bg-slate-200 hover:text-[var(--ink)]"
                  >
                    Clear fields
                  </button>
                )}
                <button
                  onClick={handleSearch}
                  disabled={!hasQueryText}
                  title={!hasQueryText ? 'Select a bank and enter both payee and payor to search' : undefined}
                  className="group flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-8 py-4 text-base font-semibold text-white shadow-lg shadow-[var(--accent)]/30 transition-all hover:-translate-y-0.5 hover:bg-[var(--accent-dark)] hover:shadow-[var(--accent)]/50 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none sm:w-auto"
                >
                  View available checks
                  <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                </button>
              </div>
              {!hasQueryText && (bank || payeeQuery || payorQuery) && (
                <p className="mt-3 text-center text-xs font-medium text-slate-400">
                  Bank, payee, and payor are all required to search.
                </p>
              )}
            </div>
          </div>

          {/* Results area */}
          <div className="mx-auto max-w-4xl relative z-10 pb-16">
            {!hasQueryText ? (
              <PromptState />
            ) : (
              <ManifestCountCard
                loading={loading}
                count={matchedCount}
                branchCounts={branchCounts}
                bank={bank}
                payee={payeeQuery}
                payor={payorQuery}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------- */
/* Presentational Components                                              */
/* ---------------------------------------------------------------------- */

function PageStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Manrope:wght@700;800&display=swap');

      :root {
        --paper: #f8fafc;
        --ink: #334155;          /* Modern Gray */
        --ink-dark: #0f172a;     /* Deep Gray/Black */
        --brand: #0d9488;        /* Teal */
        --brand-dark: #0f766e;
        --brand-light: #ccfbf1;  /* Light Teal */
        --accent: #f97316;       /* Orange */
        --accent-dark: #ea580c;
        --accent-soft: #ffedd5;

        --font-body: 'Inter', system-ui, sans-serif;
        --font-display: 'Manrope', 'Inter', system-ui, sans-serif;
      }

      .rider-app {
        font-family: var(--font-body);
        background-color: var(--paper);
        color: var(--ink);
        -webkit-font-smoothing: antialiased;
      }

      .rider-app .font-display {
        font-family: var(--font-display);
        letter-spacing: -0.015em;
      }

      @media (prefers-reduced-motion: no-preference) {
        .slide-up { animation: slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
        @keyframes slideUp {
          from { transform: translateY(40px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        .scale-in { animation: scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes scaleIn {
          from { transform: scale(0.95); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }

        .animate-float { animation: float 6s ease-in-out infinite; }
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
      }

      .dot-pattern {
        background-image: radial-gradient(var(--brand-light) 2px, transparent 2px);
        background-size: 24px 24px;
      }
      .dot-pattern-gray {
        background-image: radial-gradient(#e2e8f0 2px, transparent 2px);
        background-size: 24px 24px;
      }

      .map-frame-wrap {
        aspect-ratio: 16 / 9;
      }
      @media (min-width: 640px) {
        .map-frame-wrap { aspect-ratio: 21 / 9; }
      }
    `}</style>
  )
}

function BackgroundGeometry() {
  return (
    <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
      <svg
        className="absolute top-0 left-0 w-full h-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <polygon points="0,0 40,0 0,60" fill="var(--brand-light)" opacity="0.3" />
        <polygon points="100,0 100,30 70,0" fill="var(--accent-soft)" opacity="0.5" />
        <polygon points="0,100 30,100 0,70" fill="#e2e8f0" opacity="0.4" />
        <polygon points="100,100 60,100 100,50" fill="var(--brand-light)" opacity="0.2" />

        <polygon points="15,20 20,30 10,30" fill="var(--brand)" opacity="0.05" />
        <polygon points="85,40 90,30 80,30" fill="var(--accent)" opacity="0.05" />
        <polygon points="20,80 25,70 15,70" fill="var(--ink)" opacity="0.04" />
        <polygon points="75,85 85,95 65,95" fill="var(--brand)" opacity="0.05" />
      </svg>
    </div>
  )
}

function Hero() {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[var(--brand)] to-[var(--brand-dark)] text-white shadow-xl">
      <div className="dot-pattern absolute inset-0 opacity-20"></div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center h-full">
        <div className="relative z-10 flex flex-col justify-center px-6 pb-14 pt-12 sm:px-12 sm:pb-20 sm:pt-16 md:pr-0">
          <div className="mb-6 inline-flex self-start items-center gap-2 rounded-full bg-[var(--brand-light)]/20 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--brand-light)] backdrop-blur-md border border-[var(--brand-light)]/30">
            Credit Solutions & Business Alliances, Inc.
          </div>
          <h1 className="font-display text-4xl font-extrabold leading-tight sm:text-5xl lg:text-6xl">
            Scan &amp; Collect
            <br />
            <span className="text-[var(--accent)]">Checks</span>
          </h1>
          <p className="mt-6 max-w-sm text-base font-medium leading-relaxed text-[var(--brand-light)]">
            Enter the details below to instantly scan the depot for ready packages. No login required.
          </p>
        </div>

        <RouteGraphic />
      </div>
    </div>
  )
}

function RouteGraphic() {
  return (
    <div className="relative hidden h-full w-full items-center justify-center overflow-hidden md:flex">
      <div className="absolute inset-0 flex items-center justify-center opacity-40">
        <div className="h-84 w-84 rounded-full bg-[var(--brand-light)]/40 blur-3xl"></div>
      </div>

      <img
        src="https://csba.ph/logo.png"
        alt=""
        aria-hidden="true"
        className="absolute object-contain opacity-25 blur-[0.5px]"
        style={{
          filter: 'brightness(0) invert(1)',
          width: '65vw',
          height: '65vw',
          maxWidth: 'none',
          transform: 'translate(42%, -2%)',
        }}
      />
    </div>
  )
}

function useCountUp(target, active) {
  const [value, setValue] = useState(0)
  const fromRef = useRef(0)

  useEffect(() => {
    if (!active) return
    const from = fromRef.current
    const to = target
    if (from === to) {
      setValue(to)
      return
    }

    const duration = 800
    const start = performance.now()
    let frame

    function tick(now) {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(Math.round(from + (to - from) * eased))
      if (progress < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        fromRef.current = to
      }
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, active])

  return value
}

// Builds a plain-text pickup summary and copies it to the clipboard, with a
// brief "Copied!" confirmation state — no external toast library needed.
function useCopySummary(text) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      console.error('Clipboard write failed:', err)
      return
    }
    setCopied(true)
    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => () => clearTimeout(timeoutRef.current), [])

  return { copied, copy }
}

function ManifestCountCard({ loading, count, branchCounts, bank, payee, payor }) {
  const displayCount = useCountUp(count, !loading)

  // Which branches actually have matching checks, ranked by count — this
  // ordering drives the grid below, largest pickup first.
  const activeBranchKeys = Object.keys(OFFICES)
    .filter((key) => (branchCounts[key] || 0) > 0)
    .sort((a, b) => (branchCounts[b] || 0) - (branchCounts[a] || 0))
  const isMultiLocation = activeBranchKeys.length > 1

  // Checks matched by the query but tagged with a branch not in OFFICES
  // (e.g. new branch added to the DB before the UI was updated for it).
  const unmappedCount = Math.max(
    0,
    count - activeBranchKeys.reduce((sum, key) => sum + (branchCounts[key] || 0), 0)
  )

  const summaryText = [
    `CSBA check pickup — ${bank}`,
    `Payee: ${payee} · Payor: ${payor}`,
    `${count} check${count === 1 ? '' : 's'} ready for pickup`,
    ...activeBranchKeys.map(
      (key) => `• ${OFFICES[key].label}: ${branchCounts[key]} check${branchCounts[key] === 1 ? '' : 's'}`
    ),
  ].join('\n')
  const { copied, copy: copySummary } = useCopySummary(summaryText)

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl bg-white py-24 shadow-sm border border-slate-100">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <div className="absolute inset-0 rounded-full border-4 border-[var(--brand-light)]"></div>
          <div className="absolute inset-0 rounded-full border-4 border-[var(--brand)] border-t-transparent animate-spin"></div>
          <Search className="h-6 w-6 text-[var(--brand)]" />
        </div>
        <p className="mt-6 text-sm font-semibold text-slate-400 uppercase tracking-widest">Scanning depot...</p>
      </div>
    )
  }

  if (count === 0) {
    return (
      <div className="slide-up relative overflow-hidden flex flex-col items-center justify-center rounded-2xl bg-slate-50 py-20 text-center border border-slate-200 shadow-inner">
        <div className="dot-pattern-gray absolute inset-0 opacity-40"></div>
        <div className="relative z-10 flex flex-col items-center">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-slate-200/60 text-slate-400 border-2 border-dashed border-slate-300">
            <Frown className="h-9 w-9 text-slate-500" />
          </div>
          <h3 className="font-display text-2xl font-extrabold text-slate-700">No checks found</h3>
          <p className="mt-3 max-w-sm text-base font-medium text-slate-500">
            We searched high and low, but couldn't find anything for <span className="font-semibold text-slate-700">"{payee}"</span> and <span className="font-semibold text-slate-700">"{payor}"</span>
            {bank && (
              <>
                {' '}at <span className="font-semibold text-slate-700">{bank}</span>
              </>
            )}
            .
          </p>
          <div className="mt-6 rounded-lg bg-white px-4 py-2 text-xs font-semibold uppercase tracking-widest text-slate-400 shadow-sm border border-slate-100">
            Try double-checking spelling
          </div>
        </div>
      </div>
    )
  }

  // "Success" state: header summary + a grid of location cards. Every
  // matched branch renders side-by-side (not behind a tab), so a
  // multi-location result is fully visible without extra scrolling or
  // clicking - the grid itself *is* the multi-location feature.
  return (
    <div className="slide-up relative overflow-hidden rounded-2xl bg-white shadow-xl border border-[var(--brand-light)]">
      <div className="absolute top-0 h-1.5 w-full bg-gradient-to-r from-[var(--brand)] to-[var(--accent)]"></div>

      {/* Decorative background blobs */}
      <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-[var(--brand-light)] opacity-40 blur-3xl pointer-events-none"></div>
      <div className="absolute -right-24 top-0 h-72 w-72 rounded-full bg-[var(--accent-soft)] opacity-30 blur-3xl pointer-events-none"></div>

      {/* Compact header: count + query on the left, location quick-glance on
          the right. Side-by-side on desktop instead of stacked, so the
          location cards start much higher on the page. */}
      <div className="relative z-10 grid grid-cols-1 gap-8 border-b border-slate-100 px-6 py-8 sm:px-8 lg:grid-cols-[auto_1fr] lg:items-center lg:gap-10">
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <div className="inline-flex items-center gap-2 rounded-full bg-[var(--brand)]/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-[var(--brand-dark)]">
            <Sparkles className="h-4 w-4" /> Scan successful
          </div>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="font-display text-6xl font-extrabold tabular-nums text-[var(--brand)] sm:text-7xl">
              {displayCount}
            </span>
            <span className="font-display text-lg font-bold text-[var(--ink-dark)]">
              check{count === 1 ? '' : 's'} ready
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <Clock className="h-3.5 w-3.5" />
            Queried {new Date().toLocaleString()}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {/* Query chips - back in their original spot next to the count,
              just a size up from before: full values (no truncation),
              uppercase, readable at a glance without the full-width tiles. */}
          <div className="flex flex-col gap-2.5">
            <QueryChip icon={Landmark} label="Bank" value={bank} size="sm" full />
            <div className="grid grid-cols-2 gap-2.5">
              <QueryChip icon={MapPin} label="Payee" value={payee} full />
              <QueryChip icon={Search} label="Payor" value={payor} full />
            </div>
          </div>

          {/* Multi-location summary - lives right next to the count instead
              of a separate section the user has to scroll to reach. */}
          {isMultiLocation ? (
            <div className="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-[var(--accent-dark)]">
                <Route className="h-4 w-4 shrink-0" />
                <span className="text-sm font-bold">
                  Split across {activeBranchKeys.length} locations - visit each one below
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-500">
              <MapPin className="h-4 w-4 text-[var(--brand)]" />
              One pickup location - see details below
            </div>
          )}

          <button
            type="button"
            onClick={copySummary}
            className="inline-flex w-fit items-center gap-2 self-center rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-500 shadow-sm transition-colors hover:border-[var(--brand-light)] hover:text-[var(--brand-dark)] lg:self-start"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-[var(--brand)]" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied to clipboard' : 'Copy pickup summary'}
          </button>
        </div>
      </div>

      {/* Location grid - every matched branch, always visible side-by-side */}
      <div className="relative z-10 px-6 py-8 sm:px-8">
        {activeBranchKeys.length > 0 ? (
          <div
            className={`grid gap-6 ${
              activeBranchKeys.length === 1 ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'
            }`}
          >
            {activeBranchKeys.map((key) => (
              <LocationCard
                key={key}
                office={OFFICES[key]}
                count={branchCounts[key]}
                wide={activeBranchKeys.length === 1}
              />
            ))}
          </div>
        ) : (
          <UnmappedBranchNotice count={unmappedCount} />
        )}

        {unmappedCount > 0 && activeBranchKeys.length > 0 && (
          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-700">
            {unmappedCount} of your {count} matching {unmappedCount === 1 ? 'check is' : 'checks are'} at a branch not
            shown here - please contact CSBA for pickup details on those.
          </div>
        )}
      </div>
    </div>
  )
}

// A mid-sized query chip: bigger and bolder than the original tiny pill,
// but not as large as a full-width tile. Full value shown (wraps instead
// of truncating) and normalized to uppercase for scannability — the
// underlying value used for search/copy/logic is untouched, only the
// display is transformed.
function QueryChip({ icon: Icon, label, value, full, size = 'md' }) {
  const isSmall = size === 'sm'
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 ${
        isSmall ? 'px-3 py-1.5' : 'px-3.5 py-2'
      } ${full ? 'w-full' : ''}`}
    >
      <Icon className={`shrink-0 text-slate-400 ${isSmall ? 'h-3.5 w-3.5' : 'h-4 w-4'}`} />
      <span
        className={`shrink-0 font-semibold uppercase tracking-wide text-slate-400 ${
          isSmall ? 'text-[10px]' : 'text-[11px]'
        }`}
      >
        {label}
      </span>
      <span
        className={`min-w-0 break-words font-bold uppercase tracking-wide text-[var(--ink-dark)] ${
          isSmall ? 'text-xs' : 'text-sm'
        }`}
      >
        {value}
      </span>
    </div>
  )
}

// A single pickup location: identity + count, address, hours/phone (with a
// safe generic fallback when not yet confirmed), a standard requirements
// checklist, directions/copy actions, and an interactive map/street-view
// toggle. Used once per matched branch inside the grid above, so multiple
// locations are always visible together rather than switched between.
function LocationCard({ office, count, wide }) {
  const streetViewSrc = getStreetViewSrc(office)
  const hasStreetView = Boolean(streetViewSrc)
  const [mapView, setMapView] = useState(hasStreetView ? 'street' : 'map')
  const [addressCopied, setAddressCopied] = useState(false)

  useEffect(() => {
    if (!hasStreetView && mapView === 'street') setMapView('map')
  }, [hasStreetView, mapView])

  const mapSrc = getMapSrc(office)
  const directionsUrl = getDirectionsUrl(office)
  const fullAddress = [office.address.line1, office.address.line2, office.address.line3, office.address.line4].join(
    ', '
  )

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(fullAddress)
      setAddressCopied(true)
      setTimeout(() => setAddressCopied(false), 2000)
    } catch (err) {
      console.error('Clipboard write failed:', err)
    }
  }

  return (
    <div
      className={`relative flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ${
        wide ? 'lg:flex-row' : ''
      }`}
    >
      {/* Identity + details */}
      <div className={`flex flex-col gap-4 p-6 ${wide ? 'lg:w-[42%] lg:justify-center' : ''}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand)]/10 text-[var(--brand-dark)]">
              {/* Sourced from /public/csba-icon.png — served at the site root */}
              <img src="/csba-icon.png" alt="CSBA" className="h-5 w-5 object-contain" />
            </span>
            <div>
              <h3 className="font-display text-lg font-extrabold leading-tight text-[var(--ink-dark)]">
                {office.label}
              </h3>
              <p className="text-xs font-medium text-slate-400">CSBA branch office</p>
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-[var(--brand)] px-3 py-1 text-sm font-bold tabular-nums text-white shadow-sm">
            {count} check{count === 1 ? '' : 's'}
          </span>
        </div>

        <p className="text-sm font-medium leading-relaxed text-slate-600">{fullAddress}</p>

        <div className="flex flex-wrap gap-4 text-xs font-semibold text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-[var(--brand)]" />
            {office.hours || 'Contact CSBA for hours'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5 text-[var(--brand)]" />
            {office.phone || 'Contact CSBA for phone support'}
          </span>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <FileCheck className="h-3.5 w-3.5" /> What to bring
          </p>
          <ul className="flex flex-col gap-2.5">
            {PICKUP_REQUIREMENTS.map((req) => {
              const ReqIcon = req.icon === 'id' ? CreditCard : FileSignature
              return (
                <li key={req.text} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
                    <ReqIcon className="h-3.5 w-3.5 shrink-0 text-[var(--brand-dark)]" />
                    {req.text}
                  </div>
                  {/* Subtle hint: accepted ID types, tucked under the main
                      line rather than as separate checklist rows */}
                  {req.examples && (
                    <p className="pl-[1.375rem] text-[11px] font-medium text-slate-400">
                      {req.examples.join(' · ')}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={directionsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group/btn inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white shadow-md shadow-[var(--accent)]/30 transition-all hover:-translate-y-0.5 hover:bg-[var(--accent-dark)] hover:shadow-[var(--accent)]/50"
          >
            <Navigation className="h-4 w-4" />
            Get directions
            <ExternalLink className="h-3.5 w-3.5 opacity-70 transition-transform group-hover/btn:translate-x-0.5" />
          </a>
          <button
            type="button"
            onClick={copyAddress}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-500 transition-colors hover:border-[var(--brand-light)] hover:text-[var(--brand-dark)]"
          >
            {addressCopied ? <Check className="h-4 w-4 text-[var(--brand)]" /> : <Copy className="h-4 w-4" />}
            {addressCopied ? 'Copied' : 'Copy address'}
          </button>
        </div>
      </div>

      {/* Interactive map / street view */}
      <div className={`flex flex-col p-6 pt-0 ${wide ? 'lg:w-[58%] lg:justify-center lg:pt-6' : ''}`}>
        <div className="mb-3 inline-flex w-fit rounded-lg bg-slate-100 p-1">
          {hasStreetView && (
            <button
              type="button"
              onClick={() => setMapView('street')}
              aria-pressed={mapView === 'street'}
              className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                mapView === 'street'
                  ? 'bg-white text-[var(--brand-dark)] shadow-sm'
                  : 'text-slate-500 hover:text-[var(--ink)]'
              }`}
            >
              <Navigation className="h-3 w-3" /> Street
            </button>
          )}
          <button
            type="button"
            onClick={() => setMapView('map')}
            aria-pressed={mapView === 'map'}
            className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              mapView === 'map'
                ? 'bg-white text-[var(--brand-dark)] shadow-sm'
                : 'text-slate-500 hover:text-[var(--ink)]'
            }`}
          >
            <MapIcon className="h-3 w-3" /> Map
          </button>
        </div>

        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-slate-200 shadow-md sm:aspect-[16/10]">
          <iframe
            key={`${office.label}-${mapView}`}
            title={mapView === 'street' ? `Street view of CSBA ${office.label}` : `Map location of CSBA ${office.label}`}
            src={mapView === 'street' ? streetViewSrc : mapSrc}
            className="absolute inset-0 h-full w-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
          />
          <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-black/5"></div>
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-[11px] font-semibold text-[var(--brand-dark)] shadow-sm backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand)] opacity-60"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand)]"></span>
            </span>
            {mapView === 'street' ? 'Actual building' : 'Exact pin, no clutter'}
          </div>
        </div>
      </div>
    </div>
  )
}

function UnmappedBranchNotice({ count }) {
  return (
    <div className="relative z-10 flex flex-col items-center gap-3 px-6 py-12 text-center sm:px-8">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-500 border border-amber-200">
        <Building2 className="h-6 w-6" />
      </div>
      <p className="max-w-sm text-sm font-medium text-slate-500">
        {count} matching {count === 1 ? 'check is' : 'checks are'} held at a branch we don't have pickup details for
        yet. Please contact CSBA directly to arrange collection.
      </p>
    </div>
  )
}

function PromptState() {
  return (
    <div className="slide-up flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-white px-6 py-24 text-center shadow-sm">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--brand-light)]/50 border border-[var(--brand-light)]">
        <Navigation className="h-9 w-9 text-[var(--brand)]" />
      </div>
      <h3 className="font-display text-2xl font-extrabold text-[var(--ink-dark)]">Ready to scan</h3>
      <p className="mt-3 max-w-sm text-base font-medium text-slate-500">
        Select a bank and enter the payee and payor details above to locate items available for pickup at the depot.
      </p>
    </div>
  )
}