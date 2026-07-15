import React, { useEffect, useRef, useState } from 'react'
import {
  Search,
  X,
  MapPin,
  ArrowRight,
  Clock,
  Navigation,
  Frown,
  Sparkles
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Input } from '../components/ui/input'

const SUGGESTION_MIN_CHARS = 3
const MAX_RESULTS = 500

export default function PublicSearch() {
  const [payeeQuery, setPayeeQuery] = useState('')
  const [payorQuery, setPayorQuery] = useState('')
  const [matchedCount, setMatchedCount] = useState(0)
  const [loading, setLoading] = useState(false)

  const [payeeSuggestions, setPayeeSuggestions] = useState([])
  const [showPayeeSuggestions, setShowPayeeSuggestions] = useState(false)
  const payeeBoxRef = useRef(null)

  const [payorSuggestions, setPayorSuggestions] = useState([])
  const [showPayorSuggestions, setShowPayorSuggestions] = useState(false)
  const payorBoxRef = useRef(null)

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
  }, [payeeQuery])

  useEffect(() => {
    const term = payorQuery.trim()
    if (!term) {
      setPayorSuggestions([])
      setShowPayorSuggestions(false)
      return
    }
    const handle = setTimeout(() => fetchSuggestions('payor', term), 200)
    return () => clearTimeout(handle)
  }, [payorQuery])

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

  // Search logic and Supabase queries (read-only: no reservation RPCs)
  async function fetchMatchCount(payeeTerm, payorTerm) {
    const payee = payeeTerm.trim()
    const payor = payorTerm.trim()

    if (!payee && !payor) {
      setMatchedCount(0)
      setLoading(false)
      return
    }

    setLoading(true)

    let req = supabase
      .from('checks')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'available')
      .limit(MAX_RESULTS)

    if (payee) req = req.ilike('payee', `%${payee}%`)
    if (payor) req = req.ilike('payor', payor)

    const { count: total, error } = await req

    if (!error) {
      setMatchedCount(total || 0)
    }
    setLoading(false)
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

    const { data, error } = await supabase
      .from('checks')
      .select(field)
      .eq('status', 'available')
      .ilike(field, `%${lowerTerm}%`)
      .limit(20)

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
    if (!payeeQuery.trim() || !payorQuery.trim()) return
    setShowPayeeSuggestions(false)
    setShowPayorSuggestions(false)
    fetchMatchCount(payeeQuery, payorQuery)
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
    setPayeeQuery('')
    setPayorQuery('')
    setPayeeSuggestions([])
    setPayorSuggestions([])
    setShowPayeeSuggestions(false)
    setShowPayorSuggestions(false)
    setMatchedCount(0)
  }

  const hasQueryText = !!(payeeQuery.trim() && payorQuery.trim())

  return (
    <div className="psp-page rider-app min-h-screen pb-16 relative overflow-hidden">
      <PageStyles />
      <BackgroundGeometry />

      <div className="relative z-10">
        <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6 sm:pt-10">
          <Hero />

          {/* Symmetrical Floating Rider Search Dock */}
          <div className="relative z-20 -mt-8 mb-10 mx-auto max-w-4xl rounded-2xl bg-white p-2 shadow-[0_12px_36px_rgba(13,148,136,0.14)] ring-1 ring-slate-100 sm:-mt-12">
            <div className="rounded-xl bg-slate-50 p-6 sm:p-8">
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
                {(payeeQuery || payorQuery) && (
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
                  className="group flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-8 py-4 text-base font-semibold text-white shadow-lg shadow-[var(--accent)]/30 transition-all hover:-translate-y-0.5 hover:bg-[var(--accent-dark)] hover:shadow-[var(--accent)]/50 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none sm:w-auto"
                >
                  Check availability
                  <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                </button>
              </div>
            </div>
          </div>

          {/* Results area */}
          <div className="mx-auto max-w-4xl relative z-10">
            {!hasQueryText ? (
              <PromptState />
            ) : (
              <ManifestCountCard loading={loading} count={matchedCount} payee={payeeQuery} payor={payorQuery} />
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
      }

      .dot-pattern {
        background-image: radial-gradient(var(--brand-light) 2px, transparent 2px);
        background-size: 24px 24px;
      }
      .dot-pattern-gray {
        background-image: radial-gradient(#e2e8f0 2px, transparent 2px);
        background-size: 24px 24px;
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
            Check
            <br />
            <span className="text-[var(--accent)]">Availability</span>
          </h1>
          <p className="mt-6 max-w-sm text-base font-medium leading-relaxed text-[var(--brand-light)]">
            Enter the details below to instantly see whether a check is ready at the depot. No login required.
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
        <div className="h-72 w-72 rounded-full bg-[var(--brand-light)]/40 blur-3xl"></div>
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

function ManifestCountCard({ loading, count, payee, payor }) {
  const displayCount = useCountUp(count, !loading)

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
            We searched high and low, but couldn't find anything for <span className="font-semibold text-slate-700">"{payee}"</span> and <span className="font-semibold text-slate-700">"{payor}"</span>.
          </p>
          <div className="mt-6 rounded-lg bg-white px-4 py-2 text-xs font-semibold uppercase tracking-widest text-slate-400 shadow-sm border border-slate-100">
            Try double-checking spelling
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="slide-up relative overflow-hidden rounded-2xl bg-white shadow-xl border border-[var(--brand-light)]">
      <div className="absolute top-0 h-1.5 w-full bg-gradient-to-r from-[var(--brand)] to-[var(--accent)]"></div>

      <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-[var(--brand-light)] opacity-40 blur-3xl pointer-events-none"></div>
      <div className="absolute -right-20 -bottom-20 h-64 w-64 rounded-full bg-[var(--accent-soft)] opacity-40 blur-3xl pointer-events-none"></div>

      <div className="relative z-10 flex flex-col items-center px-6 py-14 text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-[var(--brand)]/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-[var(--brand-dark)]">
          <Sparkles className="h-4 w-4" /> Scan successful
        </div>

        <h2 className="font-display text-3xl font-extrabold text-[var(--ink-dark)] mt-2">
          Checks available
        </h2>

        <div className="my-6">
          <span className="font-display text-7xl font-extrabold tabular-nums text-[var(--brand)]">
            {displayCount}
          </span>
        </div>

        <div className="flex flex-col items-center gap-3 mt-2 w-full">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Check details</p>
          <div className="w-full max-w-md grid grid-cols-2 gap-0 rounded-xl bg-slate-50 shadow-inner border border-slate-200 overflow-hidden">
            <div className="flex flex-col items-center gap-1 px-5 py-4 border-r border-slate-200">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Payee
              </span>
              <span className="text-sm font-semibold text-[var(--ink)] text-center break-words">{payee}</span>
            </div>
            <div className="flex flex-col items-center gap-1 px-5 py-4">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Payor
              </span>
              <span className="text-sm font-semibold text-[var(--ink)] text-center break-words">{payor}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <Clock className="h-3.5 w-3.5" />
            Queried {new Date().toLocaleString()}
          </div>
        </div>
      </div>
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
        Enter the payee and payor details above to check whether items are available for pickup at the depot.
      </p>
    </div>
  )
}