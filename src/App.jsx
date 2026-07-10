import React from 'react'
import { Routes, Route } from 'react-router-dom'
import { Navbar } from './components/Navbar'
import { ToastProvider } from './components/ui/toast'
import ProtectedRoute from './components/ProtectedRoute'
import AdminLayout from './components/AdminLayout'
import { useAuth } from './hooks/useAuth'

import PublicSearch from './pages/PublicSearch'
import AdminLogin from './pages/AdminLogin'
import AdminDashboard from './pages/admin/AdminDashboard'
import AdminUpload from './pages/admin/AdminUpload'
import AdminChecks from './pages/admin/AdminChecks'
import AdminPickups from './pages/admin/AdminPickups'
import AdminReports from './pages/admin/AdminReports'
import AdminQR from './pages/admin/AdminQR'

export default function App() {
  const { user } = useAuth()

  return (
    <ToastProvider>
      <div className="min-h-screen">
        <Navbar user={user} />
        <Routes>
          <Route path="/" element={<PublicSearch />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route
            path="/admin"
            element={
              <ProtectedRoute>
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<AdminDashboard />} />
            <Route path="upload" element={<AdminUpload />} />
            <Route path="checks" element={<AdminChecks />} />
            <Route path="pickups" element={<AdminPickups />} />
            <Route path="reports" element={<AdminReports />} />
            <Route path="qr" element={<AdminQR />} />
          </Route>
          <Route path="*" element={<PublicSearch />} />
        </Routes>
      </div>
    </ToastProvider>
  )
}
