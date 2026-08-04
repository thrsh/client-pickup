import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Navbar } from './components/Navbar'
import { ToastProvider } from './components/ui/toast'
import ProtectedRoute from './components/ProtectedRoute'
import RequireRole from './components/RequireRole'
import RoleHome from './components/RoleHome'
import VerifierLayout from './components/VerifierLayout'
import ApproverLayout from './components/ApproverLayout'
import AdminLayout from './components/AdminLayout'
import { useAuth } from './hooks/useAuth'
import { ProfileProvider } from './context/ProfileContext'

import PublicSearch from './pages/PublicSearch'
import PublicSearch1 from './pages/PublicSearch1'
import Login from './pages/Login'
import ResetPassword from './pages/ResetPassword'
import VerifierDashboard from './pages/verifier/VerifierDashboard'
import VerifierUpload from './pages/verifier/VerifierUpload'
import VerifierChecks from './pages/verifier/VerifierChecks'
import VerifierPickups from './pages/verifier/VerifierPickups'
import VerifierReports from './pages/verifier/VerifierReports'
import VerifierQR from './pages/verifier/VerifierQR'
import VerifierAccount from './pages/verifier/VerifierAccount'
import ApproverDashboard from './pages/approver/ApproverDashboard'
import ApproverHome from './pages/approver/ApproverHome'
import ApproverHistory from './pages/approver/ApproverHistory'
import ApproverBillingReport from './pages/approver/ApproverBillingReport'
import ApproverAccount from './pages/approver/ApproverAccount'

import AdminDashboard from './pages/admin/AdminDashboard'
import AdminUsers from './pages/admin/AdminUsers'
import AdminAuditTrail from './pages/admin/AdminAuditTrail'
import AdminReports from './pages/admin/AdminReports'
import AdminAccount from './pages/admin/AdminAccount'

export default function App() {
  const { user } = useAuth()

  return (
    // ProfileProvider resolves profiles.role once per session so
    // RequireRole, RoleHome, and Navbar all read the same value.
    <ProfileProvider>
      <ToastProvider>
        <div className="min-h-screen">
          <Navbar user={user} />
          <Routes>
            <Route path="/" element={<PublicSearch />} />
            <Route path="/collector" element={<PublicSearch1 />} />

            {/* Shared login for all roles; destination is decided by
                profiles.role, not the URL. */}
            <Route path="/login" element={<Login />} />
            <Route path="/admin/login" element={<Navigate to="/login" replace />} />
            <Route path="/verifier/login" element={<Navigate to="/login" replace />} />
            <Route path="/approver/login" element={<Navigate to="/login" replace />} />

            {/* Public: only a short-lived Supabase recovery session exists
                here, not a full authenticated session — must stay outside
                ProtectedRoute/RequireRole. */}
            <Route path="/reset-password" element={<ResetPassword />} />

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
              <Route path="account" element={<VerifierAccount />} />
            </Route>

            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <RequireRole role="admin" redirectTo="/role-home">
                    <AdminLayout />
                  </RequireRole>
                </ProtectedRoute>
              }
            >
              <Route index element={<AdminDashboard />} />
              <Route path="audit" element={<AdminAuditTrail />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="reports" element={<AdminReports />} />
              <Route path="account" element={<AdminAccount />} />
            </Route>

            <Route
              path="/approver"
              element={
                <ProtectedRoute>
                  {/* 'verifier' included so verifiers can cover the approver
                      area; admins are deliberately excluded unless you add
                      that access explicitly. */}
                  <RequireRole roles={['approver', 'verifier']} redirectTo="/role-home">
                    <ApproverLayout />
                  </RequireRole>
                </ProtectedRoute>
              }
            >
              <Route index element={<ApproverDashboard />} />
              <Route path="pending" element={<ApproverHome />} />
              <Route path="history" element={<ApproverHistory />} />
              <Route path="billing-report" element={<ApproverBillingReport />} />
              <Route path="account" element={<ApproverAccount />} />
            </Route>

            <Route path="*" element={<PublicSearch />} />
          </Routes>
        </div>
      </ToastProvider>
    </ProfileProvider>
  )
}