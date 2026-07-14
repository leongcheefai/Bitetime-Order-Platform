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
  it('a merchant cannot move promo_sold on their own product', async () => {
    const productId = await seedPromoProduct()
    await merchantClient.from('products').update({ promo_sold: 0 }).eq('id', productId)
    const { data } = await adminClient.from('products').select('promo_sold').eq('id', productId).single()
    expect(data!.promo_sold).toBe(4) // pinned, not zeroed
  })

  it('changing the promo PRICE resets the count', async () => {
    const productId = await seedPromoProduct()
    await merchantClient.from('products').update({ promo_price: 6 }).eq('id', productId)
    const { data } = await adminClient.from('products').select('promo_sold').eq('id', productId).single()
    expect(data!.promo_sold).toBe(0)
  })

  it('raising the CAP does not reset the count', async () => {
    const productId = await seedPromoProduct()
    await merchantClient.from('products').update({ promo_limit: 20 }).eq('id', productId)
    const { data } = await adminClient.from('products').select('promo_sold').eq('id', productId).single()
    expect(data!.promo_sold).toBe(4) // ten more units, not twenty
  })
})
