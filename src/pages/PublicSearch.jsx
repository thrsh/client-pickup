import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Search,
  X,
  MapPin,
  ArrowRight,
  ChevronDown,
  Clock,
  Navigation,
  Frown,
  Sparkles,
  Landmark,
  Building2,
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

// Each bank's real logo, served from /public — same convention already used
// for /csba-icon.png. BankAvatar falls back to an initials chip for any
// bank without a mapped file, so adding one later is a one-line change.
const BANK_LOGOS = {
  'BDO Unibank': '/bdo_logo.png',
  'Bank of the Philippine Islands (BPI)': '/bpi_logo.png',
  Metrobank: '/metrobank_logo.png',
  'EastWest Bank': '/eastwest_logo.webp',
  'Land Bank of the Philippines': '/landbank_logo.png',
  'Philippine National Bank (PNB)': '/pnb_logo.svg',
  'China Banking Corporation (Chinabank)': '/chinabank_logo.png',
  'Rizal Commercial Banking Corporation (RCBC)': '/rcbc_logo.png',
  'Security Bank': '/securitybank_logo.png',
  'UnionBank of the Philippines': '/unionbank_logo.png',
  'Philippine Savings Bank (PSBank)': '/psbank_logo.svg',
}

function getBankLogoUrl(name) {
  return BANK_LOGOS[name] || null
}

// Short, space-efficient display names for bank breakdown chips (mobile
// cards get crowded fast with full legal names like "Rizal Commercial
// Banking Corporation (RCBC)"). Falls back to the full name for any bank
// not explicitly mapped, so adding a bank to BANKS never breaks this.
const BANK_SHORT_NAMES = {
  'BDO Unibank': 'BDO',
  'Bank of the Philippine Islands (BPI)': 'BPI',
  Metrobank: 'Metrobank',
  'Land Bank of the Philippines': 'Landbank',
  'Philippine National Bank (PNB)': 'PNB',
  'China Banking Corporation (Chinabank)': 'Chinabank',
  'Rizal Commercial Banking Corporation (RCBC)': 'RCBC',
  'Security Bank': 'Security Bank',
  'UnionBank of the Philippines': 'UnionBank',
  'EastWest Bank': 'EastWest',
  'Philippine Savings Bank (PSBank)': 'PSBank',
}

function getBankShortName(name) {
  return BANK_SHORT_NAMES[name] || name
}

// ---------------------------------------------------------------------------
// Name normalization — mirrors the SQL generated columns `payee_normalized`
// and `payor_normalized` on public.checks EXACTLY:
//   trim -> lower -> collapse every run of punctuation/whitespace to a
//   single space (never delete it — deleting fuses words when punctuation
//   touches a suffix with no space, e.g. "SOLUTIONS,INC." -> "solutionsinc")
//   -> trim (critical: must happen BEFORE the suffix strip below, or the
//   suffix regex's end anchor lands on a trailing space instead of the
//   suffix word and silently fails to strip it) -> strip one trailing
//   corporate-suffix word -> trim again.
// ---------------------------------------------------------------------------
const CORP_SUFFIX_RE = /\s+(inc|incorporated|corp|corporation|llc|ltd|limited)$/

function normalizeCompanyName(raw) {
  if (!raw) return ''
  let s = raw.trim().toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, ' ').trim() // punctuation -> space, then trim edges
  s = s.replace(CORP_SUFFIX_RE, '')
  return s.trim()
}

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
    // been captured for this branch yet. Leaving this unset is safe:
    // getStreetViewSrc() below auto-derives a Street View embed from
    // lat/lng, so the tab still works today. Once someone grabs a proper
    // embed code from Google Maps (Share > Embed a map > Street View,
    // aimed at the actual entrance), paste its `pb=...` URL here for a
    // sharper, pre-aimed shot — same format as the Parañaque entry.
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

export default function PublicSearch() {
  const [bank, setBank] = useState('')

  const [payeeQuery, setPayeeQuery] = useState('')
  const [payorQuery, setPayorQuery] = useState('')
  const [matchedCount, setMatchedCount] = useState(0)
  // Per-branch counts for the current query, e.g. { 'CSBA - PARQAL': 3, 'CSBA - BGC': 1 }
  const [branchCounts, setBranchCounts] = useState({})
  // Per-branch, per-bank counts for the current query, e.g.
  // { 'CSBA - PARQAL': { 'BDO Unibank': 2, 'Land Bank of the Philippines': 4 } }
  // Only meaningful (and only rendered) when no single bank is selected —
  // that's the "which bank did each check come from" breakdown.
  const [branchBankCounts, setBranchBankCounts] = useState({})
  const [loading, setLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
 const [matchedNames, setMatchedNames] = useState(null) // { payee, payor } from DB, or null   ← add this
  const [payeeSuggestions, setPayeeSuggestions] = useState([])
  const [showPayeeSuggestions, setShowPayeeSuggestions] = useState(false)
  const payeeBoxRef = useRef(null)
  const payeeInputRef = useRef(null)

  const [payorSuggestions, setPayorSuggestions] = useState([])
  const [showPayorSuggestions, setShowPayorSuggestions] = useState(false)
  const payorBoxRef = useRef(null)

  // Anchors used to pan the page: the search slip itself (so "Edit search"
  // can return here from the results) and the results region (so submitting
  // a search pans straight down to it, without the person having to scroll
  // manually to see what they searched for).
  const searchSectionRef = useRef(null)
  const resultsRef = useRef(null)

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

  // The moment any field changes after a search has run, that search's
  // results no longer describe the current query — so drop back out of the
  // "results shown" state immediately, before the person even finishes
  // typing. Cheap no-op once hasSearched is already false.
  useEffect(() => {
    setHasSearched(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank, payeeQuery, payorQuery])

  // ---------------------------------------------------------------------
  // Search logic and Supabase queries
  // ---------------------------------------------------------------------
  // Matches against the DB's own `payee_normalized` / `payor_normalized`
  // generated columns using an EXACT equality check — not a substring/ilike
  // search. `normalizeCompanyName` (above) reproduces the exact same
  // normalization the DB applies, so a correctly-spelled name matches
  // regardless of case, punctuation, extra whitespace, or a trailing
  // "Inc"/"Inc."/"Corp"/etc, while a genuinely different or misspelled name
  // does not — which is exactly the behavior that was requested.
  //
  // Bank is OPTIONAL: when left blank, results span every bank, and the UI
  // surfaces a per-branch bank breakdown so the person can still see where
  // each check actually came from.
  //
  // A safety cap on rows returned — plenty of headroom for legitimate
  // pickup volumes while bounding payload size/cost if a query is
  // unexpectedly broad.
  const MAX_MATCHED_ROWS = 1000

  function buildMatchQuery(bankValue, payeeNormalized, payorNormalized) {
    let req = supabase
      .from('checks')
      .select('bank, pickup_branch, payee, payor')
      .eq('status', 'available')
      .eq('payee_normalized', payeeNormalized)
      .eq('payor_normalized', payorNormalized)
      .limit(MAX_MATCHED_ROWS)

    if (bankValue) req = req.eq('bank', bankValue)

    return req
  }

  async function fetchMatchCount(bankTerm, payeeTerm, payorTerm) {
    const bankValue = bankTerm.trim() // optional — '' means "any bank"
    const payeeNormalized = normalizeCompanyName(payeeTerm)
    const payorNormalized = normalizeCompanyName(payorTerm)

    if (!payeeNormalized || !payorNormalized) {
      setMatchedCount(0)
      setBranchCounts({})
      setBranchBankCounts({})
      setMatchedNames(null)
      setLoading(false)
      return
    }

    const thisRequestId = ++requestIdRef.current
    setLoading(true)

    try {
      const { data, error } = await buildMatchQuery(bankValue, payeeNormalized, payorNormalized)

      if (thisRequestId !== requestIdRef.current) return
      if (error) throw error

      const rows = data || []

      // Group once, client-side, into both the per-branch totals and the
      // per-branch per-bank breakdown — a single round trip instead of one
      // query per branch (or per branch-and-bank combination).
      const nextBranchCounts = {}
      const nextBranchBankCounts = {}
      for (const row of rows) {
        const branchKey = row[BRANCH_FIELD]
        nextBranchCounts[branchKey] = (nextBranchCounts[branchKey] || 0) + 1

        if (!nextBranchBankCounts[branchKey]) nextBranchBankCounts[branchKey] = {}
        nextBranchBankCounts[branchKey][row.bank] = (nextBranchBankCounts[branchKey][row.bank] || 0) + 1
      }

      setMatchedCount(rows.length)
      setBranchCounts(nextBranchCounts)
      setBranchBankCounts(nextBranchBankCounts)
      // Canonical DB-stored spelling for display, falling back to the typed
      // query text below when there's no match.
      setMatchedNames(rows[0] ? { payee: rows[0].payee, payor: rows[0].payor } : null)
    } catch (err) {
      if (thisRequestId !== requestIdRef.current) return
      console.error('Failed to fetch check matches:', err)
      setMatchedCount(0)
      setBranchCounts({})
      setBranchBankCounts({})
      setMatchedNames(null)
    } finally {
      if (thisRequestId === requestIdRef.current) {
        setLoading(false)
      }
    }
  }

  async function fetchSuggestions(field, term) {
    const normalizedTerm = normalizeCompanyName(term)
    if (normalizedTerm.length < SUGGESTION_MIN_CHARS) {
      if (field === 'payee') {
        setPayeeSuggestions([])
        setShowPayeeSuggestions(false)
      } else {
        setPayorSuggestions([])
        setShowPayorSuggestions(false)
      }
      return
    }

    // Filter on the normalized column (so typing is forgiving of case,
    // punctuation, and corp suffixes, exactly like the real search above)
    // while still selecting and displaying the original, human-readable
    // value in the dropdown.
    let req = supabase
      .from('checks')
      .select(field)
      .eq('status', 'available')
      .ilike(`${field}_normalized`, `%${normalizedTerm}%`)
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
    // Bank is optional — only payee and payor are required to search.
    if (!payeeQuery.trim() || !payorQuery.trim()) return
    setShowPayeeSuggestions(false)
    setShowPayorSuggestions(false)
    setHasSearched(true)
    fetchMatchCount(bank, payeeQuery, payorQuery)

    // Pan straight down to the results the moment a search fires, so the
    // scanning state and eventual result land exactly where the person is
    // looking — no manual scrolling required. Deferred a frame so the
    // results region has already mounted/updated before we scroll to it.
    requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  // Pans back up to the search slip so refining a query feels like a single
  // continuous motion rather than a manual scroll-and-hunt.
  function scrollToSearch() {
    searchSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
  setBranchBankCounts({})
  setMatchedNames(null)
  setHasSearched(false)
  }

  // Bank is optional: only payee and payor gate whether a search can run.
  const hasQueryText = !!(payeeQuery.trim() && payorQuery.trim())
  const filledCount = [bank, payeeQuery, payorQuery].filter((v) => v.trim().length > 0).length

  return (
    <div className="psp-page rider-app min-h-screen pb-20 relative overflow-hidden">
      <PageStyles />
      <BackgroundGeometry />

      <div className="relative z-10">
        <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6 sm:pt-10">
          <Hero />

          {/* Pickup Lookup — a compact, ledger-styled search slip. Deliberately
              not another rounded glowing card: hairline dividers, numbered
              fields, and underline-style inputs read as a real intake form,
              which fits a document/check-pickup product rather than a
              consumer app. */}
          <div
            ref={searchSectionRef}
            className="relative z-20 -mt-5 mb-8 mx-auto max-w-4xl scroll-mt-6 sm:-mt-6 sm:mb-10"
          >
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {/* Fills in as each field is completed — a quiet progress cue
                  that doubles as a visible tap-target guide on small screens. */}
              <div className="flex h-[3px] w-full gap-[3px] bg-slate-100" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={`h-full flex-1 transition-colors duration-300 ${
                      i < filledCount ? 'bg-[var(--brand)]' : 'bg-transparent'
                    }`}
                  />
                ))}
              </div>

              <div className="grid grid-cols-1 divide-y divide-slate-200 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <SlipField
                  index="01"
                  icon={Landmark}
                  label="Bank"
                  filled={Boolean(bank)}
                  caption="Optional — leave blank to search every bank"
                >
                  <BankDropdown
                    value={bank}
                    options={BANKS}
                    placeholder="All banks (optional)"
                    onChange={(next) => {
                      setBank(next)
                      // Auto-advance to Payee once a bank is picked — saves a
                      // tap on mobile, but never steals focus from a field
                      // the person has already started filling in.
                      if (next && !payeeQuery) {
                        setTimeout(() => payeeInputRef.current?.focus(), 0)
                      }
                    }}
                  />
                </SlipField>

                <SlipField
                  index="02"
                  icon={MapPin}
                  label="Payee"
                  ref={payeeBoxRef}
                  filled={Boolean(payeeQuery.trim())}
                  caption="Name printed on the check"
                >
                  <div className="relative">
                    <Input
                      ref={payeeInputRef}
                      value={payeeQuery}
                      onChange={(e) => setPayeeQuery(e.target.value)}
                      onKeyDown={handleKeyDown}
                      onFocus={() => payeeSuggestions.length > 0 && setShowPayeeSuggestions(true)}
                      placeholder="Name on check"
                      className="h-auto w-full rounded-none border-0 border-b-2 border-slate-200 bg-transparent px-0 py-2 pr-6 text-[15px] font-semibold shadow-none focus-visible:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-0 sm:py-1.5 sm:text-sm"
                      aria-label="Search by payee"
                      autoComplete="off"
                    />
                    {payeeQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setPayeeQuery('')
                          setPayeeSuggestions([])
                          setShowPayeeSuggestions(false)
                        }}
                        aria-label="Clear payee"
                        className="absolute right-0 top-1/2 -translate-y-1/2 p-1 text-slate-300 transition-colors hover:text-[var(--brand)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}

                    {showPayeeSuggestions && (
                      <div className="absolute left-0 right-0 z-30 mt-2 max-h-60 overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white shadow-lg scale-in">
                        {payeeSuggestions.map((name) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => selectPayeeSuggestion(name)}
                            className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-sm font-medium text-[var(--ink)] transition hover:bg-slate-50 hover:text-[var(--brand-dark)] sm:py-2.5"
                          >
                            <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                            {name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </SlipField>

                <SlipField
                  index="03"
                  icon={Search}
                  label="Payor"
                  ref={payorBoxRef}
                  filled={Boolean(payorQuery.trim())}
                  caption="Bank or company that issued it"
                >
                  <div className="relative">
                    <Input
                      value={payorQuery}
                      onChange={(e) => setPayorQuery(e.target.value)}
                      onKeyDown={handleKeyDown}
                      onFocus={() => payorSuggestions.length > 0 && setShowPayorSuggestions(true)}
                      placeholder="Issuing party"
                      className="h-auto w-full rounded-none border-0 border-b-2 border-slate-200 bg-transparent px-0 py-2 pr-6 text-[15px] font-semibold shadow-none focus-visible:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-0 sm:py-1.5 sm:text-sm"
                      aria-label="Search by payor"
                      autoComplete="off"
                    />
                    {payorQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setPayorQuery('')
                          setPayorSuggestions([])
                          setShowPayorSuggestions(false)
                        }}
                        aria-label="Clear payor"
                        className="absolute right-0 top-1/2 -translate-y-1/2 p-1 text-slate-300 transition-colors hover:text-[var(--brand)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}

                    {showPayorSuggestions && (
                      <div className="absolute left-0 right-0 z-30 mt-2 max-h-60 overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white shadow-lg scale-in">
                        {payorSuggestions.map((name) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => selectPayorSuggestion(name)}
                            className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-sm font-medium text-[var(--ink)] transition hover:bg-slate-50 hover:text-[var(--brand-dark)] sm:py-2.5"
                          >
                            <Search className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                            {name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </SlipField>
              </div>

              <div className="flex flex-col gap-2.5 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5">
                <p className="order-2 text-center text-[11px] font-medium text-slate-400 sm:order-1 sm:text-left sm:text-xs">
                  {hasQueryText ? 'Ready — press search or hit Enter.' : `${filledCount}/3 fields filled`}
                </p>
                <div className="order-1 flex items-center gap-2 sm:order-2">
                  {(bank || payeeQuery || payorQuery) && (
                    <button
                      type="button"
                      onClick={clearAll}
                      className="shrink-0 rounded-md px-3 py-2.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-200 hover:text-[var(--ink)] sm:py-2"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleSearch}
                    disabled={!hasQueryText || loading}
                    title={!hasQueryText ? 'Enter both payee and payor to search' : undefined}
                    className="group inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-[var(--brand-dark)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 sm:flex-none sm:py-2"
                  >
                    {loading ? (
                      <>
                        <span
                          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white"
                          aria-hidden="true"
                        />
                        Searching…
                      </>
                    ) : (
                      <>
                        View available checks
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Results area */}
          <div ref={resultsRef} className="mx-auto max-w-4xl relative z-10 pb-16 scroll-mt-6">
            {!hasSearched ? (
              <PromptState ready={hasQueryText} />
            ) : (
             <ManifestCountCard
  loading={loading}
  count={matchedCount}
  branchCounts={branchCounts}
  branchBankCounts={branchBankCounts}
  bank={bank}
  payee={matchedNames?.payee || payeeQuery}
  payor={matchedNames?.payor || payorQuery}
  onEditSearch={scrollToSearch}
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

// One field of the pickup-lookup slip: a small numeric index (echoing a
// bank deposit slip's numbered fields), an icon + label row, then whatever
// control is passed in. forwardRef so the parent can attach its
// click-outside-to-close boundary directly to the field container.
const SlipField = React.forwardRef(function SlipField(
  { index, icon: Icon, label, caption, filled, children },
  ref
) {
  return (
    <div ref={ref} className="group relative flex flex-col gap-1.5 px-4 py-3.5 sm:px-5 sm:py-3">
      <div className="flex items-center gap-2">
        <span
          className={`font-mono text-[10px] transition-colors ${
            filled ? 'text-[var(--brand)]' : 'text-slate-300'
          }`}
        >
          {index}
        </span>
        <Icon
          className={`h-3.5 w-3.5 transition-colors group-focus-within:text-[var(--brand)] ${
            filled ? 'text-[var(--brand)]' : 'text-slate-400'
          }`}
        />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</span>
        {filled && (
          <svg
            key="check"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="check-draw ml-auto h-4 w-4 shrink-0 text-[var(--brand)]"
          >
            <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.5" className="check-draw-circle" />
            <path
              d="M7.5 12.5l2.8 2.8 6.2-6.2"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="check-draw-tick"
            />
          </svg>
        )}
      </div>
      {children}
      {caption && <p className="text-[10.5px] font-medium leading-snug text-slate-400">{caption}</p>}
    </div>
  )
})

// A fully custom, brand-teal listbox — not a native <select> — so the open
// panel, hover/active states, and selected indicator all carry CSBA's teal
// identity instead of falling back to the browser's plain system dropdown.
// Built as a standard "select-only combobox": focus stays on the trigger
// button at all times, keyboard interaction is driven from there, and
// `aria-activedescendant` tracks the highlighted option — the same pattern
// shadcn/Radix's Select uses under the hood.
//
// The panel itself is rendered through a portal straight into <body> and
// positioned with `position: fixed`, computed from the trigger's own
// bounding box. It deliberately does NOT live inside the search slip's DOM
// tree, because that card uses `overflow-hidden` (needed for its rounded
// corners) — any child positioned "absolute" inside it gets silently
// clipped the moment it would extend past the card's edge. Portaling is
// the standard fix (it's what Radix/shadcn's Select and Popover do under
// the hood) and also means the menu always renders above every other
// component, flips upward near the bottom of the viewport, and tracks the
// trigger correctly even while the page scrolls.
function BankDropdown({ value, options, onChange, placeholder = 'Select bank...' }) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [menuRect, setMenuRect] = useState(null)
  const containerRef = useRef(null)
  const listRef = useRef(null)
  const buttonRef = useRef(null)
  const typeaheadRef = useRef({ query: '', timeout: null })

  const selectedIndex = options.indexOf(value)
  const MENU_MAX_HEIGHT = 288 // matches max-h-72
  const VIEWPORT_MARGIN = 12

  // Recomputes the portal panel's fixed-position coordinates from the
  // trigger's current on-screen position — called on open and kept in sync
  // while open via scroll/resize listeners below.
  function measure() {
    const btn = buttonRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const openUpward = spaceBelow < MENU_MAX_HEIGHT + VIEWPORT_MARGIN && spaceAbove > spaceBelow

    setMenuRect({
      left: rect.left,
      width: rect.width,
      top: openUpward ? null : rect.bottom + 8,
      bottom: openUpward ? window.innerHeight - rect.top + 8 : null,
      maxHeight: Math.max(160, Math.min(MENU_MAX_HEIGHT, (openUpward ? spaceAbove : spaceBelow) - VIEWPORT_MARGIN)),
    })
  }

  // Measure synchronously before paint so the panel never flashes at the
  // wrong position, then keep tracking the trigger for as long as it's open.
  useLayoutEffect(() => {
    if (!open) return
    measure()
    function handleTrack() {
      measure()
    }
    window.addEventListener('scroll', handleTrack, true)
    window.addEventListener('resize', handleTrack)
    return () => {
      window.removeEventListener('scroll', handleTrack, true)
      window.removeEventListener('resize', handleTrack)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Click-outside-to-close — checks both the trigger AND the portaled panel,
  // since the panel no longer lives inside containerRef in the DOM.
  useEffect(() => {
    function handleClickOutside(e) {
      const insideTrigger = containerRef.current?.contains(e.target)
      const insideMenu = listRef.current?.contains(e.target)
      if (!insideTrigger && !insideMenu) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Keep the highlighted row scrolled into view as arrow keys move it.
  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return
    listRef.current.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  function commit(index) {
    const opt = options[index]
    if (opt != null) onChange(opt)
    setOpen(false)
  }

  function handleTriggerKeyDown(e) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        setOpen(true)
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => Math.min(options.length - 1, i + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => Math.max(0, i - 1))
        break
      case 'Home':
        e.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        e.preventDefault()
        setActiveIndex(options.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        commit(activeIndex)
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        // Type-ahead: typing letters jumps straight to the first matching bank.
        if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
          clearTimeout(typeaheadRef.current.timeout)
          typeaheadRef.current.query += e.key.toLowerCase()
          const match = options.findIndex((o) => o.toLowerCase().startsWith(typeaheadRef.current.query))
          if (match >= 0) setActiveIndex(match)
          typeaheadRef.current.timeout = setTimeout(() => {
            typeaheadRef.current.query = ''
          }, 600)
        }
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpen((o) => {
            const next = !o
            if (next) setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
            return next
          })
        }}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select bank"
        aria-activedescendant={open && activeIndex >= 0 ? `bank-option-${activeIndex}` : undefined}
        className="flex w-full items-center gap-2.5 rounded-lg bg-white py-2.5 pl-2.5 pr-10 text-left shadow-sm outline-none transition-all duration-150 sm:py-2"
      >
        <BankAvatar name={value} muted={!value} />
        <span
          className={`min-w-0 flex-1 truncate text-[15px] font-semibold sm:text-sm ${
            value ? 'text-[var(--ink-dark)]' : 'text-slate-400'
          }`}
        >
          {value || placeholder}
        </span>
      </button>

      {value ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onChange('')
          }}
          aria-label="Clear bank"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-[var(--brand)]"
        >
          <X className="h-4 w-4" />
        </button>
      ) : (
        <ChevronDown
          className={`pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 transition-transform duration-200 ${
            open ? 'rotate-180 text-[var(--brand)]' : ''
          }`}
          aria-hidden="true"
        />
      )}

      {open &&
        menuRect &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            aria-label="Bank options"
            style={{
              position: 'fixed',
              left: menuRect.left,
              width: menuRect.width,
              top: menuRect.top ?? undefined,
              bottom: menuRect.bottom ?? undefined,
              maxHeight: menuRect.maxHeight,
              zIndex: 9999,
            }}
            className="scale-in overflow-y-auto overscroll-contain rounded-xl bg-white p-1.5 shadow-xl shadow-slate-900/10"
          >
            <p className="px-2.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Choose a bank
            </p>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onMouseEnter={() => setActiveIndex(-1)}
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors ${
                !value ? 'bg-[var(--brand)]/10 text-[var(--brand-dark)] font-semibold' : 'text-[var(--ink)] font-medium'
              }`}
            >
              <span
                aria-hidden="true"
                className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-400"
              >
                <Building2 className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate">All banks</span>
              {!value && <Check className="h-4 w-4 shrink-0 text-[var(--brand)]" />}
            </button>
            {options.map((opt, i) => {
              const isSelected = opt === value
              const isActive = i === activeIndex
              return (
                <button
                  key={opt}
                  id={`bank-option-${i}`}
                  data-index={i}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(i)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors ${
                    isActive ? 'bg-[var(--brand)]/10 text-[var(--brand-dark)]' : 'text-[var(--ink)]'
                  } ${isSelected ? 'font-semibold' : 'font-medium'}`}
                >
                  <BankAvatar name={opt} />
                  <span className="min-w-0 flex-1 truncate">{opt}</span>
                  {isSelected && <Check className="h-4 w-4 shrink-0 text-[var(--brand)]" />}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}

// Each bank's real logo, loaded from /public (see BANK_LOGOS above). If a
// logo fails to load — missing file, wrong path, a bank with no entry yet —
// it falls back to a teal initials monogram instead of a broken image, so
// the control never looks unfinished. `size` lets callers reuse this at any
// scale (small in the dropdown, larger in the results header) without a
// second component.
function BankAvatar({ name, muted, size = 38 }) {
  const [imgFailed, setImgFailed] = useState(false)
  const logoUrl = getBankLogoUrl(name)

  useEffect(() => {
    setImgFailed(false)
  }, [name])

  const initials = (name || '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

  const dim = { height: size, width: size }

  if (logoUrl && !imgFailed) {
    return (
      <img
        src={logoUrl}
        alt=""
        aria-hidden="true"
        loading="lazy"
        style={dim}
        className="shrink-0 object-contain"
        onError={() => setImgFailed(true)}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      style={dim}
      className={`flex shrink-0 items-center justify-center rounded-md text-[11px] font-bold ${
        muted ? 'bg-slate-100 text-slate-400' : 'bg-[var(--brand)]/15 text-[var(--brand-dark)]'
      }`}
    >
      {initials || <Landmark className="h-4 w-4" />}
    </span>
  )
}

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

        .card-in { animation: cardIn 0.45s cubic-bezier(0.16, 1, 0.3, 1) both; }
        @keyframes cardIn {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
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

      /* Field-complete checkmark: circle and tick each draw themselves in,
         rather than the icon just popping into place. */
      .check-draw-circle {
        stroke-dasharray: 58;
        stroke-dashoffset: 58;
        animation: checkCircleDraw 0.32s ease-out forwards;
      }
      .check-draw-tick {
        stroke-dasharray: 14;
        stroke-dashoffset: 14;
        animation: checkTickDraw 0.22s 0.22s ease-out forwards;
      }
      @keyframes checkCircleDraw {
        to { stroke-dashoffset: 0; }
      }
      @keyframes checkTickDraw {
        to { stroke-dashoffset: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .check-draw-circle, .check-draw-tick {
          animation: none;
          stroke-dashoffset: 0;
        }
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
        <div className="relative z-10 flex flex-col justify-center px-6 py-11 sm:px-12 sm:py-14 md:pr-0">
          <h1 className="font-display text-4xl font-extrabold leading-tight sm:text-5xl lg:text-6xl">
            Scan &amp; Collect
            <br />
            <span className="text-[var(--accent)]">Checks</span>
          </h1>
          <p className="mt-6 max-w-sm text-base font-medium leading-relaxed text-[var(--brand-light)]">
            Enter the details below to instantly scan the depot for ready packages. No login required.
          </p>
        </div>

        {/* Empty spacer — reserves the grid column's WIDTH only. Since it has
            no content and no fixed height, it can't stretch the row. The
            actual icon is rendered as an absolutely-positioned overlay
            below, so its size never factors into this grid's height calc. */}
        <div className="hidden md:block" aria-hidden="true" />
      </div>

      {/* Icon overlay: absolutely positioned relative to Hero (not a grid
          item), so its size can never affect the card's height — the card's
          height is now driven only by the text column's padding, exactly as
          intended. Still lives inside Hero's own overflow-hidden, so it's
          cleanly cut at the card's rounded edge, same clipped look as
          before — just without dragging the layout taller. */}
      <RouteGraphic />
    </div>
  )
}

function RouteGraphic() {
  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-0 z-0 hidden w-1/2 items-center justify-center md:flex"
      aria-hidden="true"
    >
      <div className="absolute h-[276px] w-[276px] rounded-full bg-[var(--brand-light)]/40 blur-3xl lg:h-[368px] lg:w-[368px]" />

      <img
        src="/csba-icon.png"
        alt=""
        className="relative w-[75%] max-w-[460px] object-contain opacity-85 lg:max-w-[560px]"
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

function ManifestCountCard({ loading, count, branchCounts, branchBankCounts, bank, payee, payor, onEditSearch }) {
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

  // Only meaningful when no specific bank was chosen — otherwise every
  // matched check is from that one bank by definition, so there's nothing
  // to break down.
  const showBankBreakdown = !bank
  const distinctBankCount = showBankBreakdown
    ? new Set(Object.values(branchBankCounts).flatMap((counts) => Object.keys(counts))).size
    : 0

  const summaryText = [
    `CSBA check pickup — ${bank || 'All banks'}`,
    `Payee: ${payee} · Payor: ${payor}`,
    `${count} check${count === 1 ? '' : 's'} ready for pickup`,
    ...activeBranchKeys.map((key) => {
      const branchTotal = branchCounts[key] || 0
      const bankEntries = Object.entries(branchBankCounts[key] || {}).sort((a, b) => b[1] - a[1])
      const bankDetail =
        showBankBreakdown && bankEntries.length > 1
          ? ` (${bankEntries.map(([b, c]) => `${getBankShortName(b)} ${c}`).join(', ')})`
          : ''
      return `• ${OFFICES[key].label}: ${branchTotal} check${branchTotal === 1 ? '' : 's'}${bankDetail}`
    }),
  ].join('\n')
  const { copied, copy: copySummary } = useCopySummary(summaryText)

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl bg-white py-16 shadow-sm border border-slate-100 sm:py-24">
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
      <div className="slide-up relative overflow-hidden flex flex-col items-center justify-center rounded-2xl bg-slate-50 px-4 py-14 text-center border border-slate-200 shadow-inner sm:py-20">
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
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
            <div className="rounded-lg bg-white px-4 py-2 text-xs font-semibold uppercase tracking-widest text-slate-400 shadow-sm border border-slate-100">
              Try double-checking spelling
            </div>
            <button
              type="button"
              onClick={onEditSearch}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-500 shadow-sm transition-colors hover:border-[var(--brand-light)] hover:text-[var(--brand-dark)]"
            >
              <Search className="h-3.5 w-3.5" />
              Edit search
            </button>
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
      {/* Decorative background blobs */}
      <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-[var(--brand-light)] opacity-40 blur-3xl pointer-events-none"></div>
      <div className="absolute -right-24 top-0 h-72 w-72 rounded-full bg-[var(--accent-soft)] opacity-30 blur-3xl pointer-events-none"></div>

      {/* Compact header: count + query on the left, location quick-glance on
          the right. Side-by-side on desktop instead of stacked, so the
          location cards start much higher on the page. */}
      <div className="relative z-10 grid grid-cols-1 gap-6 border-b border-slate-100 px-4 py-6 sm:gap-8 sm:px-8 sm:py-8 lg:grid-cols-[auto_1fr] lg:items-center lg:gap-10">
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <div className="flex items-center gap-2.5">
            <div className="inline-flex items-center gap-2 rounded-full bg-[var(--brand)]/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-[var(--brand-dark)]">
              <Sparkles className="h-4 w-4" /> Scan successful
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2.5 sm:gap-3">
            <span className="font-display text-5xl font-extrabold tabular-nums text-[var(--brand)] sm:text-7xl">
              {displayCount}
            </span>
            <span className="font-display text-base font-bold text-[var(--ink-dark)] sm:text-lg">
              check{count === 1 ? '' : 's'} ready
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs font-medium text-slate-400 lg:justify-start">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              Queried {new Date().toLocaleString()}
            </span>
            {showBankBreakdown && distinctBankCount > 1 && (
              <span className="inline-flex items-center gap-1.5 text-[var(--brand-dark)]">
                <Landmark className="h-3.5 w-3.5" />
                Across {distinctBankCount} banks
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {/* Query chips: plain label-over-value pairs. Whichever of
              Payee/Payor is longer decides the font size for BOTH, so the
              two never end up visually mismatched — the shorter one steps
              down to match instead of the longer one clipping/wrapping.
              Bank uses its own, slightly larger size tier. */}
          <div className="flex flex-col gap-3">
            <QueryChip
              label="Bank"
              value={bank || 'All banks'}
              logo={bank || null}
              icon={Building2}
              size="lg"
              full
              truncate
              sizeClass={sizeForLength((bank || 'All banks').length, ['text-2xl', 'text-xl', 'text-lg'])}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <QueryChip
                label="Payee"
                value={payee}
                full
                truncate
                sizeClass={sizeForLength(Math.max(payee.length, payor.length))}
              />
              <QueryChip
                label="Payor"
                value={payor}
                full
                truncate
                sizeClass={sizeForLength(Math.max(payee.length, payor.length))}
              />
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

          <div className="flex flex-wrap items-center justify-center gap-2 lg:justify-start">
            <button
              type="button"
              onClick={copySummary}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-500 shadow-sm transition-colors hover:border-[var(--brand-light)] hover:text-[var(--brand-dark)]"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-[var(--brand)]" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied to clipboard' : 'Copy pickup summary'}
            </button>
            <button
              type="button"
              onClick={onEditSearch}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-500 shadow-sm transition-colors hover:border-[var(--brand-light)] hover:text-[var(--brand-dark)]"
            >
              <Search className="h-3.5 w-3.5" />
              Edit search
            </button>
          </div>
        </div>
      </div>

      {/* Location grid - every matched branch, always visible side-by-side */}
      <div className="relative z-10 px-4 py-6 sm:px-8 sm:py-8">
        {activeBranchKeys.length > 0 ? (
          <div
            className={`grid gap-5 sm:gap-6 ${
              activeBranchKeys.length === 1 ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'
            }`}
          >
            {activeBranchKeys.map((key, i) => (
              <LocationCard
                key={key}
                office={OFFICES[key]}
                count={branchCounts[key]}
                bankCounts={branchBankCounts[key] || {}}
                showBankBreakdown={showBankBreakdown}
                wide={activeBranchKeys.length === 1}
                delay={i * 90}
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

// A query chip is a plain label-over-value pair, no card/box.
//
// `truncate` makes long values robust against overflowing their column:
// - Step down through progressively smaller type sizes as the value gets
//   longer, so a moderately long name still reads at (near) full size
//   instead of immediately clipping.
// - As a final safety net at any length, the value is still constrained to
//   a single line with a trailing ellipsis (CSS `truncate`) — so even a
//   value long enough to blow past the smallest size never breaks layout
//   or wraps awkwardly.
// - The full, untruncated value is always available on hover/focus via the
//   native `title` tooltip.
//
// `sizeClass`, when supplied by the caller, overrides the chip's own
// length-based size calculation — this is how Payee and Payor are made to
// always share one size (whichever of the two is longer decides both).
//
// `icon`, when supplied and `logo` is falsy, renders as a neutral fallback
// glyph (e.g. a generic bank building for the "All banks" state) instead of
// leaving an empty gap where a logo would normally sit.
function sizeForLength(len, tiers = ['text-lg', 'text-base', 'text-sm']) {
  const [big, mid, small] = tiers
  if (len > 34) return small
  if (len > 24) return mid
  return big
}

function QueryChip({ label, value, full, size = 'md', logo, icon: Icon, truncate, sizeClass }) {
  const logoSize = size === 'lg' ? 40 : 28
  const valueSizeClass = sizeClass || (truncate ? sizeForLength((value || '').length) : 'text-lg')

  return (
    <div className={`flex min-w-0 flex-col items-start ${full ? 'w-full' : ''}`}>
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <div className="mt-1 flex min-w-0 w-full items-center gap-2">
        {logo ? (
          <BankAvatar name={logo} size={logoSize} />
        ) : Icon ? (
          <span
            aria-hidden="true"
            style={{ height: logoSize, width: logoSize }}
            className="flex shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-400"
          >
            <Icon className="h-4 w-4" />
          </span>
        ) : null}
        <span
          title={value || undefined}
          className={`block min-w-0 flex-1 truncate text-left font-bold uppercase tracking-wide text-[var(--ink-dark)] ${valueSizeClass}`}
        >
          {value}
        </span>
      </div>
    </div>
  )
}

// Compact "which bank did this come from" breakdown for a single branch
// card. Kept deliberately terse for mobile: bank rows are sorted by volume,
// only the top 3 show by default, and anything beyond that collapses behind
// a "+N more" toggle instead of pushing the card taller for every visitor.
function BankBreakdown({ counts }) {
  const [expanded, setExpanded] = useState(false)
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])

  if (entries.length === 0) return null

  const VISIBLE_LIMIT = 3
  const visible = expanded ? entries : entries.slice(0, VISIBLE_LIMIT)
  const hiddenCount = entries.length - visible.length

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
      <p className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">
        <Landmark className="h-3 w-3" /> Checks by bank
      </p>
      <ul className="flex flex-col gap-1.5">
        {visible.map(([bankName, bankCount]) => (
          <li key={bankName} className="flex items-center gap-2" title={bankName}>
            <BankAvatar name={bankName} size={20} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-600">
              {getBankShortName(bankName)}
            </span>
            <span className="shrink-0 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-bold tabular-nums text-[var(--brand-dark)]">
              {bankCount}
            </span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1.5 text-[11px] font-semibold text-[var(--brand)] transition-colors hover:text-[var(--brand-dark)]"
        >
          +{hiddenCount} more bank{hiddenCount === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}

// A single pickup location: identity + count, address, hours/phone (with a
// safe generic fallback when not yet confirmed), a standard requirements
// checklist, directions/copy actions, and an interactive map/street-view
// toggle. Used once per matched branch inside the grid above, so multiple
// locations are always visible together rather than switched between.
function LocationCard({ office, count, bankCounts, showBankBreakdown, wide, delay = 0 }) {
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
      style={{ animationDelay: `${delay}ms` }}
      className={`card-in relative flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-lg ${
        wide ? 'lg:flex-row' : ''
      }`}
    >
      {/* Identity + details */}
      <div className={`flex flex-col gap-4 p-4 sm:p-6 ${wide ? 'lg:w-[42%] lg:justify-center' : ''}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--brand)]/10 text-[var(--brand-dark)]">
              {/* Sourced from /public/csba-icon.png — served at the site root */}
              <img src="/csba-icon.png" alt="CSBA" className="h-7 w-7 object-contain" />
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

        <div className="flex flex-col gap-2 text-xs font-semibold text-slate-500 sm:flex-row sm:flex-wrap sm:gap-4">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
            {office.hours || 'Contact CSBA for hours'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
            {office.phone || 'Contact CSBA for phone support'}
          </span>
        </div>

        {/* Which bank(s) each check at this branch actually came from — only
            rendered when the search wasn't already scoped to one bank. */}
        {showBankBreakdown && <BankBreakdown counts={bankCounts} />}

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
            className="group/btn inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-[var(--accent)]/30 transition-all hover:-translate-y-0.5 hover:bg-[var(--accent-dark)] hover:shadow-[var(--accent)]/50"
          >
            <Navigation className="h-3.5 w-3.5" />
            Get Directions
          </a>
          <button
            type="button"
            onClick={copyAddress}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-500 transition-colors hover:border-[var(--brand-light)] hover:text-[var(--brand-dark)]"
          >
            {addressCopied ? <Check className="h-3.5 w-3.5 text-[var(--brand)]" /> : <Copy className="h-3.5 w-3.5" />}
            {addressCopied ? 'Copied' : 'Copy address'}
          </button>
        </div>
      </div>

      {/* Interactive map / street view */}
      <div className={`flex flex-col p-4 pt-0 sm:p-6 sm:pt-0 ${wide ? 'lg:w-[58%] lg:justify-center lg:pt-6' : ''}`}>
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

function PromptState({ ready }) {
  return (
    <div className="slide-up flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-white px-6 py-24 text-center shadow-sm">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--brand-light)]/50 border border-[var(--brand-light)]">
        {ready ? (
          <Search className="h-9 w-9 text-[var(--brand)]" />
        ) : (
          <Navigation className="h-9 w-9 text-[var(--brand)]" />
        )}
      </div>
      <h3 className="font-display text-2xl font-extrabold text-[var(--ink-dark)]">
        {ready ? 'Ready to search' : 'Ready to scan'}
      </h3>
      <p className="mt-3 max-w-sm text-base font-medium text-slate-500">
        {ready
          ? 'Tap "View available checks" above to see what\u2019s ready for pickup.'
          : 'Enter the payee and payor printed on the check above to locate items available for pickup at the depot. Bank is optional — leave it blank to search every bank at once.'}
      </p>
    </div>
  )
}