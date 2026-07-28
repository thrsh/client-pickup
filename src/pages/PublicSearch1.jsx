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
  Package,
  Truck,
  Loader2,
  CheckCircle2,
  Check,
  Building2,
  Route,
  Phone,
  Copy,
  AlertCircle,
  ShieldCheck,
  CreditCard,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Input } from '../components/ui/input'

const SUGGESTION_MIN_CHARS = 3
const MAX_RESERVE_BATCH = 500

// Static, curated bank list — matches the client-facing search page exactly.
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

// ---------------------------------------------------------------------------
// Name normalization — identical to the client-facing search page and to the
// DB's own `payee_normalized` / `payor_normalized` generated columns.
// ---------------------------------------------------------------------------
const CORP_SUFFIX_RE = /\s+(inc|incorporated|corp|corporation|llc|ltd|limited)$/

function normalizeCompanyName(raw) {
  if (!raw) return ''
  let s = raw.trim().toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, ' ').trim()
  s = s.replace(CORP_SUFFIX_RE, '')
  return s.trim()
}

// ---------------------------------------------------------------------------
// Collector-name validation — used both live in the confirmation modal and
// as the final guard right before the reservation RPC fires.
// ---------------------------------------------------------------------------
const COLLECTOR_NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ.'\-\s]+$/
const COLLECTOR_NAME_MAX = 60

// IDs accepted for pickup verification — shown to the collector before they
// confirm, and again as a reminder once the reservation is made.
const ACCEPTED_IDS = ['Passport', 'PhilSys National ID', 'Postal ID', "Driver's License"]

function validateCollectorName(raw) {
  const trimmed = (raw || '').trim()
  if (!trimmed) return { valid: false, message: 'Enter the collector\u2019s full name.' }
  if (trimmed.length < 2) return { valid: false, message: 'That name looks too short.' }
  if (trimmed.length > COLLECTOR_NAME_MAX) {
    return { valid: false, message: `Keep it under ${COLLECTOR_NAME_MAX} characters.` }
  }
  if (!COLLECTOR_NAME_RE.test(trimmed)) {
    return { valid: false, message: 'Use letters, spaces, hyphens, or apostrophes only.' }
  }
  if (trimmed.split(/\s+/).filter(Boolean).length < 2) {
    return { valid: false, message: 'Include both a first and last name.' }
  }
  return { valid: true, message: '' }
}

// ---------------------------------------------------------------------------
// Branch / pickup-location configuration — mirrors the client page's OFFICES
// registry exactly, so both surfaces always agree on where a branch is and
// what its contact details are. Kept address/hours/phone only: the
// collector view intentionally omits the embedded map + Street View tabs
// that the client page shows, since a collector already knows how to get
// around and doesn't need a photographic walkthrough — just the facts.
// ---------------------------------------------------------------------------
const BRANCH_FIELD = 'pickup_branch'
const OFFICE_HOURS = 'Mon–Thu 8:00 AM–7:00 PM · Fri 8:00 AM–7:30 PM'

const OFFICES = {
  'CSBA - PARQAL': {
    label: 'PARQAL, Parañaque Office',
    shortLabel: 'PARQAL, Parañaque',
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
  },
  'CSBA - BGC': {
    label: 'BGC, Taguig Office',
    shortLabel: 'BGC, Taguig',
    hours: OFFICE_HOURS,
    phone: null,
    address: {
      line1: 'Bonifacio Technology Center',
      line2: '31st Street cor 2nd Avenue',
      line3: 'Bonifacio Global City',
      line4: 'Taguig, 1634',
    },
    lat: 14.5547443,
    lng: 121.0444729,
  },
}

function getDirectionsUrl(office) {
  return `https://www.google.com/maps/dir/?api=1&destination=${office.lat},${office.lng}`
}

// Both CSBA offices, always in a fixed, predictable order (highest count
// first) — pickup locations are physical facts about the org, not something
// that should disappear from the UI just because a search matched zero
// checks there. Every branch card downstream renders from this list.
function getOrderedBranches(branchCounts = {}) {
  return Object.keys(OFFICES)
    .map((key) => ({ key, office: OFFICES[key], count: branchCounts[key] || 0 }))
    .sort((a, b) => b.count - a.count)
}

export default function CollectorSearch() {
  const [bank, setBank] = useState('')

  const [payeeQuery, setPayeeQuery] = useState('')
  const [payorQuery, setPayorQuery] = useState('')
  const [matchedCount, setMatchedCount] = useState(0)
  const [matchedIds, setMatchedIds] = useState([])
  // Per-branch counts for the current query, e.g. { 'CSBA - PARQAL': 3, 'CSBA - BGC': 1 }
  const [branchCounts, setBranchCounts] = useState({})
  const [loading, setLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const [payeeSuggestions, setPayeeSuggestions] = useState([])
  const [showPayeeSuggestions, setShowPayeeSuggestions] = useState(false)
  const payeeBoxRef = useRef(null)
  const payeeInputRef = useRef(null)

  const [payorSuggestions, setPayorSuggestions] = useState([])
  const [showPayorSuggestions, setShowPayorSuggestions] = useState(false)
  const payorBoxRef = useRef(null)

  const [showConfirm, setShowConfirm] = useState(false)
  const [collectorName, setCollectorName] = useState('')
  const [reserving, setReserving] = useState(false)
  const [reserveError, setReserveError] = useState('')
  const [successInfo, setSuccessInfo] = useState(null)

  const searchSectionRef = useRef(null)
  const resultsRef = useRef(null)

  // Guards against out-of-order responses, same pattern as the client page:
  // if a second search fires before the first's round-trip resolves, only
  // the response matching the latest request id is allowed to update state.
  const requestIdRef = useRef(0)

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

  // A field changing after a search has run means that search no longer
  // describes the current query — drop back out of "results shown" state.
  useEffect(() => {
    setHasSearched(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank, payeeQuery, payorQuery])

  // ---------------------------------------------------------------------
  // Search logic
  // ---------------------------------------------------------------------
  // Matches on the normalized columns (exact equality), same as the client
  // page — and additionally fetches actual row ids (not just a count),
  // since the collector needs those ids to create a reservation.
  function buildMatchQuery(bankValue, payeeNormalized, payorNormalized) {
    let req = supabase
      .from('checks')
      .select('id', { count: 'exact' })
      .eq('status', 'available')
      .eq('bank', bankValue)
      .limit(MAX_RESERVE_BATCH)

    if (payeeNormalized) req = req.eq('payee_normalized', payeeNormalized)
    if (payorNormalized) req = req.eq('payor_normalized', payorNormalized)

    return req
  }

  // Cheap, count-only companion query (head: true — no row bodies returned)
  // used per-branch to build the location breakdown, exactly like the
  // client page's buildBaseQuery.
  function buildBranchCountQuery(bankValue, payeeNormalized, payorNormalized) {
    let req = supabase
      .from('checks')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'available')
      .eq('bank', bankValue)

    if (payeeNormalized) req = req.eq('payee_normalized', payeeNormalized)
    if (payorNormalized) req = req.eq('payor_normalized', payorNormalized)

    return req
  }

  async function fetchMatchCount(bankTerm, payeeTerm, payorTerm) {
    const bankValue = bankTerm.trim()
    const payeeNormalized = normalizeCompanyName(payeeTerm)
    const payorNormalized = normalizeCompanyName(payorTerm)

    if (!bankValue || !payeeNormalized || !payorNormalized) {
      setMatchedCount(0)
      setMatchedIds([])
      setBranchCounts({})
      setLoading(false)
      return
    }

    const thisRequestId = ++requestIdRef.current
    setLoading(true)
    setReserveError('')

    try {
      // Best-effort — reservation cleanup shouldn't block the search itself
      // if it fails for some transient reason.
      await supabase.rpc('reclaim_expired_reservations')

      const branchKeys = Object.keys(OFFICES)
      const [matchResult, ...branchResults] = await Promise.all([
        buildMatchQuery(bankValue, payeeNormalized, payorNormalized),
        ...branchKeys.map((key) =>
          buildBranchCountQuery(bankValue, payeeNormalized, payorNormalized).eq(BRANCH_FIELD, key)
        ),
      ])

      if (thisRequestId !== requestIdRef.current) return
      if (matchResult.error) throw matchResult.error

      const nextBranchCounts = {}
      branchKeys.forEach((key, idx) => {
        const result = branchResults[idx]
        if (!result.error) {
          nextBranchCounts[key] = result.count || 0
        }
      })

      setMatchedIds((matchResult.data || []).map((r) => r.id))
      setMatchedCount(matchResult.count || 0)
      setBranchCounts(nextBranchCounts)
    } catch (err) {
      if (thisRequestId !== requestIdRef.current) return
      console.error('Failed to fetch check matches:', err)
      setMatchedCount(0)
      setMatchedIds([])
      setBranchCounts({})
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

    let req = supabase
      .from('checks')
      .select(field)
      .eq('status', 'available')
      .ilike(`${field}_normalized`, `%${normalizedTerm}%`)
      .limit(20)

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
    setSuccessInfo(null)
    fetchMatchCount(bank, payeeQuery, payorQuery)

    requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

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
    setMatchedIds([])
    setBranchCounts({})
    setHasSearched(false)
  }

  // ---------------------------------------------------------------------
  // Reservation flow — confirm modal collects and validates the collector's
  // name, then calls the same create_reservation RPC.
  // ---------------------------------------------------------------------
  function openConfirm() {
    if (matchedCount === 0) return
    setReserveError('')
    setShowConfirm(true)
  }

  async function confirmPickup() {
    const validation = validateCollectorName(collectorName)
    if (!validation.valid) {
      setReserveError(validation.message)
      return
    }

    const cleanName = collectorName.trim().replace(/\s+/g, ' ')
    setReserving(true)
    setReserveError('')

    const { data, error } = await supabase.rpc('create_reservation', {
      p_check_ids: matchedIds,
      p_collector_name: cleanName,
    })

    setReserving(false)

    if (error) {
      setReserveError(error.message || 'Something went wrong. Please try again.')
      return
    }

    const result = Array.isArray(data) ? data[0] : data
    setSuccessInfo({
      count: matchedCount,
      expiresAt: result?.expires_at,
      collectorName: cleanName,
      bank,
      payee: payeeQuery,
      payor: payorQuery,
      branchCounts: { ...branchCounts },
    })
    setShowConfirm(false)
    setCollectorName('')
    fetchMatchCount(bank, payeeQuery, payorQuery)
  }

  const hasQueryText = !!(bank.trim() && payeeQuery.trim() && payorQuery.trim())
  const filledCount = [bank, payeeQuery, payorQuery].filter((v) => v.trim().length > 0).length

  const payeeTrimmed = payeeQuery.trim()
  const payorTrimmed = payorQuery.trim()
  const payeeTooShort = payeeTrimmed.length > 0 && payeeTrimmed.length < SUGGESTION_MIN_CHARS
  const payorTooShort = payorTrimmed.length > 0 && payorTrimmed.length < SUGGESTION_MIN_CHARS

  return (
    <div className="psp-page rider-app min-h-screen pb-32 relative overflow-hidden">
      <PageStyles />
      <BackgroundGeometry />

      <div className="relative z-10">
        <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6 sm:pt-10">
          <Hero />

          {successInfo && <SuccessManifest info={successInfo} onDismiss={() => setSuccessInfo(null)} />}

          {/* Search slip — identical ledger-styled layout to the client page:
              numbered fields, progress bar, underline inputs. */}
          <div
            ref={searchSectionRef}
            className="relative z-20 -mt-5 mb-8 mx-auto max-w-4xl scroll-mt-6 sm:-mt-6 sm:mb-10"
          >
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
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
                <SlipField index="01" icon={Landmark} label="Bank" filled={Boolean(bank)}>
                  <BankDropdown
                    value={bank}
                    options={BANKS}
                    onChange={(next) => {
                      setBank(next)
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
                  caption={payeeTooShort ? undefined : 'Name printed on the check'}
                  warning={payeeTooShort ? `Type ${SUGGESTION_MIN_CHARS - payeeTrimmed.length} more character${SUGGESTION_MIN_CHARS - payeeTrimmed.length === 1 ? '' : 's'} for suggestions` : null}
                >
                  <div className="relative">
                    <Input
                      ref={payeeInputRef}
                      value={payeeQuery}
                      onChange={(e) => setPayeeQuery(e.target.value)}
                      onBlur={() => setPayeeQuery((v) => v.replace(/\s+/g, ' ').trim())}
                      onKeyDown={handleKeyDown}
                      onFocus={() => payeeSuggestions.length > 0 && setShowPayeeSuggestions(true)}
                      placeholder="Name on check"
                      maxLength={120}
                      autoComplete="off"
                      className="h-auto w-full rounded-none border-0 border-b-2 border-slate-200 bg-transparent px-0 py-2 pr-6 text-[15px] font-semibold shadow-none focus-visible:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-0 sm:py-1.5 sm:text-sm"
                      aria-label="Search by payee"
                    />
                    {payeeQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setPayeeQuery('')
                          setPayeeSuggestions([])
                          setShowPayeeSuggestions(false)
                          payeeInputRef.current?.focus()
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
                  caption={payorTooShort ? undefined : 'Bank or company that issued it'}
                  warning={payorTooShort ? `Type ${SUGGESTION_MIN_CHARS - payorTrimmed.length} more character${SUGGESTION_MIN_CHARS - payorTrimmed.length === 1 ? '' : 's'} for suggestions` : null}
                >
                  <div className="relative">
                    <Input
                      value={payorQuery}
                      onChange={(e) => setPayorQuery(e.target.value)}
                      onBlur={() => setPayorQuery((v) => v.replace(/\s+/g, ' ').trim())}
                      onKeyDown={handleKeyDown}
                      onFocus={() => payorSuggestions.length > 0 && setShowPayorSuggestions(true)}
                      placeholder="Issuing party"
                      maxLength={120}
                      autoComplete="off"
                      className="h-auto w-full rounded-none border-0 border-b-2 border-slate-200 bg-transparent px-0 py-2 pr-6 text-[15px] font-semibold shadow-none focus-visible:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-0 sm:py-1.5 sm:text-sm"
                      aria-label="Search by payor"
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
                    title={!hasQueryText ? 'Select a bank and enter both payee and payor to search' : undefined}
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
          <div ref={resultsRef} className="mx-auto max-w-4xl relative z-10 pb-4 scroll-mt-6" aria-live="polite">
            {!hasSearched ? (
              <PromptState ready={hasQueryText} />
            ) : (
              <ManifestCountCard
                loading={loading}
                count={matchedCount}
                branchCounts={branchCounts}
                bank={bank}
                payee={payeeQuery}
                payor={payorQuery}
                onEditSearch={scrollToSearch}
              />
            )}
          </div>
        </div>

        {/* Sticky bottom reserve bar — same brand gradient used throughout,
            visible whenever there's something to reserve. */}
        {hasSearched && !loading && matchedCount > 0 && !successInfo && (
          <div className="slide-up fixed inset-x-0 bottom-0 z-40 bg-gradient-to-r from-[var(--brand-dark)] via-[var(--brand)] to-[var(--brand-dark)] px-4 pb-6 pt-5 shadow-[0_-16px_40px_rgba(13,148,136,0.35)] sm:pb-5">
            <div className="absolute inset-x-0 top-0 h-[3px] bg-[var(--brand-light)]"></div>
            <div className="mx-auto flex max-w-4xl flex-col items-center justify-between gap-4 sm:flex-row">
              <div className="flex w-full items-center gap-4 sm:w-auto">
                <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--brand-light)]/15 ring-1 ring-[var(--brand-light)]/40">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand-light)] opacity-20"></span>
                  <Package className="h-7 w-7 text-[var(--brand-light)]" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-white uppercase tracking-wide">Ready for pickup</p>
                  <p className="font-display text-2xl font-extrabold text-white">
                    {matchedCount} Check{matchedCount === 1 ? '' : 's'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={openConfirm}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-10 py-4 text-base font-semibold text-white shadow-xl shadow-black/25 transition-all hover:-translate-y-0.5 hover:bg-[var(--accent-dark)] active:scale-95 sm:w-auto"
              >
                <Truck className="h-5 w-5" />
                Reserve now
              </button>
            </div>
          </div>
        )}

        {showConfirm && (
          <ConfirmModal
            count={matchedCount}
            bank={bank}
            payee={payeeQuery}
            payor={payorQuery}
            branchCounts={branchCounts}
            collectorName={collectorName}
            onCollectorNameChange={setCollectorName}
            onCancel={() => {
              setShowConfirm(false)
              setReserveError('')
            }}
            onConfirm={confirmPickup}
            reserving={reserving}
            error={reserveError}
          />
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------- */
/* Presentational Components — shared visual language with the client page */
/* ---------------------------------------------------------------------- */

const SlipField = React.forwardRef(function SlipField(
  { index, icon: Icon, label, caption, warning, filled, children },
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
      {warning ? (
        <p className="flex items-center gap-1 text-[10.5px] font-semibold leading-snug text-amber-600">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {warning}
        </p>
      ) : (
        caption && <p className="text-[10.5px] font-medium leading-snug text-slate-400">{caption}</p>
      )}
    </div>
  )
})

function BankDropdown({ value, options, onChange, placeholder = 'Select bank...' }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [menuRect, setMenuRect] = useState(null)
  const containerRef = useRef(null)
  const listRef = useRef(null)
  const buttonRef = useRef(null)
  const searchInputRef = useRef(null)

  const filteredOptions = options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase()))

  const MENU_MAX_HEIGHT = 340
  const VIEWPORT_MARGIN = 12

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
      maxHeight: Math.max(200, Math.min(MENU_MAX_HEIGHT, (openUpward ? spaceAbove : spaceBelow) - VIEWPORT_MARGIN)),
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    measure()
    setQuery('')
    setActiveIndex(Math.max(0, options.indexOf(value)))
    const raf = requestAnimationFrame(() => searchInputRef.current?.focus())
    function handleTrack() {
      measure()
    }
    window.addEventListener('scroll', handleTrack, true)
    window.addEventListener('resize', handleTrack)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', handleTrack, true)
      window.removeEventListener('resize', handleTrack)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    function handleClickOutside(e) {
      const insideTrigger = containerRef.current?.contains(e.target)
      const insideMenu = listRef.current?.contains(e.target)
      if (!insideTrigger && !insideMenu) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return
    listRef.current.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  // Re-anchor the highlighted row to the top match whenever the filter text
  // changes, so arrow keys / Enter always act on what's visibly first.
  useEffect(() => {
    if (!open) return
    setActiveIndex(filteredOptions.length > 0 ? 0 : -1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  function commit(index) {
    const opt = filteredOptions[index]
    if (opt != null) onChange(opt)
    setOpen(false)
  }

  function handleSearchKeyDown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => Math.min(filteredOptions.length - 1, i + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => Math.max(0, i - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (activeIndex >= 0) commit(activeIndex)
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        buttonRef.current?.focus()
        break
      default:
        break
    }
  }

  function handleTriggerKeyDown(e) {
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault()
      setOpen(true)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select bank"
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
            className="scale-in flex flex-col overflow-hidden rounded-xl bg-white p-1.5 shadow-xl shadow-slate-900/10"
          >
            <div className="relative mb-1.5 shrink-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search banks..."
                aria-label="Search banks"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-8 pr-2.5 text-sm font-medium text-[var(--ink-dark)] outline-none transition-colors focus:border-[var(--brand)] focus:bg-white"
              />
            </div>

            <div className="overflow-y-auto overscroll-contain">
              {filteredOptions.length === 0 ? (
                <p className="px-2.5 py-6 text-center text-sm font-medium text-slate-400">
                  No banks match “{query}”
                </p>
              ) : (
                filteredOptions.map((opt, i) => {
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
                })
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

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
        --ink: #334155;
        --ink-dark: #0f172a;
        --brand: #0d9488;
        --brand-dark: #0f766e;
        --brand-light: #ccfbf1;
        --accent: #f97316;
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
      @keyframes checkCircleDraw { to { stroke-dashoffset: 0; } }
      @keyframes checkTickDraw { to { stroke-dashoffset: 0; } }
      @media (prefers-reduced-motion: reduce) {
        .check-draw-circle, .check-draw-tick { animation: none; stroke-dashoffset: 0; }
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
            Search a bank, payee, and payor to see how many checks are ready — then reserve them for pickup.
          </p>
        </div>

        <div className="hidden md:block" aria-hidden="true" />
      </div>

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

// Results card — shares the client page's full visual grammar: loading /
// zero-result / success states, the Bank/Payee/Payor QueryChip header, AND
// the branch breakdown grid (address, hours, phone — no map/street view).
// Both CSBA offices are always listed here, whether or not this particular
// search matched anything there, so a collector always knows the full
// pickup picture. The reserve CTA itself still lives in the sticky bottom
// bar, so the success state closes with a short "ready to reserve" prompt
// instead of duplicating that button here.
function ManifestCountCard({ loading, count, branchCounts, bank, payee, payor, onEditSearch }) {
  const displayCount = useCountUp(count, !loading)

  const branches = getOrderedBranches(branchCounts)
  const matchedBranches = branches.filter((b) => b.count > 0)
  const isMultiLocation = matchedBranches.length > 1
  const unmappedCount = Math.max(0, count - branches.reduce((sum, b) => sum + b.count, 0))

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
            We searched high and low, but couldn't find anything for{' '}
            <span className="font-semibold text-slate-700">"{payee}"</span> and{' '}
            <span className="font-semibold text-slate-700">"{payor}"</span>
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

  return (
    <div className="slide-up relative overflow-hidden rounded-2xl bg-white shadow-xl border border-[var(--brand-light)]">
      <div className="absolute -left-16 -top-16 h-48 w-48 rounded-full bg-[var(--brand-light)] opacity-30 blur-3xl pointer-events-none"></div>
      <div className="absolute -right-20 top-0 h-56 w-56 rounded-full bg-[var(--accent-soft)] opacity-20 blur-3xl pointer-events-none"></div>

      {/* Compact header — one dense band instead of a tall two-column hero */}
      <div className="relative z-10 flex flex-col gap-3 border-b border-slate-100 px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand)]/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-[var(--brand-dark)]">
              <Sparkles className="h-3.5 w-3.5" /> Scan successful
            </span>
            {isMultiLocation ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[10px] font-bold text-[var(--accent-dark)]">
                <Route className="h-3 w-3" /> {matchedBranches.length} locations
              </span>
            ) : (
              matchedBranches.length === 1 && (
                <span className="hidden items-center gap-1 text-[11px] font-semibold text-slate-400 sm:inline-flex">
                  <MapPin className="h-3 w-3 text-[var(--brand)]" /> {matchedBranches[0].office.shortLabel}
                </span>
              )
            )}
          </div>
          <button
            type="button"
            onClick={onEditSearch}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-500 shadow-sm transition-colors hover:border-[var(--brand-light)] hover:text-[var(--brand-dark)]"
          >
            <Search className="h-3.5 w-3.5" />
            Edit search
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-4xl font-extrabold tabular-nums text-[var(--brand)] sm:text-5xl">
              {displayCount}
            </span>
            <span className="font-display text-sm font-bold text-[var(--ink-dark)] sm:text-base">
              check{count === 1 ? '' : 's'} ready
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <MiniChip label="Bank" value={bank} logo={bank} />
            <MiniChip label="Payee" value={payee} />
            <MiniChip label="Payor" value={payor} />
          </div>
        </div>
      </div>

      {/* Branch breakdown — address-only cards, no embedded map/street view.
          Only branches that actually matched checks are shown here, so the
          collector isn't sent to a location with nothing to pick up. */}
      <div className="relative z-10 px-4 py-4 sm:px-6 sm:py-5">
        <p className="mb-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          <Building2 className="h-3.5 w-3.5" /> Pickup location{matchedBranches.length === 1 ? '' : 's'}
        </p>
        <div className={`grid gap-3 ${matchedBranches.length === 1 ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'}`}>
          {matchedBranches.map((b, i) => (
            <LocationCard key={b.key} office={b.office} count={b.count} delay={i * 80} />
          ))}
        </div>

        {unmappedCount > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[11px] font-medium text-amber-700">
            {unmappedCount} of these {unmappedCount === 1 ? 'check is' : 'checks are'} at a branch not shown here —
            confirm with CSBA before reserving.
          </div>
        )}
      </div>
    </div>
  )
}

// Compact query pill: label over value with an optional bank logo. Sized up
// so the searched Bank / Payee / Payor are easy to read at a glance next to
// the big result count, instead of disappearing as fine print.
function MiniChip({ label, value, logo }) {
  return (
    <div className="flex min-w-0 max-w-[240px] items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      {logo && <BankAvatar name={logo} size={22} />}
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
        <span className="truncate text-sm font-medium text-[var(--ink-dark)] sm:text-base" title={value || undefined}>
          {value}
        </span>
      </div>
    </div>
  )
}

// Address-only branch card: identity + count, full address, hours/phone,
// and a directions link — deliberately no embedded map or Street View
// iframe, per the collector view's simpler, faster-scanning brief. Renders
// the same whether the branch matched checks or not — a zero-match branch
// is simply shown in a quieter, muted state rather than being hidden.
function LocationCard({ office, count, delay = 0 }) {
  const [addressCopied, setAddressCopied] = useState(false)
  const directionsUrl = getDirectionsUrl(office)
  const hasMatches = count > 0
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
      className={`card-in flex flex-col gap-2.5 rounded-xl border p-3.5 shadow-sm transition-all duration-200 hover:shadow-md ${
        hasMatches
          ? 'border-slate-200 bg-white hover:border-[var(--brand-light)]'
          : 'border-slate-150 bg-slate-50/60 hover:border-slate-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
              hasMatches ? 'bg-[var(--brand)]/10' : 'bg-slate-200/60'
            }`}
          >
            <img src="/csba-icon.png" alt="" className={`h-5 w-5 object-contain ${hasMatches ? '' : 'opacity-50'}`} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-display text-sm font-extrabold leading-tight text-[var(--ink-dark)]">
              {office.label}
            </h3>
            <p className="text-[10px] font-medium text-slate-400">CSBA branch office</p>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold tabular-nums shadow-sm ${
            hasMatches ? 'bg-[var(--brand)] text-white' : 'bg-slate-200 text-slate-500'
          }`}
        >
          {count} check{count === 1 ? '' : 's'}
        </span>
      </div>

      <p className="flex items-start gap-1.5 text-xs font-medium leading-relaxed text-slate-600">
        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
        {fullAddress}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-[11px] font-semibold text-slate-500">
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3 shrink-0 text-[var(--brand)]" />
          {office.hours || 'Contact CSBA for hours'}
        </span>
        <span className="inline-flex items-center gap-1">
          <Phone className="h-3 w-3 shrink-0 text-[var(--brand)]" />
          {office.phone || 'Contact CSBA'}
        </span>
      </div>

      <div className="flex items-center gap-2 pt-0.5">
        <a
          href={directionsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-[var(--accent-dark)]"
        >
          <Navigation className="h-3 w-3" />
          Directions
        </a>
        <button
          type="button"
          onClick={copyAddress}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-500 transition-colors hover:border-[var(--brand-light)] hover:text-[var(--brand-dark)]"
        >
          {addressCopied ? <Check className="h-3 w-3 text-[var(--brand)]" /> : <Copy className="h-3 w-3" />}
          {addressCopied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

// Reservation confirmation — a focused dialog with a fixed max width, an
// internal two-column body (summary left, action right) once there's room,
// a pinned header/footer so only the middle scrolls, Escape-to-close,
// click-outside-to-close, and a body-scroll lock while it's open. The
// collector-name field validates live as the person types.
function ConfirmModal({
  count,
  bank,
  payee,
  payor,
  branchCounts,
  collectorName,
  onCollectorNameChange,
  onCancel,
  onConfirm,
  reserving,
  error,
}) {
  const [nameTouched, setNameTouched] = useState(false)
  const [idAcknowledged, setIdAcknowledged] = useState(false)
  const [idTouched, setIdTouched] = useState(false)
  const matchedBranches = getOrderedBranches(branchCounts).filter((b) => b.count > 0)
  const nameValidation = validateCollectorName(collectorName)
  const showNameError = nameTouched && !nameValidation.valid && collectorName.length > 0
  const showNameSuccess = nameTouched && nameValidation.valid
  const showIdError = idTouched && !idAcknowledged

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape' && !reserving) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reserving])

  function handleConfirmClick() {
    setNameTouched(true)
    setIdTouched(true)
    if (nameValidation.valid && idAcknowledged) onConfirm()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink-dark)]/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !reserving) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-reservation-title"
        className="scale-in flex w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl sm:max-w-2xl max-h-[92vh]"
      >
        <div className="h-1 w-full shrink-0 bg-[var(--brand)]" />

        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand)]/10 text-[var(--brand-dark)]">
              <Truck className="h-5 w-5" />
            </span>
            <div>
              <h2
                id="confirm-reservation-title"
                className="font-display text-lg font-extrabold text-[var(--ink-dark)] sm:text-xl"
              >
                Confirm reservation
              </h2>
              <p className="text-xs font-medium text-slate-400 sm:text-sm">
                These items will be held for exactly 1 hour once confirmed.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={reserving}
            aria-label="Close"
            className="shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-[var(--ink-dark)] disabled:opacity-50"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Body — two columns once there's room, stacked on mobile */}
        <div className="flex-1 overflow-y-auto bg-slate-50 px-6 py-6 sm:px-8">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-4">
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col items-center gap-1 py-5">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                    Total checks
                  </span>
                  <span className="font-display text-4xl font-extrabold text-[var(--brand)]">{count}</span>
                </div>
                <div className="grid grid-cols-1 divide-y divide-slate-100 border-t border-slate-100">
                  <SummaryRow label="Bank" value={bank} />
                  <SummaryRow label="Payee" value={payee} />
                  <SummaryRow label="Payor" value={payor} />
                </div>
              </div>

              {/* Pickup at — only the office(s) that actually have matching
                  checks, so the collector isn't sent somewhere empty. */}
              {matchedBranches.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                    <Building2 className="h-3.5 w-3.5" /> Pickup at
                  </p>
                  {matchedBranches.map(({ key, office, count: branchCount }) => (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5"
                    >
                      <span className="flex min-w-0 items-center gap-2 truncate text-sm font-semibold text-[var(--ink-dark)]">
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
                        {office.label}
                      </span>
                      <span className="shrink-0 rounded-full bg-[var(--brand)]/10 px-2.5 py-0.5 text-xs font-bold text-[var(--brand-dark)]">
                        {branchCount}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="collector-name"
                    className="text-xs font-semibold uppercase tracking-widest text-[var(--ink)]/60"
                  >
                    Collector's full name <span className="text-[var(--accent-dark)]">*</span>
                  </label>
                  <span
                    className={`text-[10px] font-semibold tabular-nums ${
                      collectorName.length > COLLECTOR_NAME_MAX ? 'text-red-500' : 'text-slate-300'
                    }`}
                  >
                    {collectorName.length}/{COLLECTOR_NAME_MAX}
                  </span>
                </div>
                <div className="relative">
                  <Input
                    id="collector-name"
                    value={collectorName}
                    onChange={(e) => onCollectorNameChange(e.target.value)}
                    onBlur={() => {
                      setNameTouched(true)
                      onCollectorNameChange(collectorName.replace(/\s+/g, ' ').trim())
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleConfirmClick()
                    }}
                    placeholder="e.g. Juan Dela Cruz"
                    maxLength={COLLECTOR_NAME_MAX}
                    autoComplete="name"
                    aria-invalid={showNameError}
                    aria-describedby="collector-name-hint"
                    className={`h-14 rounded-xl bg-white pr-11 text-base font-semibold shadow-sm transition-all focus-visible:ring-2 ${
                      showNameError
                        ? 'border-red-300 focus-visible:border-red-400 focus-visible:ring-red-200'
                        : showNameSuccess
                          ? 'border-emerald-300 focus-visible:border-emerald-400 focus-visible:ring-emerald-200'
                          : 'border-slate-200 focus-visible:border-[var(--brand)] focus-visible:ring-[var(--brand)]/30'
                    }`}
                    autoFocus
                  />
                  {(showNameError || showNameSuccess) && (
                    <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2">
                      {showNameError ? (
                        <AlertCircle className="h-4.5 w-4.5 text-red-500" />
                      ) : (
                        <CheckCircle2 className="h-4.5 w-4.5 text-emerald-500" />
                      )}
                    </span>
                  )}
                </div>
                <p
                  id="collector-name-hint"
                  className={`text-[11px] font-medium ${showNameError ? 'text-red-500' : 'text-slate-400'}`}
                >
                  {showNameError ? nameValidation.message : 'This name is recorded against the reservation and checked on pickup.'}
                </p>
              </div>

              <IdRequirementNotice />

              <label
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                  showIdError ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white hover:border-[var(--brand-light)]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={idAcknowledged}
                  onChange={(e) => {
                    setIdAcknowledged(e.target.checked)
                    if (e.target.checked) setIdTouched(false)
                  }}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
                    idAcknowledged ? 'border-[var(--brand)] bg-[var(--brand)]' : 'border-slate-300 bg-white'
                  }`}
                >
                  {idAcknowledged && <Check className="h-3.5 w-3.5 text-white" />}
                </span>
                <span className={`text-xs font-semibold leading-snug ${showIdError ? 'text-red-600' : 'text-[var(--ink-dark)]'}`}>
                  I understand the collector must present one valid, original ID for verification at pickup.
                </span>
              </label>
              {showIdError && (
                <p className="-mt-2 flex items-center gap-1.5 text-[11px] font-medium text-red-500">
                  <AlertCircle className="h-3 w-3 shrink-0" /> Please confirm before continuing.
                </p>
              )}

              <div className="flex items-start gap-2.5 rounded-xl border border-[var(--accent)]/25 bg-[var(--accent-soft)] px-4 py-3">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-dark)]" />
                <p className="text-xs font-semibold leading-relaxed text-[var(--accent-dark)]">
                  Unclaimed reservations automatically expire after 1 hour and return to the available pool.
                </p>
              </div>

              {error && (
                <p className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-600 border border-red-100 scale-in">
                  <AlertCircle className="h-4 w-4 shrink-0" /> {error}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer — pinned, right-aligned on desktop, full-width on mobile */}
        <div className="flex shrink-0 flex-col-reverse gap-3 border-t border-slate-100 bg-white px-6 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-8">
          <button
            type="button"
            onClick={onCancel}
            disabled={reserving}
            className="rounded-xl px-5 py-3 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-[var(--ink-dark)] disabled:opacity-50 sm:py-2.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmClick}
            disabled={reserving || (nameTouched && !nameValidation.valid) || (idTouched && !idAcknowledged)}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-[var(--accent)]/30 transition-all hover:-translate-y-0.5 hover:bg-[var(--accent-dark)] disabled:transform-none disabled:opacity-60 sm:py-2.5"
          >
            {reserving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Confirm pickup
          </button>
        </div>
      </div>
    </div>
  )
}

function SummaryRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className="truncate text-base font-medium text-[var(--ink-dark)]" title={value || undefined}>
        {value}
      </span>
    </div>
  )
}

// ID-verification requirement — what the collector needs to physically
// bring to the branch. Shown before confirming (with an acknowledgment
// checkbox) and again on the success screen as a reminder.
function IdRequirementNotice({ variant = 'full' }) {
  const compact = variant === 'compact'
  return (
    <div
      className={`flex flex-col gap-2.5 rounded-xl border border-[var(--brand)]/25 bg-[var(--brand)]/5 ${
        compact ? 'px-3.5 py-3' : 'px-4 py-3.5'
      }`}
    >
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--brand-dark)]" />
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--brand-dark)]">
          Bring 1 valid ID for verification
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {ACCEPTED_IDS.map((id) => (
          <span key={id} className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--ink)]">
            <CreditCard className="h-3 w-3 shrink-0 text-[var(--brand)]" />
            {id}
          </span>
        ))}
      </div>
      {!compact && (
        <p className="text-[10.5px] font-medium leading-snug text-slate-500">
          ID must be original, unexpired, and government-issued. The name on the ID should match the collector's
          name on the reservation.
        </p>
      )}
    </div>
  )
}

// Live "time remaining" label — recomputes every 30s off the actual
// expires_at from the server, so it never drifts from the real deadline.
function useCountdown(expiresAt) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!expiresAt) return
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [expiresAt])

  if (!expiresAt) return null
  const diffMs = new Date(expiresAt).getTime() - now
  if (diffMs <= 0) return 'Expired'
  const mins = Math.max(1, Math.round(diffMs / 60000))
  return mins === 1 ? '1 minute' : `${mins} minutes`
}

function SuccessManifest({ info, onDismiss }) {
  const remaining = useCountdown(info.expiresAt)
  const matchedBranches = getOrderedBranches(info.branchCounts).filter((b) => b.count > 0)
  const isExpired = remaining === 'Expired'

  return (
    <div className="slide-up relative z-20 mb-8 overflow-hidden rounded-2xl border border-[var(--brand-light)] bg-white shadow-xl">
      <div className="h-1 w-full bg-gradient-to-r from-[var(--brand)] to-[var(--accent)]" />
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:gap-5 sm:p-6">
        <div className="flex items-center gap-4 sm:block">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--brand)] shadow-lg shadow-[var(--brand)]/30">
            <CheckCircle2 className="h-6 w-6 text-white" />
          </div>
          <h3 className="font-display text-lg font-extrabold text-[var(--ink-dark)] sm:hidden">
            {info.count} Check{info.count === 1 ? '' : 's'} Reserved
          </h3>
        </div>

        <div className="flex-1">
          <h3 className="hidden font-display text-xl font-extrabold text-[var(--ink-dark)] sm:block">
            {info.count} Check{info.count === 1 ? '' : 's'} Reserved
          </h3>
          <p className="mt-1 text-sm font-medium text-slate-600 sm:text-base">
            Assigned to{' '}
            <span className="font-semibold text-[var(--ink-dark)] bg-[var(--brand-light)]/50 px-2 py-0.5 rounded">
              {info.collectorName}
            </span>
            {info.bank && (
              <>
                {' '}from <span className="font-semibold text-[var(--ink-dark)]">{info.bank}</span>
              </>
            )}
            .
          </p>

          {matchedBranches.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {matchedBranches.map(({ key, office, count: branchCount }) => (
                <span
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600"
                >
                  <MapPin className="h-3 w-3 text-[var(--brand)]" />
                  {office.shortLabel || office.label}
                  <span className="text-[var(--brand-dark)]">· {branchCount}</span>
                </span>
              ))}
            </div>
          )}

          <div
            className={`mt-4 flex flex-wrap items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold border ${
              isExpired
                ? 'bg-red-50 text-red-600 border-red-100'
                : 'bg-[var(--accent-soft)] text-[var(--accent-dark)] border-[var(--accent)]/20'
            }`}
          >
            <Clock className="h-4 w-4 shrink-0" />
            {isExpired ? (
              <>This reservation has expired and returned to the available pool.</>
            ) : (
              <>
                Pick up within <span className="tabular-nums">{remaining}</span>
                {info.expiresAt ? ` (by ${new Date(info.expiresAt).toLocaleTimeString()})` : ''} or the
                reservation expires.
              </>
            )}
          </div>

          {!isExpired && <div className="mt-3"><IdRequirementNotice variant="compact" /></div>}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="self-start rounded-full bg-slate-100 p-2.5 text-slate-500 transition hover:bg-slate-200 hover:text-[var(--ink-dark)]"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
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
          ? 'Tap "View available checks" above to see what\u2019s ready.'
          : 'Select a bank and enter the payee and payor details above to locate items available for pickup.'}
      </p>
    </div>
  )
}