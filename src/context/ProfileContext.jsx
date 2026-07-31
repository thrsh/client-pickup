// src/context/ProfileContext.jsx
//
// Single source of truth for "who is signed in and what's their role".
// Fetches the caller's `profiles` row once per session so every consumer
// of useProfile() agrees on the same value at the same time.
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'

const ProfileContext = createContext(null)

// profiles.branch is *supposed* to hold the DB-safe enum token
// ('csba_parqal', 'csba_bgc', 'all_branches'), while checks.pickup_branch
// stores the human-readable label ('CSBA - PARQAL', 'CSBA - BGC'). In
// practice the value that ends up in profiles.branch isn't always in that
// exact shape — it may have been typed/selected as the human label, with
// different casing, spacing, or dashes ('CSBA - Parqal', 'csba-parqal',
// 'CSBA_PARQAL', trailing whitespace, etc). Comparing any of those
// variants against the enum token directly fails silently and makes a
// correctly-configured profile look "unassigned". Everything below exists
// to make that resolution tolerant of formatting instead of exact-match-only.

const BRANCH_TOKEN_TO_PICKUP_BRANCH = {
  csba_parqal: 'CSBA - PARQAL',
  csba_bgc: 'CSBA - BGC',
}

const KNOWN_PICKUP_BRANCHES = ['CSBA - PARQAL', 'CSBA - BGC']

/** 'CSBA - Parqal' / 'csba-parqal' / '  CSBA_PARQAL ' -> 'csba_parqal' */
function normalizeBranchToken(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * Resolves whatever is stored in profiles.branch to the canonical
 * checks.pickup_branch label, regardless of which format it was saved in.
 * Returns null (and logs) only if the value truly doesn't match anything
 * known — that's a real data problem worth surfacing, not a formatting one.
 */
function resolvePickupBranch(rawBranch) {
  const token = normalizeBranchToken(rawBranch)
  if (!token || token === 'all_branches') return null

  if (BRANCH_TOKEN_TO_PICKUP_BRANCH[token]) {
    return BRANCH_TOKEN_TO_PICKUP_BRANCH[token]
  }

  // Already stored in (or close to) the human-readable pickup_branch shape.
  const direct = KNOWN_PICKUP_BRANCHES.find((label) => normalizeBranchToken(label) === token)
  if (direct) return direct

  console.warn(
    `[ProfileContext] profiles.branch value "${rawBranch}" did not match any known branch ` +
      `(expected one of: ${Object.keys(BRANCH_TOKEN_TO_PICKUP_BRANCH).join(', ')}, or a pickup_branch label). ` +
      'Treating this profile as having no resolvable branch.',
  )
  return null
}

function resolveIsAllBranches(rawBranch, role) {
  if (role === 'admin') return true
  return normalizeBranchToken(rawBranch) === 'all_branches'
}

export function ProfileProvider({ children }) {
  const { session, loading: authLoading, user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const isMountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const userId = session?.user?.id || null

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const fetchProfile = useCallback(async (uid) => {
    const thisRequestId = ++requestIdRef.current
    setLoading(true)
    setError('')

    // maybeSingle(), not single(): zero rows (missing profile row, or an
    // RLS policy silently filtering it out) is an expected, distinct
    // outcome here, not a thrown "no rows" exception to swallow.
    const { data, error: err } = await supabase
      .from('profiles')
      .select('id, full_name, role, branch')
      .eq('id', uid)
      .maybeSingle()

    // If a newer fetch started (user changed) while this one was in
    // flight, drop this result instead of clobbering the newer state.
    if (!isMountedRef.current || thisRequestId !== requestIdRef.current) return

    if (err) {
      setError(err.message || 'Failed to load your profile.')
      setProfile(null)
    } else if (!data) {
      setError(
        "No profile record was found for your account (or you don't have permission to read it). " +
          "Ask an admin to add a row for you in the 'profiles' table with the correct role."
      )
      setProfile(null)
    } else {
      setProfile(data)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (authLoading) return
    if (!userId) {
      requestIdRef.current++
      setProfile(null)
      setError('')
      setLoading(false)
      return
    }
    fetchProfile(userId)
  }, [userId, authLoading, fetchProfile])

  const role = profile?.role || null
  const branch = profile?.branch || null
  const isAllBranches = resolveIsAllBranches(branch, role)
  // Canonical value to compare against checks.pickup_branch — use this
  // instead of the raw `branch` field anywhere you filter/join checks.
  const pickupBranch = isAllBranches ? null : resolvePickupBranch(branch)

  // Central branch-access check: admins and 'all_branches' profiles can
  // see every branch; everyone else must match on the resolved value.
  const canAccessBranch = useCallback(
    (checkPickupBranch) => {
      if (isAllBranches) return true
      if (!pickupBranch || !checkPickupBranch) return false
      return pickupBranch === checkPickupBranch
    },
    [isAllBranches, pickupBranch]
  )

  const value = {
    profile,
    role,
    name: profile?.full_name || user?.email || '',
    branch,
    pickupBranch,
    isAllBranches,
    canAccessBranch,
    id: profile?.id || userId || null,
    // True until both auth and (if signed in) the profile row have
    // resolved. Nothing downstream should make a role/branch decision
    // before this flips to false.
    loading: authLoading || (!!userId && loading),
    error,
    session,
    user,
    refresh: () => (userId ? fetchProfile(userId) : Promise.resolve()),
  }

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}

export function useProfile() {
  const ctx = useContext(ProfileContext)
  if (!ctx) {
    throw new Error('useProfile() must be used within a <ProfileProvider>. Wrap <App /> with it in main.jsx or App.jsx.')
  }
  return ctx
}

export function hasRole(role, allowed) {
  if (!allowed || allowed.length === 0) return true
  return allowed.includes(role)
}