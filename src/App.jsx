import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Navbar } from './components/Navbar'
import { ToastProvider } from './components/ui/toast'
import ProtectedRoute from './components/ProtectedRoute'
import RequireRole from './components/RequireRole'
import RoleHome from './components/RoleHome'
import VerifierLayout from './components/VerifierLayout' // renamed from AdminLayout
import ApproverLayout from './components/ApproverLayout'
import { useAuth } from './hooks/useAuth'
import { ProfileProvider } from './context/ProfileContext'

import PublicSearch from './pages/PublicSearch'
import PublicSearch1 from './pages/PublicSearch1'
import Login from './pages/Login' // shared login, was VerifierLogin/AdminLogin
import VerifierDashboard from './pages/verifier/VerifierDashboard' // renamed from admin/AdminDashboard
import VerifierUpload from './pages/verifier/VerifierUpload'
import VerifierChecks from './pages/verifier/VerifierChecks'
import VerifierPickups from './pages/verifier/VerifierPickups'
import VerifierReports from './pages/verifier/VerifierReports'
import VerifierQR from './pages/verifier/VerifierQR'
import ApproverDashboard from './pages/approver/ApproverDashboard'
import ApproverHome from './pages/approver/ApproverHome'
import ApproverHistory from './pages/approver/ApproverHistory'

// TODO: build these out for the real admin tier. This is a minimal scaffold
// so the /admin routes resolve to something instead of 404ing while you
// build the actual admin panel. Swap in real components/pages when ready.
import AdminDashboard from './pages/admin/AdminDashboard'
import AdminUsers from './pages/admin/AdminUsers';

export default function App() {
  const { user } = useAuth()

  return (
    // ProfileProvider fetches profiles.role ONCE per session and shares it
    // through context — RequireRole, RoleHome, Navbar, and every page
    // checking role all read the exact same value at the exact same time.
    <ProfileProvider>
      <ToastProvider>
        <div className="min-h-screen">
          <Navbar user={user} />
          <Routes>
            <Route path="/" element={<PublicSearch />} />
            <Route path="/collector" element={<PublicSearch1 />} />

            {/* One login for every role — admin, verifier, and approver
                accounts all sign in here. See Login.jsx: where someone
                ends up afterward is decided by their real profiles.role,
                not by anything in the URL. */}
            <Route path="/login" element={<Login />} />
            {/* Backward-compat: anyone with an old bookmarked/shared link
                to the previous per-role login paths still lands somewhere
                that works. */}
            <Route path="/admin/login" element={<Navigate to="/login" replace />} />
            <Route path="/verifier/login" element={<Navigate to="/login" replace />} />
            <Route path="/approver/login" element={<Navigate to="/login" replace />} />

            {/* Landing pad for anyone whose role doesn't match the area
                they hit — sends them to wherever they actually belong
                instead of the old fixed-string redirectTo ping-pong. */}
            <Route
              path="/role-home"
              element={
                <ProtectedRoute>
                  <RoleHome />
                </ProtectedRoute>
              }
            />

            <Route
              path="/verifier"
              element={
                <ProtectedRoute>
                  <RequireRole role="verifier" redirectTo="/role-home">
                    <VerifierLayout />
                  </RequireRole>
                </ProtectedRoute>
              }
            >
              <Route index element={<VerifierDashboard />} />
              <Route path="upload" element={<VerifierUpload />} />
              <Route path="checks" element={<VerifierChecks />} />
              <Route path="pickups" element={<VerifierPickups />} />
              <Route path="reports" element={<VerifierReports />} />
              <Route path="qr" element={<VerifierQR />} />
            </Route>

            {/* Reserved for the real admin tier (oversees verifiers/approvers).
                Once you seed an admin profile row and build real pages, just
                swap the element below for your admin layout/pages. */}
            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <RequireRole role="admin" redirectTo="/role-home">
                    <AdminDashboard />
                  </RequireRole>
                </ProtectedRoute>
              }
            />

            <Route
              path="/approver"
              element={
                <ProtectedRoute>
                  {/* roles (plural) lets verifiers reach the approver area too,
                      e.g. to cover for someone — drop 'verifier' here if you
                      want approver strictly separate. Admins are intentionally
                      NOT included here; give admins that access explicitly
                      if/when you want it. */}
                  <RequireRole roles={['approver']} redirectTo="/role-home">
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