import { supabase } from './supabaseClient'

async function callRpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(error.message || `Failed to load ${name}`)
  return data
}

/**
 * Loads everything the admin dashboard needs in parallel. Each piece is
 * server-aggregated (see admin_dashboard_rpcs migration) so KPIs and charts
 * reflect the full dataset, not a capped page of raw rows.
 */
export async function getAdminDashboardData({
  trendDays = 14,
  actionDays = 30,
  topActorDays = 30,
  uploadTrendDays = 14,
  decisionDays = 30,
  recentUploadsLimit = 5,
} = {}) {
  const [
    stats,
    checksByStatus,
    activityByAction,
    activityByDay,
    topActors,
    checksByBank,
    pendingApprovalAging,
    uploadActivityByDay,
    decisionBreakdown,
    rolesBreakdown,
    recentUploads,
  ] = await Promise.all([
    callRpc('get_admin_dashboard_stats'),
    callRpc('get_checks_by_status'),
    callRpc('get_activity_by_action', { p_days: actionDays }),
    callRpc('get_activity_by_day', { p_days: trendDays }),
    callRpc('get_top_actors', { p_days: topActorDays, p_limit: 8 }),
    callRpc('get_checks_by_bank'),
    callRpc('get_pending_approval_aging'),
    callRpc('get_upload_activity_by_day', { p_days: uploadTrendDays }),
    callRpc('get_decision_breakdown', { p_days: decisionDays }),
    callRpc('get_roles_breakdown'),
    callRpc('get_recent_uploads', { p_limit: recentUploadsLimit }),
  ])

  return {
    stats,
    checksByStatus,
    activityByAction,
    activityByDay,
    topActors,
    checksByBank,
    pendingApprovalAging,
    uploadActivityByDay,
    decisionBreakdown,
    rolesBreakdown,
    recentUploads,
  }
}