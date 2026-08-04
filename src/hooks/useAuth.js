import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import { recordLogout } from '../lib/adminAuditApi'
import {
  isRecoverySessionActive,
  clearRecoverySessionActive,
  subscribeToRecoverySessionChange,
} from '../lib/recoverySession'

export function useAuth() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [isRecoverySession, setIsRecoverySession] = useState(isRecoverySessionActive)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      // The only event that should ever lift the recovery restriction —
      // proves the session was actually torn down, not just that a new
      // one was issued (recovery links can also emit SIGNED_IN depending
      // on client version, so clearing on SIGNED_IN would reopen the gap).
      if (event === 'SIGNED_OUT') {
        clearRecoverySessionActive()
      }
    })

    const unsubscribe = subscribeToRecoverySessionChange(() => {
      setIsRecoverySession(isRecoverySessionActive())
    })

    return () => {
      listener.subscription.unsubscribe()
      unsubscribe()
    }
  }, [])

  const signOut = useCallback(async () => {
    const userId = session?.user?.id
    if (userId) {
      await recordLogout(userId).catch(() => {})
    }
    await supabase.auth.signOut()
  }, [session])

  return {
    session,
    loading,
    user: session?.user ?? null,
    isRecoverySession,
    signOut,
  }
}