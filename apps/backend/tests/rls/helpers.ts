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

export type MerchantStatus = 'pending' | 'active' | 'suspended'

/**
 * These helpers DELETE rows with the service role, which bypasses RLS. Pointed
 * at a real project they would destroy live orders, so refuse to run anywhere
 * but a local Supabase.
 */
function assertLocal() {
  const host = new URL(SUPABASE_URL!).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `RLS fixtures delete data with the service role and must only run against a local Supabase. Refusing to touch ${host}.`,
    )
  }
}

/**
 * Drop a merchant and everything hanging off it, so a suite can be re-run
 * against a database that already has its fixtures in it. Without this the
 * unique slug collides, the insert quietly returns null, and the suite dies in
 * `beforeAll` with an unhelpful "cannot read properties of null".
 */
export async function resetMerchant(slug: string) {
  assertLocal()
  const svc = serviceClient()
  const { data } = await svc.from('merchants').select('id').eq('slug', slug).maybeSingle()
  if (!data) return
  // Children first — they carry FKs back to the merchant. Mirrors the
  // tenant-scoped tables in CLAUDE.md → Data layer; a new one means adding it here.
  for (const table of ['orders', 'products', 'merchant_secrets', 'order_counters', 'vouchers', 'settings']) {
    await svc.from(table).delete().eq('merchant_id', data.id)
  }
  await svc.from('merchants').delete().eq('id', data.id)
}

/** Seed a merchant, clearing any prior run's copy first. Returns its id. */
export async function seedMerchant(fields: {
  slug: string
  owner_id: string
  name?: string
  order_prefix?: string
  status?: MerchantStatus
}) {
  await resetMerchant(fields.slug)
  const { data, error } = await serviceClient()
    .from('merchants')
    .insert({
      slug: fields.slug,
      owner_id: fields.owner_id,
      name: fields.name ?? fields.slug,
      order_prefix: fields.order_prefix ?? 'XX',
      status: fields.status ?? 'active',
    })
    .select('id')
    .single()
  if (error) throw new Error(`seeding merchant ${fields.slug}: ${error.message}`)
  return data!.id as string
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
