import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, ShieldCheck, AlertCircle } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'

export default function AdminLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    navigate('/admin')
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center bg-gray-50/50 px-4 py-12 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md overflow-hidden border-0 shadow-xl sm:border sm:border-gray-100">
        {/* Corporate branding accent line at the top */}
        <div className="h-1 w-full bg-orange-500"></div>
        
        <CardHeader className="items-center text-center space-y-4 pt-8">
          {/* Logo and Security Icon Grouping */}
          <div className="flex flex-col items-center justify-center gap-3">
            <img 
              src="https://csba.ph/logo.png" 
              alt="CSBA Logo" 
              className="h-16 w-16 object-contain drop-shadow-sm" 
            />
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-50 text-teal-600 ring-4 ring-white">
              <ShieldCheck className="h-4 w-4" />
            </div>
          </div>
          
          <div className="space-y-1">
            <CardTitle className="text-2xl font-bold tracking-tight text-teal-800">
              Admin Portal
            </CardTitle>
            <CardDescription className="text-sm text-gray-500">
              Manage check uploads, pickups, and disbursements.
            </CardDescription>
          </div>
        </CardHeader>
        
        <CardContent className="pb-8 px-6 sm:px-8">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700">Email Address</label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@csba.ph"
                className="focus-visible:ring-teal-500 transition-shadow"
              />
            </div>
            
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700">Password</label>
              <Input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="focus-visible:ring-teal-500 transition-shadow"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600 animate-in fade-in slide-in-from-top-1">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <p>{error}</p>
              </div>
            )}

            <Button 
              type="submit" 
              disabled={loading} 
              className="mt-2 w-full bg-teal-600 text-white hover:bg-teal-700 focus-visible:ring-teal-500 transition-colors shadow-sm"
            >
              <Lock className="mr-2 h-4 w-4" />
              {loading ? 'Authenticating…' : 'Secure Sign In'}
            </Button>
          </form>
          
          <p className="mt-8 text-center text-xs text-gray-400">
            Authorized personnel only. Accounts are managed in the Supabase Auth dashboard.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}