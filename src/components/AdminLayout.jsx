import React from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import {
  LayoutGrid,
  UploadCloud,
  ListChecks,
  Clock,
  BarChart3,
  QrCode,
} from 'lucide-react'
import { cn } from '../lib/utils'

const links = [
  { to: '/admin', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/admin/upload', label: 'Upload file', icon: UploadCloud },
  { to: '/admin/checks', label: 'Checks register', icon: ListChecks },
  { to: '/admin/pickups', label: 'Pending pickups', icon: Clock },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3 },
  { to: '/admin/qr', label: 'QR code', icon: QrCode },
]

export default function AdminLayout() {
  return (
   <div className="flex gap-8 px-4 py-8 sm:px-6 lg:px-8 xl:px-10">
      
      {/* Desktop Sidebar */}
      <aside className="hidden w-56 shrink-0 md:block">
        <nav className="sticky top-28 flex flex-col gap-1.5">
          <div className="mb-2 px-4">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
              Administration
            </h2>
          </div>
          
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-3 rounded-r-lg border-l-4 px-4 py-2.5 text-sm font-medium transition-all duration-200',
                  !isActive && 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-teal-700',
                  isActive && 'border-orange-500 bg-teal-50 text-teal-900 shadow-sm'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={cn(
                      'h-4 w-4 transition-colors',
                      isActive ? 'text-orange-500' : 'text-gray-400 group-hover:text-teal-600'
                    )}
                  />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="w-full min-w-0">
        {/* Mobile Navigation */}
        <nav className="mb-6 flex gap-2 overflow-x-auto pb-2 md:hidden [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium transition-all shadow-sm',
                  !isActive && 'border-gray-200 bg-white text-gray-600 hover:border-teal-300 hover:text-teal-700',
                  isActive && 'border-teal-600 bg-teal-600 text-white shadow-teal-200'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={cn(
                      'h-3.5 w-3.5 transition-colors',
                      isActive ? 'text-orange-300' : 'text-gray-400'
                    )}
                  />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        
        {/* Page Content */}
        <div className="rounded-xl">
          <Outlet />
        </div>
      </div>
    </div>
  )
}