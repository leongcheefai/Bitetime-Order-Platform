// tests/rls/helpers.js
// Builds Supabase clients for RLS integration tests.
// Credentials are injected via env vars (see `supabase status`).
import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = process.env.SUPABASE_URL
export const ANON_KEY = process.env.SUPABASE_ANON_KEY
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

/** True when all required env vars are present — use with describe.skipIf */
export const hasEnv = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY)

export function anonClient() {
  return createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
}

export function serviceClient() {
  return createClient(SUPABASE_URL!, SERVICE_KEY!, { auth: { persistSession: false } })
}

/**
 * Create a confirmed auth user via the service role, then sign them in with
 * the anon client and return the signed-in client.
 */
export async function makeUser(email: string, password: string) {
  const svc = serviceClient()
  // Delete any existing user with this email first (idempotent re-runs).
  const { data: existing } = await svc.auth.admin.listUsers()
  const prior = existing?.users?.find(u => u.email === email)
  if (prior) await svc.auth.admin.deleteUser(prior.id)

  await svc.auth.admin.createUser({ email, password, email_confirm: true })
  const client = anonClient()
  await client.auth.signInWithPassword({ email, password })
  return client
}
