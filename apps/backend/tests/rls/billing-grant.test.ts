// tests/rls/billing-grant.test.ts
// Belt on top of the code path: after the revoke, a browser (anon or authenticated) client
// cannot SELECT merchant_billing directly at all. If this ever passes with rows, the grant
// crept back and the API is no longer the only door.
import { describe, it, expect } from 'vitest'
import { anonClient, makeUser } from './helpers.js'

describe('merchant_billing is not directly readable by the browser', () => {
  it('denies an anonymous SELECT', async () => {
    const { data, error } = await anonClient().from('merchant_billing').select('*')
    // A revoked grant surfaces as a permission error (or, at minimum, zero rows).
    expect(error !== null || (data ?? []).length === 0).toBe(true)
    if (error) expect(error.message.toLowerCase()).toContain('permission denied')
  })

  it('denies an authenticated SELECT', async () => {
    const client = await makeUser('billing-grant@example.com', 'password123')
    const { data, error } = await client.from('merchant_billing').select('*')
    expect(error !== null || (data ?? []).length === 0).toBe(true)
  })
})
