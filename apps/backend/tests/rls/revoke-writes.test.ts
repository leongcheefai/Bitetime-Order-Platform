// tests/rls/revoke-writes.test.ts
// Phase B terminal backstop: after 20260718130000_revoke_all_browser_grants.sql, an
// authenticated browser client cannot write ANY table directly — every write goes through the
// backend's service-role client instead. The merchant OWNER is the fixture in every case: RLS
// would otherwise ALLOW their own rows, so a plain non-owner can't tell "denied by RLS" apart
// from "denied by the grant". Postgres checks table privileges before RLS, so the owner is the
// only fixture that isolates the REVOKE — exactly as tests/rls/billing-grant.test.ts established
// for merchant_billing in Phase A.
import { describe, it, expect } from 'vitest'
import { makeUser, seedMerchant, serviceClient } from './helpers.js'

const PERMISSION_DENIED = '42501'

function isPermissionDenied(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === PERMISSION_DENIED || (error.message ?? '').toLowerCase().includes('permission denied')
}

describe('browser roles hold no table grants after Phase B', () => {
  it('denies an authenticated owner a direct UPDATE on their own merchants row', async () => {
    const owner = await makeUser('revoke-merchants@example.com', 'password123')
    const { data: session } = await owner.auth.getSession()
    const ownerId = session.session!.user.id
    const id = await seedMerchant({ slug: 'revoke-merchants-shop', owner_id: ownerId })

    const { error } = await owner.from('merchants').update({ name: 'hacked' }).eq('id', id)

    expect(error).not.toBeNull()
    expect(isPermissionDenied(error)).toBe(true)
  })

  it('denies an authenticated INSERT on products under the owner\'s own merchant', async () => {
    const owner = await makeUser('revoke-products@example.com', 'password123')
    const { data: session } = await owner.auth.getSession()
    const ownerId = session.session!.user.id
    const id = await seedMerchant({ slug: 'revoke-products-shop', owner_id: ownerId })

    const { error } = await owner
      .from('products')
      .insert({ merchant_id: id, name: 'Matcha Cookie', price: 5, unit: 'pcs' })

    expect(error).not.toBeNull()
    expect(isPermissionDenied(error)).toBe(true)
  })

  it('denies an authenticated UPDATE on the owner\'s own profile row', async () => {
    const owner = await makeUser('revoke-profiles@example.com', 'password123')
    const { data: session } = await owner.auth.getSession()
    const ownerId = session.session!.user.id
    // Idempotent re-run: makeUser reuses the same auth user across runs if the prior
    // deleteUser silently no-ops (FK from profiles blocks a hard delete), so clear any
    // global profile left over from a previous run before seeding a fresh one.
    await serviceClient().from('profiles').delete().eq('user_id', ownerId).is('merchant_id', null)
    const { error: seedError } = await serviceClient()
      .from('profiles')
      .insert({ user_id: ownerId, name: 'Owner', merchant_id: null })
    if (seedError) throw new Error(`seeding profile: ${seedError.message}`)

    const { error } = await owner.from('profiles').update({ name: 'hacked' }).eq('user_id', ownerId).is('merchant_id', null)

    expect(error).not.toBeNull()
    expect(isPermissionDenied(error)).toBe(true)
  })

  it('denies an authenticated INSERT on vouchers under the owner\'s own merchant', async () => {
    const owner = await makeUser('revoke-vouchers@example.com', 'password123')
    const { data: session } = await owner.auth.getSession()
    const ownerId = session.session!.user.id
    const id = await seedMerchant({ slug: 'revoke-vouchers-shop', owner_id: ownerId })

    const { error } = await owner
      .from('vouchers')
      .insert({ merchant_id: id, code: 'HACKED', kind: 'flat', amount: 5 })

    expect(error).not.toBeNull()
    expect(isPermissionDenied(error)).toBe(true)
  })

  it('denies an authenticated UPDATE on orders under the owner\'s own merchant', async () => {
    const owner = await makeUser('revoke-orders@example.com', 'password123')
    const { data: session } = await owner.auth.getSession()
    const ownerId = session.session!.user.id
    const id = await seedMerchant({ slug: 'revoke-orders-shop', owner_id: ownerId })
    const { data: order, error: seedError } = await serviceClient()
      .from('orders')
      .insert({ merchant_id: id, status: 'new', order_number: 'RV-260718-0050' })
      .select('id')
      .single()
    if (seedError) throw new Error(`seeding order: ${seedError.message}`)

    const { error } = await owner.from('orders').update({ status: 'preparing' }).eq('id', order!.id)

    expect(error).not.toBeNull()
    expect(isPermissionDenied(error)).toBe(true)
  })
})
