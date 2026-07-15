// src/components/Navbar.jsx
//
// Same component as before, extended so the signed-in user chip + sign-out
// button also show inside /approver (previously only /admin), and so the
// chip shows the person's role, not just their email.
import React from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { LogOut, User } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Button } from './ui/button'
import { useProfile } from '../context/ProfileContext'

const PROTECTED_PREFIXES = ['/admin', '/approver']
const LOGIN_PATHS = ['/admin/login', '/approver/login']

const ROLE_LABELS = {
  admin: 'Admin',
  approver: 'Approver',
  collector: 'Collector',
}

export function Navbar({ user }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { role } = useProfile()

  const isProtectedArea =
    PROTECTED_PREFIXES.some((p) => location.pathname.startsWith(p)) &&
    !LOGIN_PATHS.includes(location.pathname)

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate(location.pathname.startsWith('/approver') ? '/approver/login' : '/admin/login')
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b border-teal-100 bg-white/80 shadow-[0_1px_0_0_rgba(13,148,136,0.06)] backdrop-blur-md transition-all duration-300">
      {/* Thin teal → orange accent line, the header's one signature detail */}
      <div className="h-[3px] w-full bg-gradient-to-r from-teal-500 via-teal-400 to-orange-400" />

      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:h-20 sm:px-6 lg:px-8">
        {/* Logo only — no frame, no container, just the mark itself */}
        <Link to="/" className="flex items-center" aria-label="Go to homepage">
          <img
            src="https://csba.ph/logo.png"
            alt="CSBA"
            className="h-[6.1875rem] w-[6.1875rem] object-contain transition-transform duration-300 ease-out hover:scale-105 sm:h-[7.875rem] sm:w-[7.875rem]"
          />
        </Link>

        {/* Navigation */}
        <nav className="flex items-center gap-2.5 sm:gap-3">
          {isProtectedArea && user && (
            <>
              <div className="hidden items-center gap-2 rounded-full border border-teal-100 bg-teal-50/70 px-3 py-1.5 text-sm text-teal-800 transition-colors duration-200 hover:bg-teal-50 md:flex">
                <User className="h-4 w-4 text-teal-500" />
                <span className="max-w-[150px] truncate font-medium">{user.email}</span>
                {role && (
                  <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-600 shadow-sm">
                    {ROLE_LABELS[role] || role}
                  </span>
                )}
              </div>

              <Button
                variant="outline"
                size="sm"
                className="group flex items-center gap-2 border-orange-200 bg-white text-orange-600 transition-all duration-200 hover:border-orange-300 hover:bg-orange-500 hover:text-white hover:shadow-md hover:shadow-orange-200/60"
                onClick={handleSignOut}
              >
                <LogOut className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}