// tests/rls/helpers.ts
// Builds Supabase clients for the DB-backed suites (tests/rls and tests/api).
// Credentials come from env vars, which vitest.db.config.ts fills in from the
// running local stack when they are not already set.
import { createClient } from '@supabase/supabase-js'

/**
 * Missing credentials are a hard failure, never a skip. This suite is the only
 * proof that an order cannot be spoofed onto a stranger's account; a version of
 * it that quietly asserts nothing and still reports green is worse than no suite
 * at all, because it is trusted.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set, so the RLS suite cannot reach a database. It must fail rather than skip. ` +
        `Run it via \`pnpm test:db\`, which reads the local stack's credentials for you.`,
    )
  }
  return value
}

export const SUPABASE_URL = required('SUPABASE_URL')
export const ANON_KEY = required('SUPABASE_ANON_KEY')
export const SERVICE_KEY = required('SUPABASE_SERVICE_ROLE_KEY')

export function anonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
}

export function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
}

export type MerchantStatus = 'pending' | 'active' | 'suspended'

/**
 * These helpers DELETE rows with the service role, which bypasses RLS. Pointed
 * at a real project they would destroy live orders, so refuse to run anywhere
 * but a local Supabase.
 */
function assertLocal() {
  const host = new URL(SUPABASE_URL).hostname
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
  for (const table of ['orders', 'products', 'merchant_secrets', 'order_counters', 'vouchers', 'settings', 'merchant_feedback']) {
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

/** Seed one product for a merchant. Returns its id. */
export async function seedProduct(fields: {
  merchant_id: string
  name?: string
  price: number
  active?: boolean
}) {
  const { data, error } = await serviceClient()
    .from('products')
    .insert({
      merchant_id: fields.merchant_id,
      name: fields.name ?? 'Matcha Cookie',
      price: fields.price,
      active: fields.active ?? true,
    })
    .select('id')
    .single()
  if (error) throw new Error(`seeding product: ${error.message}`)
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
