import React from 'react'
import { Routes, Route } from 'react-router-dom'
import { Navbar } from './components/Navbar'
import { ToastProvider } from './components/ui/toast'
import ProtectedRoute from './components/ProtectedRoute'
import RequireRole from './components/RequireRole'
import AdminLayout from './components/AdminLayout'
import ApproverLayout from './components/ApproverLayout'
import { useAuth } from './hooks/useAuth'
import { ProfileProvider } from './context/ProfileContext'

import PublicSearch from './pages/PublicSearch'
import PublicSearch1 from './pages/PublicSearch1'
import AdminLogin from './pages/AdminLogin'
import AdminDashboard from './pages/admin/AdminDashboard'
import AdminUpload from './pages/admin/AdminUpload'
import AdminChecks from './pages/admin/AdminChecks'
import AdminPickups from './pages/admin/AdminPickups'
import AdminReports from './pages/admin/AdminReports'
import AdminQR from './pages/admin/AdminQR'
import ApproverDashboard from './pages/approver/ApproverDashboard'
import ApproverHome from './pages/approver/ApproverHome'
import ApproverHistory from './pages/approver/ApproverHistory'

export default function App() {
  const { user } = useAuth()

  return (
    // ProfileProvider fetches profiles.role ONCE per session and shares it
    // through context — RequireRole, Navbar, and every approver page all
    // read the exact same value at the exact same time. No more races
    // between independent fetches disagreeing with each other mid-render.
    <ProfileProvider>
      <ToastProvider>
        <div className="min-h-screen">
          <Navbar user={user} />
          <Routes>
            <Route path="/" element={<PublicSearch />} />
            <Route path="/collector" element={<PublicSearch1 />} />
            <Route path="/admin/login" element={<AdminLogin />} />

            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <RequireRole role="admin" redirectTo="/approver">
                    <AdminLayout />
                  </RequireRole>
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

            <Route
              path="/approver"
              element={
                <ProtectedRoute>
                  {/* roles (plural) lets admins reach the approver area too,
                      e.g. to cover for someone — drop 'admin' here if you
                      want approver strictly separate from admin. */}
                  <RequireRole roles={['approver']} redirectTo="/admin">
                    <ApproverLayout />
                  </RequireRole>
                </ProtectedRoute>
              }
            >
              <Route index element={<ApproverDashboard />} />
              <Route path="pending" element={<ApproverHome />} />
              <Route path="history" element={<ApproverHistory />} />
            </Route>

            <Route path="*" element={<PublicSearch />} />
          </Routes>
        </div>
      </ToastProvider>
    </ProfileProvider>
  )
}