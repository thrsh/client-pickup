// src/context/ProfileContext.jsx
//
// Single source of truth for "who is signed in and what's their role".
// Fetches the caller's `profiles` row exactly ONCE per session — not once
// per component that happens to call useProfile() — so RequireRole and
// every page checking role are always looking at the same value at the
// same time. That eliminates the class of bug where one fetch resolves
// before another and they briefly disagree.
//
// Wrap the whole app in <ProfileProvider> (inside the router) once.
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'

const ProfileContext = createContext(null)

export function ProfileProvider({ children }) {
  const { session, loading: authLoading, user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const isMountedRef = useRef(true)
  const userId = session?.user?.id || null

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const fetchProfile = useCallback(async (uid) => {
    setLoading(true)
    setError('')

    // maybeSingle(), not single(): zero rows (missing profile row, or an
    // RLS policy silently filtering it out) is an expected, distinct
    // outcome here — not a thrown "no rows" exception to swallow.
    const { data, error: err } = await supabase
      .from('profiles')
      .select('id, full_name, role')
      .eq('id', uid)
      .maybeSingle()

    if (!isMountedRef.current) return

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
      setProfile(null)
      setError('')
      setLoading(false)
      return
    }
    fetchProfile(userId)
  }, [userId, authLoading, fetchProfile])

  const value = {
    profile,
    role: profile?.role || null,
    name: profile?.full_name || user?.email || '',
    // True until BOTH auth and (if signed in) the profile row have
    // resolved. Nothing downstream should make a role decision before
    // this flips to false.
    loading: authLoading || (!!userId && loading),
    error,
    session,
    user,
    refresh: () => userId && fetchProfile(userId),
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
