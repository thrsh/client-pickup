import React from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { LogOut, LayoutDashboard, User } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Button } from './ui/button'

export function Navbar({ user }) {
  const location = useLocation()
  const navigate = useNavigate()
  const isAdminArea = location.pathname.startsWith('/admin') && location.pathname !== '/admin/login'

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/admin/login')
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b border-gray-200 bg-white/90 backdrop-blur-md shadow-sm transition-all duration-200">
      <div className="mx-auto flex h-16 sm:h-20 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        
        {/* Logo and Title */}
        <Link to="/" className="flex items-center gap-3 sm:gap-4 transition-opacity hover:opacity-90">
          <img 
            src="https://csba.ph/logo.png" 
            alt="CSBA Logo" 
            className="h-8 w-8 sm:h-10 sm:w-10 object-contain drop-shadow-sm" 
          />
          <div className="flex flex-col justify-center">
            <span className="text-base font-bold tracking-tight text-teal-700 sm:text-xl">
              Check Pickup Register
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-600 sm:text-xs">
              Disbursement Ledger
            </span>
          </div>
        </Link>

        {/* Navigation */}
        <nav className="flex items-center gap-3 sm:gap-4">
          {isAdminArea && user && (
            <>
              {/* User Email Pill - Hidden on Mobile, Visible on Desktop */}
              <div className="hidden md:flex items-center gap-2 rounded-full border border-gray-100 bg-gray-50 px-3 py-1.5 text-sm text-gray-600">
                <User className="h-4 w-4 text-gray-400" />
                <span className="max-w-[150px] truncate font-medium">{user.email}</span>
              </div>
              
              <Button
                variant="outline"
                size="sm"
                className="flex items-center gap-2 border-orange-200 text-orange-600 transition-colors hover:bg-orange-50 hover:text-orange-700"
                onClick={handleSignOut}
              >
                <LogOut className="h-4 w-4" />
                {/* Hide text on very small screens to save space */}
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </>
          )}
          
          {!isAdminArea && (
            <Link to="/admin/login">
              <Button
                variant="outline"
                size="sm"
                className="flex items-center gap-2 border-teal-200 text-teal-700 transition-colors hover:bg-teal-50 hover:text-teal-800"
              >
                <LayoutDashboard className="h-4 w-4" />
                <span className="hidden sm:inline">Admin Portal</span>
              </Button>
            </Link>
          )}
        </nav>
      </div>
    </header>
  )
}