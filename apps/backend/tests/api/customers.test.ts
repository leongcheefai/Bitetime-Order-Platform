// tests/api/customers.test.ts
// GET /api/merchants/:id/customers and the note/tag write — #143.
//
// Only what the pure fold cannot prove. Every rule about WHO is one customer, what counts as
// an order and how the list is ordered lives in tests/unit/shopCustomers.test.ts, against
// injected rows and no database. What is left here needs real Postgres:
//
//   * TENANCY — admin is RLS-exempt, so requireMerchantOwns is the only thing standing between
//     merchant B and merchant A's customers.
//   * THE PRO GATE — the padlock in the dashboard is UX; this is the door.
//   * THE JOIN — a customer with no written row, and a written row's lazy creation.
//   * THE ROW CAP — the reason aggregation moved into SQL at all: PostgREST truncates at 1000
//     rows, silently, and the old browser-side grouping was built on top of that.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, resetMerchant, seedMerchant, serviceClient } from '../rls/helpers.js'

const svc = () => serviceClient()

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return data.session!.access_token
}

const get = (path: string, token?: string) =>
  app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })

const put = (path: string, payload: unknown, token?: string) =>
  app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  })

interface CustomerRow {
  phoneKey: string
  name: string | null
  bookedOrders: number
  lifetimeSpend: number
  note: string | null
  tags: string[]
  hasAccount: boolean
  email: string | null
}
interface CustomerPage {
  customers: CustomerRow[]
  shopTags: string[]
  stats: { customers: number; bookedOrders: number; spend: number }
  total: number
  unattributedOrders: number
}

const pageOf = async (res: Response) => (await res.json()) as CustomerPage

/** An order row, written straight in — intake's own rules are orders.test.ts's business. */
async function seedOrder(merchantId: string, fields: Record<string, unknown>) {
  const { error } = await svc().from('orders').insert({
    merchant_id: merchantId,
    customer_name: 'Ah Meng',
    customer_wa: '60123456789',
    customer_phone_key: '23456789',
    mode: 'pickup',
    total: 10,
    status: 'completed',
    order_number: `T-${Math.round(Math.random() * 1e9)}`,
    ...fields,
  })
  if (error) throw new Error(error.message)
}

describe('shop customers', () => {
  let aToken: string, bToken: string, proToken: string
  let basicId: string, proId: string

  beforeAll(async () => {
    const a = await makeUser('cust-basic@example.com', 'password123')
    const b = await makeUser('cust-other@example.com', 'password123')
    const p = await makeUser('cust-pro@example.com', 'password123')
    const { data: as } = await a.auth.getSession()
    const { data: bs } = await b.auth.getSession()
    const { data: ps } = await p.auth.getSession()

    await resetMerchant('cust-basic-shop')
    await resetMerchant('cust-other-shop')
    await resetMerchant('cust-pro-shop')

    basicId = await seedMerchant({ slug: 'cust-basic-shop', owner_id: as.session!.user.id })
    await seedMerchant({ slug: 'cust-other-shop', owner_id: bs.session!.user.id })
    proId = await seedMerchant({ slug: 'cust-pro-shop', owner_id: ps.session!.user.id })

    aToken = await tokenOf(a)
    bToken = await tokenOf(b)
    proToken = await tokenOf(p)
  })

  beforeEach(async () => {
    for (const id of [basicId, proId]) {
      await svc().from('orders').delete().eq('merchant_id', id)
      await svc().from('shop_customers').delete().eq('merchant_id', id)
    }
  })

  // ── Tenancy ────────────────────────────────────────────────────────────────

  it('lets an owner read their own customers', async () => {
    await seedOrder(basicId, {})
    const res = await get(`/api/merchants/${basicId}/customers`, aToken)

    expect(res.status).toBe(200)
    expect((await pageOf(res)).customers).toHaveLength(1)
  })

  it("forbids a different merchant from reading shop A's customers", async () => {
    expect((await get(`/api/merchants/${basicId}/customers`, bToken)).status).toBe(403)
  })

  it('rejects an anonymous caller', async () => {
    expect((await get(`/api/merchants/${basicId}/customers`)).status).toBe(401)
  })

  it("forbids a different merchant from writing against shop A's customer", async () => {
    expect((await put(`/api/merchants/${basicId}/customers/23456789`, { note: 'x' }, bToken)).status).toBe(403)
  })

  // ── The list, whole ────────────────────────────────────────────────────────
  // Sorting, tag filtering and the note/tag write used to be the paid half of this endpoint. The
  // tier is gone (#222), so every one of them is an ordinary owner capability — and each is kept
  // as a positive test rather than deleted, because a removed refusal with nothing in its place
  // leaves exactly these paths unexercised.

  it('gives an owner the list itself', async () => {
    await seedOrder(basicId, {})
    const res = await get(`/api/merchants/${basicId}/customers`, aToken)

    expect(res.status).toBe(200)
    expect((await pageOf(res)).customers[0]?.bookedOrders).toBe(1)
  })

  it('gives an owner search', async () => {
    await seedOrder(basicId, {})
    expect((await get(`/api/merchants/${basicId}/customers?search=meng`, aToken)).status).toBe(200)
  })

  it('gives an owner every sort', async () => {
    for (const sort of ['spend', 'orders', 'recent']) {
      expect((await get(`/api/merchants/${basicId}/customers?sort=${sort}`, aToken)).status).toBe(200)
    }
    expect((await get(`/api/merchants/${basicId}/customers`, aToken)).status).toBe(200)
  })

  it('gives an owner the tag filter', async () => {
    expect((await get(`/api/merchants/${basicId}/customers?tag=vip`, aToken)).status).toBe(200)
  })

  it('gives an owner the note and tag write', async () => {
    const res = await put(`/api/merchants/${basicId}/customers/23456789`, { note: 'no peanuts' }, aToken)
    expect(res.status).toBe(200)
  })

  // ── What the door accepts ──────────────────────────────────────────────────
  //
  // Refuse, do not normalise — the cart-key rule. A sort the endpoint quietly reinterprets is
  // a list answering a question the merchant did not ask.

  it('refuses a sort it does not offer rather than quietly showing another one', async () => {
    const res = await get(`/api/merchants/${proId}/customers?sort=nonsense`, proToken)
    expect(res.status).toBe(400)
  })

  it('refuses tags that are not a list of strings', async () => {
    for (const tags of [{ a: 1 }, [1, 2], ['ok', null], 'vip']) {
      const res = await put(`/api/merchants/${proId}/customers/23456789`, { tags }, proToken)
      expect(res.status).toBe(400)
    }
  })

  it('refuses a note longer than the column is meant to hold', async () => {
    const res = await put(`/api/merchants/${proId}/customers/23456789`, { note: 'x'.repeat(2001) }, proToken)
    expect(res.status).toBe(400)
  })

  it('refuses more tags than a customer could meaningfully carry', async () => {
    const tags = Array.from({ length: 21 }, (_, i) => `t${i}`)
    expect((await put(`/api/merchants/${proId}/customers/23456789`, { tags }, proToken)).status).toBe(400)
  })

  it('trims tags and drops blank ones rather than storing them', async () => {
    await seedOrder(proId, {})
    await put(`/api/merchants/${proId}/customers/23456789`, { tags: ['  vip  ', '', '   '] }, proToken)

    const [customer] = (await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))).customers
    expect(customer?.tags).toEqual(['vip'])
  })

  it('stores a blank note as nothing written, not as a blank string', async () => {
    await seedOrder(proId, {})
    await put(`/api/merchants/${proId}/customers/23456789`, { note: '   ' }, proToken)

    const [customer] = (await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))).customers
    expect(customer?.note).toBeNull()
  })

  it('refuses a phone key that is not one', async () => {
    expect((await put(`/api/merchants/${proId}/customers/not-a-key`, { note: 'x' }, proToken)).status).toBe(400)
  })

  // ── The write, and the row it creates ──────────────────────────────────────

  it('creates the row lazily, on the first thing the merchant writes', async () => {
    await seedOrder(proId, {})
    const before = await svc().from('shop_customers').select('*').eq('merchant_id', proId)
    expect(before.data).toEqual([])

    await put(`/api/merchants/${proId}/customers/23456789`, { note: 'allergic to peanuts', tags: ['vip'] }, proToken)

    const after = await svc().from('shop_customers').select('*').eq('merchant_id', proId)
    expect(after.data).toHaveLength(1)
    expect(after.data?.[0]?.note).toBe('allergic to peanuts')
    expect(after.data?.[0]?.tags).toEqual(['vip'])
  })

  it('updates the existing row on a second write rather than duplicating it', async () => {
    await seedOrder(proId, {})
    await put(`/api/merchants/${proId}/customers/23456789`, { note: 'first', tags: ['a'] }, proToken)
    await put(`/api/merchants/${proId}/customers/23456789`, { note: 'second', tags: ['b'] }, proToken)

    const { data } = await svc().from('shop_customers').select('*').eq('merchant_id', proId)
    expect(data).toHaveLength(1)
    expect(data?.[0]?.note).toBe('second')
    expect(data?.[0]?.tags).toEqual(['b'])
  })

  it('serves the written note and tags back on the list', async () => {
    await seedOrder(proId, {})
    await put(`/api/merchants/${proId}/customers/23456789`, { note: 'regular', tags: ['vip', 'office'] }, proToken)

    const [customer] = (await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))).customers
    expect(customer?.note).toBe('regular')
    expect(customer?.tags).toEqual(['vip', 'office'])
  })

  it('leaves a customer nobody wrote about blank rather than failing the join', async () => {
    await seedOrder(proId, {})
    const [customer] = (await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))).customers

    expect(customer?.note).toBeNull()
    expect(customer?.tags).toEqual([])
  })

  it('narrows the list to a tag once one is written', async () => {
    await seedOrder(proId, { customer_phone_key: '23456789', customer_wa: '60123456789' })
    await seedOrder(proId, { customer_phone_key: '98765432', customer_wa: '60198765432', customer_name: 'Siti' })
    await put(`/api/merchants/${proId}/customers/23456789`, { note: null, tags: ['wholesale'] }, proToken)

    const page = await pageOf(await get(`/api/merchants/${proId}/customers?tag=wholesale`, proToken))
    expect(page.customers.map(c => c.phoneKey)).toEqual(['23456789'])
    expect(page.total).toBe(1)
  })

  // The tag vocabulary the drawer suggests from (#150). The fold itself — ordering, duplicates,
  // what the filter does not narrow — is proven in tests/unit/shopCustomers.test.ts. What needs
  // real Postgres is that it is scoped to ONE shop: `shopCustomerRecords` goes through db.ts,
  // which is RLS-exempt, so the `merchant_id` in that query is the only thing separating two
  // shops' vocabularies.
  it('offers back every tag the shop has written', async () => {
    await seedOrder(proId, { customer_phone_key: '23456789', customer_wa: '60123456789' })
    await seedOrder(proId, { customer_phone_key: '98765432', customer_wa: '60198765432' })
    await put(`/api/merchants/${proId}/customers/23456789`, { tags: ['vip'] }, proToken)
    await put(`/api/merchants/${proId}/customers/98765432`, { tags: ['office', 'vip'] }, proToken)

    expect((await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))).shopTags)
      .toEqual(['office', 'vip'])
  })

  it("never offers another shop's tags", async () => {
    await seedOrder(proId, {})
    await seedOrder(basicId, {})
    await put(`/api/merchants/${proId}/customers/23456789`, { tags: ['pro-only'] }, proToken)
    // Written straight in: a basic shop cannot reach the PUT, and this test is about the read.
    const { error } = await svc().from('shop_customers')
      .insert({ merchant_id: basicId, phone_key: '23456789', tags: ['basic-only'] })
    if (error) throw new Error(error.message)

    expect((await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))).shopTags)
      .toEqual(['pro-only'])
    expect((await pageOf(await get(`/api/merchants/${basicId}/customers`, aToken))).shopTags)
      .toEqual(['basic-only'])
  })

  it('keeps one shop’s note invisible to another shop', async () => {
    await seedOrder(proId, {})
    await seedOrder(basicId, {})
    await put(`/api/merchants/${proId}/customers/23456789`, { note: 'pro shop note' }, proToken)

    const [theirs] = (await pageOf(await get(`/api/merchants/${basicId}/customers`, aToken))).customers
    expect(theirs?.note).toBeNull()
  })

  // ── What the list actually says ────────────────────────────────────────────

  it('groups two spellings of one number into one customer', async () => {
    await seedOrder(proId, { customer_wa: '+60 12-345 6789', customer_phone_key: '23456789' })
    await seedOrder(proId, { customer_wa: '0123456789', customer_phone_key: '23456789' })

    const page = await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))
    expect(page.customers).toHaveLength(1)
    expect(page.customers[0]?.bookedOrders).toBe(2)
  })

  it('excludes cancelled orders from the money and counts the orders it cannot attribute', async () => {
    await seedOrder(proId, { total: 30 })
    await seedOrder(proId, { total: 999, status: 'cancelled' })
    await seedOrder(proId, { customer_phone_key: null, customer_wa: '' })

    const page = await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))
    expect(page.customers[0]?.bookedOrders).toBe(1)
    expect(page.customers[0]?.lifetimeSpend).toBe(30)
    expect(page.unattributedOrders).toBe(1)
  })

  it('reports whether a customer has an account', async () => {
    const signedIn = await makeUser('cust-diner@example.com', 'password123')
    const { data } = await signedIn.auth.getSession()
    await seedOrder(proId, { user_id: data.session!.user.id })

    const [customer] = (await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))).customers
    expect(customer?.hasAccount).toBe(true)
  })

  it("serves a member's account email, and none for a guest", async () => {
    const signedIn = await makeUser('cust-mail@example.com', 'password123')
    const { data } = await signedIn.auth.getSession()
    await seedOrder(proId, { customer_phone_key: '44444444', customer_wa: '60144444444', user_id: data.session!.user.id })
    await seedOrder(proId, { customer_phone_key: '55555555', customer_wa: '60155555555' })

    const byKey = new Map(
      (await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))).customers.map(c => [c.phoneKey, c]),
    )
    expect(byKey.get('44444444')?.email).toBe('cust-mail@example.com')
    expect(byKey.get('55555555')?.email).toBeNull()
  })

  // ── The row cap this endpoint exists to escape ─────────────────────────────

  // Deliberately just OVER the cap rather than comfortably past it. This suite runs alongside
  // 26 others against one Postgres, and every extra row here is latency the whole run pays —
  // enough of it and a neighbouring timing-sensitive test (feedback's 20-round-trip rate-limit
  // case) starts blowing its own timeout. 1010 proves the same thing 1200 did.
  it('counts every order behind a customer past the PostgREST row cap', async () => {
    const rows = Array.from({ length: 1010 }, (_, i) => ({
      merchant_id: proId,
      customer_name: 'Bulk',
      customer_wa: '60123456789',
      customer_phone_key: '23456789',
      mode: 'pickup',
      total: 1,
      status: 'completed',
      order_number: `BULK-${i}`,
    }))
    for (let i = 0; i < rows.length; i += 505) {
      const { error } = await svc().from('orders').insert(rows.slice(i, i + 505))
      if (error) throw new Error(error.message)
    }

    const page = await pageOf(await get(`/api/merchants/${proId}/customers`, proToken))
    expect(page.customers[0]?.bookedOrders).toBe(1010)
    expect(page.customers[0]?.lifetimeSpend).toBe(1010)
  })

  // ── One customer's orders, for the drawer ──────────────────────────────────
  //
  // A separate endpoint rather than orders nested in the list: the list is a table of hundreds
  // and the drawer opens for one of them, so shipping every customer's full order history to
  // draw a table that shows none of it is the row-cap mistake again in a new costume.

  it('returns one customer’s orders, newest first', async () => {
    await seedOrder(proId, { order_number: 'OLD', created_at: '2026-05-01T00:00:00Z' })
    await seedOrder(proId, { order_number: 'NEW', created_at: '2026-07-01T00:00:00Z' })
    await seedOrder(proId, { customer_phone_key: '98765432', customer_wa: '60198765432', order_number: 'OTHER' })

    const res = await get(`/api/merchants/${proId}/customers/23456789/orders`, proToken)
    const orders = (await res.json()) as { order_number: string }[]

    expect(orders.map(o => o.order_number)).toEqual(['NEW', 'OLD'])
  })

  it('includes a cancelled order, so the list never contradicts the badge', async () => {
    await seedOrder(proId, { order_number: 'CANCELLED', status: 'cancelled' })

    const res = await get(`/api/merchants/${proId}/customers/23456789/orders`, proToken)
    expect((await res.json()) as unknown[]).toHaveLength(1)
  })

  it('is free — the drawer ships with the free list', async () => {
    await seedOrder(basicId, {})
    expect((await get(`/api/merchants/${basicId}/customers/23456789/orders`, aToken)).status).toBe(200)
  })

  it("forbids reading another shop's customer orders", async () => {
    expect((await get(`/api/merchants/${basicId}/customers/23456789/orders`, bToken)).status).toBe(403)
  })

  it('returns nothing for a phone key that never ordered here', async () => {
    await seedOrder(proId, {})
    const res = await get(`/api/merchants/${proId}/customers/00000000/orders`, proToken)

    expect(res.status).toBe(200)
    expect((await res.json()) as unknown[]).toEqual([])
  })

  // ── Paging ─────────────────────────────────────────────────────────────────

  it('pages the list and reports the unpaged total', async () => {
    for (let i = 0; i < 5; i++) {
      await seedOrder(proId, { customer_phone_key: `5555555${i}`, customer_wa: `6015555555${i}` })
    }

    const page = await pageOf(await get(`/api/merchants/${proId}/customers?page=1&pageSize=2`, proToken))
    expect(page.customers).toHaveLength(2)
    expect(page.total).toBe(5)
  })

  // ── Segments and the stat row (#269) ───────────────────────────────────────

  // Two guests and one member, the member with a guest order of their own under the same phone.
  async function seedMix() {
    const diner = await makeUser('cust-member@example.com', 'password123')
    const { data } = await diner.auth.getSession()
    await seedOrder(proId, { customer_phone_key: '11111111', customer_wa: '60111111111', user_id: data.session!.user.id, total: 10 })
    await seedOrder(proId, { customer_phone_key: '11111111', customer_wa: '60111111111', total: 20 })
    await seedOrder(proId, { customer_phone_key: '22222222', customer_wa: '60122222222', total: 5 })
    await seedOrder(proId, { customer_phone_key: '33333333', customer_wa: '60133333333', total: 7 })
  }

  it('narrows to members, and counts the member’s guest orders as theirs', async () => {
    await seedMix()
    const page = await pageOf(await get(`/api/merchants/${proId}/customers?segment=members`, proToken))
    expect(page.customers.map(c => c.phoneKey)).toEqual(['11111111'])
    expect(page.customers[0]?.bookedOrders).toBe(2)
    expect(page.customers[0]?.email).toBe('cust-member@example.com')
    expect(page.stats).toEqual({ customers: 1, bookedOrders: 2, spend: 30 })
  })

  it('shows everyone for the all segment, with the stats to match', async () => {
    await seedMix()
    const page = await pageOf(await get(`/api/merchants/${proId}/customers?segment=all`, proToken))
    expect(page.total).toBe(3)
    expect(page.stats).toEqual({ customers: 3, bookedOrders: 4, spend: 42 })
  })

  it('refuses a segment it does not offer rather than quietly showing another one', async () => {
    const res = await get(`/api/merchants/${proId}/customers?segment=guests`, proToken)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_segment' })
  })

  it('reports stats that equal the rows summed across every page', async () => {
    await seedMix()
    const p1 = await pageOf(await get(`/api/merchants/${proId}/customers?page=1&pageSize=2`, proToken))
    const p2 = await pageOf(await get(`/api/merchants/${proId}/customers?page=2&pageSize=2`, proToken))
    const rows = [...p1.customers, ...p2.customers]
    expect(rows).toHaveLength(3)
    expect(p1.stats).toEqual(p2.stats)
    expect(p1.stats.bookedOrders).toBe(rows.reduce((n, c) => n + c.bookedOrders, 0))
    expect(p1.stats.spend).toBe(rows.reduce((n, c) => n + c.lifetimeSpend, 0))
  })
})
