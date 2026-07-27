import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import { recordLogout } from '../lib/adminAuditApi'

export function useAuth() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  // Centralized so every sign-out path (AdminLayout, Navbar, anywhere else)
  // goes through the same audit-logging + supabase.auth.signOut() sequence,
  // in the right order: record BEFORE the session is torn down, never after.
  const signOut = useCallback(async () => {
    const userId = session?.user?.id
    if (userId) {
      await recordLogout(userId).catch(() => {})
    }
    await supabase.auth.signOut()
  }, [session])

  return { session, loading, user: session?.user ?? null, signOut }
}