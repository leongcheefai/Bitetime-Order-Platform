import { createClient } from '@supabase/supabase-js'
import { env } from './env.js'

// Service-role client: bypasses RLS. Used for all writes (webhook) and for
// loading a merchant by owner during checkout. Never expose this key client-side.
export const admin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Anon client: only used to verify a caller's JWT via auth.getUser(token).
const anon = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Resolve a Supabase access token to its user, or null if invalid/expired.
export async function getUserFromToken(token: string | null | undefined) {
  if (!token) return null
  const { data, error } = await anon.auth.getUser(token)
  if (error) return null
  return data.user ?? null
}
