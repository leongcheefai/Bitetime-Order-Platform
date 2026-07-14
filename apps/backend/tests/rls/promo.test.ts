// tests/rls/promo.test.ts
// A promo's cap only binds if the counter that tracks it (promo_sold) cannot be
// moved from the browser. Proves the products_promo_sold_guard trigger: the
// merchant owns the promo row but not the count of what it has sold, and the
// dashboard's field-level edits (price, limit) interact with that count in
// specific ways — a price change resets it, a limit change does not.
import { describe, it, expect, beforeAll } from 'vitest'
import { makeUser, seedMerchant, seedProduct, serviceClient } from './helpers.js'

describe('promo_sold guard (RLS)', () => {
  let merchantClient: any
  const adminClient = serviceClient()
  let merchantId: string

  beforeAll(async () => {
    merchantClient = await makeUser('rls-promo@test.dev', 'password123')
    const uid = (await merchantClient.auth.getUser()).data.user!.id
    merchantId = await seedMerchant({
      name: 'Promo Shop',
      slug: 'shop-rls-promo',
      order_prefix: 'PP',
      owner_id: uid,
    })
  }, 30_000)

  /**
   * Seed a fresh product with promo_price 5, promo_limit 10, promo_sold 4 via the
   * admin client. Two separate updates: the guard resets promo_sold to 0 whenever
   * promo_price changes (regardless of role), so promo_sold must be set in a
   * later update where promo_price is left untouched.
   */
  async function seedPromoProduct() {
    const productId = await seedProduct({ merchant_id: merchantId, price: 10 })
    const priced = await adminClient
      .from('products')
      .update({ promo_price: 5, promo_limit: 10 })
      .eq('id', productId)
    if (priced.error) throw new Error(`seeding promo product (price): ${priced.error.message}`)
    const sold = await adminClient.from('products').update({ promo_sold: 4 }).eq('id', productId)
    if (sold.error) throw new Error(`seeding promo product (sold): ${sold.error.message}`)
    return productId
  }

  // The merchant owns the promo. They do NOT own the count of what it has sold.
  //
  // supabase-js resolves {data, error} rather than rejecting — a write that hit zero rows
  // (e.g. because `productId` were wrong) reports the same `error: null` as one that landed
  // and was pinned. So this co-updates a column the merchant IS allowed to move (`name`) and
  // asserts THAT moved, to prove the write really reached the row, before trusting that
  // promo_sold staying at 4 means it was pinned rather than never touched.
  it('a merchant cannot move promo_sold on their own product', async () => {
    const productId = await seedPromoProduct()
    const { error } = await merchantClient
      .from('products')
      .update({ promo_sold: 0, name: 'renamed by merchant' })
      .eq('id', productId)
    expect(error).toBeNull()
    const { data } = await adminClient
      .from('products')
      .select('promo_sold, name')
      .eq('id', productId)
      .single()
    expect(data!.name).toBe('renamed by merchant') // the write really landed...
    expect(data!.promo_sold).toBe(4) // ...and promo_sold was pinned anyway
  })

  it('changing the promo PRICE resets the count', async () => {
    const productId = await seedPromoProduct()
    const { error } = await merchantClient.from('products').update({ promo_price: 6 }).eq('id', productId)
    expect(error).toBeNull()
    const { data } = await adminClient
      .from('products')
      .select('promo_sold, promo_price')
      .eq('id', productId)
      .single()
    expect(data!.promo_price).toBe(6) // the write really landed...
    expect(data!.promo_sold).toBe(0) // ...and reset the count
  })

  it('raising the CAP does not reset the count', async () => {
    const productId = await seedPromoProduct()
    const { error } = await merchantClient.from('products').update({ promo_limit: 20 }).eq('id', productId)
    expect(error).toBeNull()
    const { data } = await adminClient
      .from('products')
      .select('promo_sold, promo_limit')
      .eq('id', productId)
      .single()
    expect(data!.promo_limit).toBe(20) // the cap really changed...
    expect(data!.promo_sold).toBe(4) // ...ten more units, not twenty
  })

  // The dashboard's actual write path (see `upsertProduct` in apps/frontend/src/store.ts) is
  // a single `.upsert()` of the WHOLE product row — INSERT for a new product, UPDATE-on-conflict
  // for an existing one. Both paths run through this same trigger, and neither is an UPDATE the
  // three tests above exercise, so cover them here.

  it('a merchant INSERT carrying promo_sold does not seed the count', async () => {
    const productId = crypto.randomUUID()
    const { error } = await merchantClient.from('products').insert({
      id: productId,
      merchant_id: merchantId,
      name: 'New Promo Item',
      price: 10,
      promo_sold: 99,
    })
    expect(error).toBeNull()
    const { data } = await adminClient
      .from('products')
      .select('name, promo_sold')
      .eq('id', productId)
      .single()
    expect(data!.name).toBe('New Promo Item') // the row really was inserted...
    expect(data!.promo_sold).toBe(0) // ...and the stowaway count was not
  })

  it('a merchant upsert of the whole product row cannot rewind the count', async () => {
    const productId = await seedPromoProduct()
    // Mirror the dashboard's shape: fetch the full row, edit one field, write the whole
    // thing back — including a promo_sold that is now stale (someone else sold one while
    // this row sat in the merchant's edit form).
    const { data: before } = await adminClient.from('products').select('*').eq('id', productId).single()
    const { error } = await merchantClient
      .from('products')
      .upsert({ ...before, name: 'renamed via upsert', promo_sold: 0 })
    expect(error).toBeNull()
    const { data } = await adminClient
      .from('products')
      .select('name, promo_sold')
      .eq('id', productId)
      .single()
    expect(data!.name).toBe('renamed via upsert') // the write really landed...
    expect(data!.promo_sold).toBe(4) // ...and the stale count did not overwrite it
  })
})
