import React from 'react'
import { ShieldCheck } from 'lucide-react'

// TODO: replace with the real admin layout/dashboard once it's built.
// This exists purely so an authenticated admin landing on /admin sees
// something sensible instead of a blank page or a dead route.
export default function AdminComingSoon() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <ShieldCheck className="h-10 w-10 text-teal-600" />
      <h1 className="text-xl font-semibold text-gray-800">Admin panel coming soon</h1>
      <p className="max-w-sm text-sm text-gray-500">
        You're signed in with an admin account. This area is reserved for the upcoming admin
        panel — build it out here.
      </p>
    </div>
  )
}