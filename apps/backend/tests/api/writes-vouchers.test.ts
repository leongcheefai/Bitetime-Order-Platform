// tests/api/writes-vouchers.test.ts
// POST/DELETE /api/merchants/:id/vouchers[/:voucherId] — voucher create/delete. The
// load-bearing assertion is tenancy on delete: requireMerchantOwns only proves the caller
// owns :id — it says nothing about whether :voucherId actually belongs to that shop. An
// owner of shop A nesting shop B's voucher under :id = A must be refused (404), not silently
// allowed to delete a stranger's row. See CLAUDE.md → Backend, Global Constraint 2.
// Vouchers are also a Pro feature (#110, CONTEXT.md → Plan entitlement), so every seed here
// carries `plan: 'pro'` — without it the plan gate refuses the write and the tenancy
// assertions would pass for the wrong reason.
import { describe, it, expect } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

function post(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function del(path: string, token?: string) {
  return app.request(path, {
    method: 'DELETE',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

type VoucherRow = { id: string; merchant_id: string; code: string; kind: string; amount: number }

async function seedVoucher(fields: { merchant_id: string; code: string; kind?: string; amount?: number }) {
  const { data, error } = await serviceClient()
    .from('vouchers')
    .insert({
      merchant_id: fields.merchant_id,
      code: fields.code,
      kind: fields.kind ?? 'fixed',
      amount: fields.amount ?? 5,
    })
    .select('id')
    .single()
  if (error) throw new Error(`seeding voucher: ${error.message}`)
  return data!.id as string
}

describe('POST /api/merchants/:id/vouchers', () => {
  it('creates a voucher for the owner, forcing merchant_id from the route and uppercasing the code', async () => {
    await resetMerchant('voucher-owner-shop')
    const owner = await makeUser('voucher-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-owner-shop', owner_id: userId, plan: 'pro' })

    const res = await post(`/api/merchants/${id}/vouchers`, {
      code: 'save10', kind: 'percent', amount: 10, maxUses: 100,
    }, token)

    expect(res.status).toBe(200)
    const row = (await res.json()) as VoucherRow
    expect(row.merchant_id).toBe(id)
    expect(row.code).toBe('SAVE10')

    await serviceClient().from('vouchers').delete().eq('id', row.id)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('400s on an empty code', async () => {
    await resetMerchant('voucher-empty-shop')
    const owner = await makeUser('voucher-empty-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-empty-shop', owner_id: userId, plan: 'pro' })

    const res = await post(`/api/merchants/${id}/vouchers`, { code: '   ', kind: 'fixed', amount: 5 }, token)
    expect(res.status).toBe(400)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('ignores a client-supplied merchant_id (forced from :id)', async () => {
    await resetMerchant('voucher-evil-shop')
    const owner = await makeUser('voucher-evil-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-evil-shop', owner_id: userId, plan: 'pro' })

    const res = await post(`/api/merchants/${id}/vouchers`, {
      code: 'SNEAKY', kind: 'fixed', amount: 1, merchant_id: '00000000-0000-0000-0000-000000000000',
    }, token)

    expect(res.status).toBe(200)
    const row = (await res.json()) as VoucherRow
    expect(row.merchant_id).toBe(id)

    await serviceClient().from('vouchers').delete().eq('id', row.id)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('voucher-a-shop')
    const owner = await makeUser('voucher-a-owner@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-a-shop', owner_id: ownerId, plan: 'pro' })

    const other = await makeUser('voucher-a-other@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await post(`/api/merchants/${id}/vouchers`, { code: 'X', kind: 'fixed', amount: 1 }, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // Vouchers are Pro-only (#110). The refusal is the backend's, not the hidden nav entry's.
  it('403 requires_pro for a basic shop’s owner, and creates nothing', async () => {
    await resetMerchant('voucher-basic-shop')
    const owner = await makeUser('voucher-basic-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-basic-shop', owner_id: userId, plan: 'basic' })

    const res = await post(`/api/merchants/${id}/vouchers`, { code: 'SAVE10', kind: 'percent', amount: 10 }, token)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'requires_pro' })

    const { data: rows } = await serviceClient().from('vouchers').select('id').eq('merchant_id', id)
    expect(rows).toEqual([])

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('voucher-anon-shop')
    const owner = await makeUser('voucher-anon-owner@example.com', 'password123')
    const { userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-anon-shop', owner_id: userId, plan: 'pro' })

    const res = await post(`/api/merchants/${id}/vouchers`, { code: 'X', kind: 'fixed', amount: 1 })
    expect(res.status).toBe(401)

    await serviceClient().from('merchants').delete().eq('id', id)
  })
})

describe('DELETE /api/merchants/:id/vouchers/:voucherId', () => {
  it('deletes the owner’s own voucher', async () => {
    await resetMerchant('voucher-del-shop')
    const owner = await makeUser('voucher-del-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-del-shop', owner_id: userId, plan: 'pro' })
    const voucherId = await seedVoucher({ merchant_id: id, code: 'DOOMED' })

    const res = await del(`/api/merchants/${id}/vouchers/${voucherId}`, token)
    expect(res.status).toBe(200)

    const { data } = await serviceClient().from('vouchers').select('id').eq('id', voucherId).maybeSingle()
    expect(data).toBeNull()

    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // Load-bearing: an owner of shop A cannot delete shop B's voucher by nesting it under
  // :id = A. requireMerchantOwns only proves ownership of :id; the handler must separately
  // verify the voucher's own merchant_id before deleting it.
  it('404s and leaves the row intact when the voucher belongs to a different shop', async () => {
    await resetMerchant('voucher-tenant-a')
    await resetMerchant('voucher-tenant-b')
    const ownerA = await makeUser('voucher-tenant-a-owner@example.com', 'password123')
    const { token: tokenA, userId: ownerAId } = await tokenOf(ownerA)
    const shopA = await seedMerchant({ slug: 'voucher-tenant-a', owner_id: ownerAId, plan: 'pro' })

    const ownerB = await makeUser('voucher-tenant-b-owner@example.com', 'password123')
    const { userId: ownerBId } = await tokenOf(ownerB)
    const shopB = await seedMerchant({ slug: 'voucher-tenant-b', owner_id: ownerBId, plan: 'pro' })
    const voucherB = await seedVoucher({ merchant_id: shopB, code: 'SHOPB10' })

    const res = await del(`/api/merchants/${shopA}/vouchers/${voucherB}`, tokenA)
    expect(res.status).toBe(404)

    const { data } = await serviceClient()
      .from('vouchers').select('id, merchant_id, code').eq('id', voucherB).single()
    expect(data!.merchant_id).toBe(shopB)
    expect(data!.code).toBe('SHOPB10')

    await serviceClient().from('vouchers').delete().eq('id', voucherB)
    await serviceClient().from('merchants').delete().eq('id', shopA)
    await serviceClient().from('merchants').delete().eq('id', shopB)
  })

  it('403 for a non-owner', async () => {
    await resetMerchant('voucher-del-a-shop')
    const owner = await makeUser('voucher-del-a-owner@example.com', 'password123')
    const { userId: ownerId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-del-a-shop', owner_id: ownerId, plan: 'pro' })
    const voucherId = await seedVoucher({ merchant_id: id, code: 'GUARDED' })

    const other = await makeUser('voucher-del-a-other@example.com', 'password123')
    const { token: otherToken } = await tokenOf(other)

    const res = await del(`/api/merchants/${id}/vouchers/${voucherId}`, otherToken)
    expect(res.status).toBe(403)

    await serviceClient().from('vouchers').delete().eq('id', voucherId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  // A voucher a shop still holds from a Pro period cannot be deleted once it drops to basic —
  // the whole mutation surface is gated, not just create. Deliberate: this is the same refusal
  // the frontend's locked Vouchers area already prevents the merchant from reaching.
  it('403 requires_pro for a basic shop’s owner, and leaves the row intact', async () => {
    await resetMerchant('voucher-del-basic-shop')
    const owner = await makeUser('voucher-del-basic-owner@example.com', 'password123')
    const { token, userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-del-basic-shop', owner_id: userId, plan: 'basic' })
    const voucherId = await seedVoucher({ merchant_id: id, code: 'LEFTOVER' })

    const res = await del(`/api/merchants/${id}/vouchers/${voucherId}`, token)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'requires_pro' })

    const { data } = await serviceClient().from('vouchers').select('id').eq('id', voucherId).maybeSingle()
    expect(data).not.toBeNull()

    await serviceClient().from('vouchers').delete().eq('id', voucherId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })

  it('401 without a token', async () => {
    await resetMerchant('voucher-del-anon-shop')
    const owner = await makeUser('voucher-del-anon-owner@example.com', 'password123')
    const { userId } = await tokenOf(owner)
    const id = await seedMerchant({ slug: 'voucher-del-anon-shop', owner_id: userId, plan: 'pro' })
    const voucherId = await seedVoucher({ merchant_id: id, code: 'ANONCODE' })

    const res = await del(`/api/merchants/${id}/vouchers/${voucherId}`)
    expect(res.status).toBe(401)

    await serviceClient().from('vouchers').delete().eq('id', voucherId)
    await serviceClient().from('merchants').delete().eq('id', id)
  })
})
