import { supabase } from './supabaseClient'

async function callRpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(error.message || `Failed to load ${name}`)
  return data
}

export async function getDatabaseSizeStats() {
  return callRpc('get_database_size_stats')
}

export async function getUserDetail(userId) {
  if (!userId) throw new Error('userId is required')
  return callRpc('get_user_detail', { p_user_id: userId })
}

export async function getUserActivityTimeline(userId, limit = 50) {
  if (!userId) throw new Error('userId is required')
  return callRpc('get_user_activity_timeline', { p_user_id: userId, p_limit: limit })
}

/** Combined fetch for the user detail drawer. */
export async function getUserInsights(userId) {
  const [detail, timeline] = await Promise.all([
    getUserDetail(userId),
    getUserActivityTimeline(userId, 50),
  ])
  return { detail, timeline }
}

export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}