// tests/rls/billing-grant.test.ts
// Belt on top of the code path: after the revoke, a browser (anon or authenticated) client
// cannot SELECT merchant_billing directly at all. If this ever passes with rows, the grant
// crept back and the API is no longer the only door.
import { describe, it, expect } from 'vitest'
import { anonClient, makeUser, seedMerchant, serviceClient } from './helpers.js'

describe('merchant_billing is not directly readable by the browser', () => {
  it('denies an anonymous SELECT', async () => {
    const { data, error } = await anonClient().from('merchant_billing').select('*')
    // A revoked grant surfaces as a permission error (or, at minimum, zero rows).
    expect(error !== null || (data ?? []).length === 0).toBe(true)
    if (error) expect(error.message.toLowerCase()).toContain('permission denied')
  })

  it('denies an authenticated SELECT even for the merchant owner', async () => {
    // A plain non-owner authenticated user is a weak fixture here: the
    // merchant_billing_read RLS policy already returns zero rows for them
    // regardless of the table grant, so that case can't tell a revoked grant
    // apart from a working one. Use the merchant OWNER instead — RLS *would*
    // let them read their own billing row, so the only thing that can still
    // stop them is the table-level REVOKE from the migration. Postgres checks
    // table privileges before RLS, so a revoked SELECT denies the owner too.
    const owner = await makeUser('billing-grant-owner@example.com', 'password123')
    const { data: session } = await owner.auth.getSession()
    const ownerId = session.session!.user.id
    const merchantId = await seedMerchant({ slug: 'billing-grant-shop', owner_id: ownerId })
    const { error: seedError } = await serviceClient()
      .from('merchant_billing')
      .insert({ merchant_id: merchantId, status: 'active' })
    if (seedError) throw new Error(`seeding merchant_billing: ${seedError.message}`)

    const { data, error } = await owner.from('merchant_billing').select('*').eq('merchant_id', merchantId)

    // This owner would pass RLS, so a non-error (or empty-row) result means the
    // SELECT grant crept back onto `authenticated` — the test must fail in that
    // case, which the old `error !== null || rows.length === 0` form silently
    // allowed (an RLS-only denial for a non-owner also satisfies that OR).
    expect(error).not.toBeNull()
    expect(error?.code === '42501' || error?.message.toLowerCase().includes('permission denied')).toBe(true)
    expect(data).toBeNull()
  })
})
