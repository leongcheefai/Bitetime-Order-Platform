import { describe, it, expect } from 'vitest'
import { shopCustomers } from '../../src/shopCustomers.js'
import type { ShopCustomerGroup, ShopCustomerRecord } from '../../src/shopCustomers.js'

const NOW = new Date('2026-07-28T12:00:00Z')

function group(g: Partial<ShopCustomerGroup>): ShopCustomerGroup {
  return {
    phoneKey: '23456789',
    status: 'completed',
    orders: 1,
    total: 0,
    firstAt: '2026-07-01T00:00:00Z',
    lastAt: '2026-07-01T00:00:00Z',
    latestName: 'Ali',
    latestWa: '0123456789',
    hasAccount: false,
    latestEmail: null,
    ...g,
  }
}

const page = (groups: ShopCustomerGroup[], records: ShopCustomerRecord[] = []) =>
  shopCustomers(groups, records, { now: NOW })

describe('shopCustomers — folding groups into customers', () => {
  it('folds every status group for one phone key into a single customer', () => {
    const r = page([
      group({ status: 'completed', orders: 2, total: 60 }),
      group({ status: 'new', orders: 1, total: 15 }),
    ])
    expect(r.customers).toHaveLength(1)
    expect(r.customers[0]?.phoneKey).toBe('23456789')
    expect(r.customers[0]?.bookedOrders).toBe(3)
  })

  it('keeps two different phone keys as two customers', () => {
    const r = page([
      group({ phoneKey: '23456789' }),
      group({ phoneKey: '87654321' }),
    ])
    expect(r.customers).toHaveLength(2)
  })

  it('excludes cancelled orders from booked count and spend', () => {
    const r = page([
      group({ status: 'completed', orders: 2, total: 60 }),
      group({ status: 'cancelled', orders: 5, total: 999 }),
    ])
    expect(r.customers[0]?.bookedOrders).toBe(2)
    expect(r.customers[0]?.lifetimeSpend).toBe(60)
  })

  it('counts an order with no status as booked — a fresh order is money in the pipeline', () => {
    const r = page([group({ status: null, orders: 1, total: 20 })])
    expect(r.customers[0]?.bookedOrders).toBe(1)
    expect(r.customers[0]?.lifetimeSpend).toBe(20)
  })

  it('averages over booked orders only, and is 0 rather than NaN when none are booked', () => {
    const booked = page([group({ status: 'completed', orders: 4, total: 100 })])
    expect(booked.customers[0]?.avgOrder).toBe(25)

    const allCancelled = page([group({ status: 'cancelled', orders: 3, total: 90 })])
    expect(allCancelled.customers[0]?.avgOrder).toBe(0)
    expect(allCancelled.customers[0]?.lifetimeSpend).toBe(0)
    expect(allCancelled.customers[0]?.bookedOrders).toBe(0)
  })

  it('coerces a numeric total arriving from postgres.js as a string', () => {
    const r = page([group({ orders: 1, total: '31.20' })])
    expect(r.customers[0]?.lifetimeSpend).toBe(31.2)
  })

  it('sums money in cents, so a lifetime spend is never 0.30000000000000004', () => {
    const r = page([
      group({ status: 'completed', orders: 1, total: '0.10' }),
      group({ status: 'new', orders: 1, total: '0.20' }),
    ])
    expect(r.customers[0]?.lifetimeSpend).toBe(0.3)
  })

  it('rounds the average to cents rather than handing back a repeating fraction', () => {
    const r = page([group({ status: 'completed', orders: 3, total: 10 })])
    expect(r.customers[0]?.avgOrder).toBe(3.33)
  })

  it('takes last-order date from every order, including cancelled ones', () => {
    const r = page([
      group({ status: 'completed', lastAt: '2026-05-01T00:00:00Z', firstAt: '2026-05-01T00:00:00Z' }),
      group({ status: 'cancelled', lastAt: '2026-07-20T00:00:00Z', firstAt: '2026-07-20T00:00:00Z' }),
    ])
    expect(r.customers[0]?.lastOrderAt).toBe('2026-07-20T00:00:00Z')
  })

  it('takes first-order date from the earliest group regardless of input order', () => {
    const r = page([
      group({ status: 'new', firstAt: '2026-07-20T00:00:00Z', lastAt: '2026-07-20T00:00:00Z' }),
      group({ status: 'completed', firstAt: '2026-03-02T00:00:00Z', lastAt: '2026-04-01T00:00:00Z' }),
    ])
    expect(r.customers[0]?.firstOrderAt).toBe('2026-03-02T00:00:00Z')
  })

  it('reports whole days since the last order, against the injected clock', () => {
    const r = page([group({ lastAt: '2026-07-21T12:00:00Z', firstAt: '2026-07-21T12:00:00Z' })])
    expect(r.customers[0]?.daysSinceLastOrder).toBe(7)
  })

  it('takes name and WhatsApp from the most recent order, not the first', () => {
    const r = page([
      group({ lastAt: '2026-07-01T00:00:00Z', latestName: 'Ali', latestWa: '+60 12-345 6789' }),
      group({ lastAt: '2026-07-25T00:00:00Z', latestName: 'Ali Bin Abu', latestWa: '0123456789' }),
    ])
    expect(r.customers[0]?.name).toBe('Ali Bin Abu')
    expect(r.customers[0]?.wa).toBe('0123456789')
  })

  it('flags a customer with an account when any of their orders carried one', () => {
    const r = page([
      group({ status: 'completed', hasAccount: false }),
      group({ status: 'new', hasAccount: true }),
    ])
    expect(r.customers[0]?.hasAccount).toBe(true)
  })

  it('carries a member’s account email, from their most recent signed-in order', () => {
    const r = page([
      group({ status: 'completed', lastAt: '2026-07-01T00:00:00Z', hasAccount: true, latestEmail: 'old@example.com' }),
      group({ status: 'new', lastAt: '2026-07-20T00:00:00Z', hasAccount: true, latestEmail: 'new@example.com' }),
    ])
    expect(r.customers[0]?.email).toBe('new@example.com')
  })

  it('keeps the email a guest-only bucket cannot supply, however recent that bucket is', () => {
    const r = page([
      group({ status: 'completed', lastAt: '2026-07-01T00:00:00Z', hasAccount: true, latestEmail: 'ali@example.com' }),
      group({ status: 'new', lastAt: '2026-07-20T00:00:00Z', hasAccount: false, latestEmail: null }),
    ])
    expect(r.customers[0]?.email).toBe('ali@example.com')
  })

  it('gives a guest no email, not an empty string', () => {
    const r = page([group({ hasAccount: false })])
    expect(r.customers[0]?.email).toBeNull()
  })
})

describe('shopCustomers — orders that identify nobody', () => {
  it('makes no customer out of an order with no phone key', () => {
    const r = page([group({ phoneKey: null })])
    expect(r.customers).toEqual([])
  })

  it('never merges two keyless orders into one person, however they were named', () => {
    const r = page([
      group({ phoneKey: null, latestName: 'Ahmad' }),
      group({ phoneKey: null, latestName: 'Ahmad' }),
    ])
    expect(r.customers).toEqual([])
  })

  it('counts the orders it dropped, so the totals never silently disagree', () => {
    const r = page([
      group({ phoneKey: '23456789', orders: 2 }),
      group({ phoneKey: null, orders: 3 }),
    ])
    expect(r.unattributedOrders).toBe(3)
  })

  it('counts a dropped cancelled order too — it is still an order the list does not show', () => {
    const r = page([group({ phoneKey: null, status: 'cancelled', orders: 4 })])
    expect(r.unattributedOrders).toBe(4)
  })

  it('reports no unattributed orders when every order carried a number', () => {
    expect(page([group({ orders: 2 })]).unattributedOrders).toBe(0)
  })

  it('reports the distinct customer count alongside the page', () => {
    const r = page([
      group({ phoneKey: '23456789' }),
      group({ phoneKey: '23456789', status: 'new' }),
      group({ phoneKey: '87654321' }),
      group({ phoneKey: null }),
    ])
    expect(r.total).toBe(2)
  })
})

describe('shopCustomers — ordering', () => {
  const quiet = group({ phoneKey: '11111111', lastAt: '2026-01-05T00:00:00Z', firstAt: '2026-01-05T00:00:00Z', orders: 9, total: 900 })
  const recent = group({ phoneKey: '22222222', lastAt: '2026-07-27T00:00:00Z', firstAt: '2026-07-27T00:00:00Z', orders: 1, total: 10 })
  const middling = group({ phoneKey: '33333333', lastAt: '2026-06-01T00:00:00Z', firstAt: '2026-06-01T00:00:00Z', orders: 4, total: 200 })
  const keys = (r: { customers: { phoneKey: string }[] }) => r.customers.map(c => c.phoneKey)

  it('sorts by most recent order when asked for nothing', () => {
    expect(keys(page([quiet, recent, middling]))).toEqual(['22222222', '33333333', '11111111'])
  })

  it('sorts by lifetime spend, biggest first', () => {
    const r = shopCustomers([quiet, recent, middling], [], { now: NOW, sort: 'spend' })
    expect(keys(r)).toEqual(['11111111', '33333333', '22222222'])
  })

  it('sorts by booked orders, most first', () => {
    const r = shopCustomers([quiet, recent, middling], [], { now: NOW, sort: 'orders' })
    expect(keys(r)).toEqual(['11111111', '33333333', '22222222'])
  })

  it('breaks ties on the phone key, so the same data always pages the same way', () => {
    const a = group({ phoneKey: '99999999', orders: 1, total: 50 })
    const b = group({ phoneKey: '11111111', orders: 1, total: 50 })
    expect(keys(shopCustomers([a, b], [], { now: NOW, sort: 'spend' }))).toEqual(['11111111', '99999999'])
    expect(keys(shopCustomers([b, a], [], { now: NOW, sort: 'spend' }))).toEqual(['11111111', '99999999'])
  })

  it('falls back to recency on a sort it does not recognise, rather than returning an arbitrary order', () => {
    const r = shopCustomers([quiet, recent, middling], [], { now: NOW, sort: 'whatever' as 'spend' })
    expect(keys(r)).toEqual(['22222222', '33333333', '11111111'])
  })
})

describe('shopCustomers — searching', () => {
  // The phone key IS the last eight digits of the number beside it — the query derives both
  // from one column, so a fixture where they disagree tests a row that cannot exist.
  const ali = group({ phoneKey: '23456789', latestName: 'Ali', latestWa: '+60 12-345 6789' })
  const siti = group({ phoneKey: '98765432', latestName: 'Siti Nurbaya', latestWa: '0198765432' })
  const found = (search: string, groups = [ali, siti]) =>
    shopCustomers(groups, [], { now: NOW, search }).customers.map(c => c.phoneKey)

  it('matches a name case-insensitively, anywhere in it', () => {
    expect(found('urbay')).toEqual(['98765432'])
    expect(found('ALI')).toEqual(['23456789'])
  })

  it('finds a locally-typed number against an internationally-typed one', () => {
    expect(found('0123456789')).toEqual(['23456789'])
  })

  it('finds an internationally-typed number against a locally-typed one', () => {
    expect(found('+60 19-876 5432')).toEqual(['98765432'])
  })

  it('matches a partial run of digits', () => {
    expect(found('8765')).toEqual(['98765432'])
  })

  it('returns everything for a blank search rather than nothing', () => {
    expect(found('   ')).toHaveLength(2)
  })

  it('matches nobody when nobody matches', () => {
    expect(found('zzz')).toEqual([])
  })

  it('survives a customer with no name and no number on file', () => {
    const nameless = group({ phoneKey: '55555555', latestName: null, latestWa: null })
    expect(found('ali', [ali, nameless])).toEqual(['23456789'])
  })
})

describe('shopCustomers — tag filtering', () => {
  const a = group({ phoneKey: '11111111' })
  const b = group({ phoneKey: '22222222' })
  const records = [
    { phoneKey: '11111111', note: null, tags: ['wholesale', 'vip'] },
    { phoneKey: '22222222', note: null, tags: ['vip'] },
  ]

  it('keeps only customers carrying the tag', () => {
    const r = shopCustomers([a, b], records, { now: NOW, tag: 'wholesale' })
    expect(r.customers.map(c => c.phoneKey)).toEqual(['11111111'])
  })

  it('keeps everyone when no tag is asked for', () => {
    expect(shopCustomers([a, b], records, { now: NOW }).customers).toHaveLength(2)
  })

  it('matches nobody on a tag no customer carries', () => {
    expect(shopCustomers([a, b], records, { now: NOW, tag: 'nope' }).customers).toEqual([])
  })

  it('counts only the matching customers in the total', () => {
    expect(shopCustomers([a, b], records, { now: NOW, tag: 'wholesale' }).total).toBe(1)
  })

  it('still reports every unattributed order, which no filter can explain away', () => {
    const r = shopCustomers([a, b, group({ phoneKey: null, orders: 3 })], records, { now: NOW, tag: 'wholesale' })
    expect(r.unattributedOrders).toBe(3)
  })
})

describe('shopCustomers — what the merchant wrote', () => {
  const a = group({ phoneKey: '11111111' })
  const b = group({ phoneKey: '22222222' })

  it('attaches a note and tags to the customer they were written against', () => {
    const r = shopCustomers([a, b], [{ phoneKey: '11111111', note: 'no peanuts', tags: ['vip'] }], { now: NOW })
    const first = r.customers.find(c => c.phoneKey === '11111111')
    expect(first?.note).toBe('no peanuts')
    expect(first?.tags).toEqual(['vip'])
  })

  it('leaves a customer the merchant never wrote about blank, not undefined', () => {
    const r = shopCustomers([a, b], [{ phoneKey: '11111111', note: 'x', tags: ['vip'] }], { now: NOW })
    const second = r.customers.find(c => c.phoneKey === '22222222')
    expect(second?.note).toBeNull()
    expect(second?.tags).toEqual([])
  })

  it('ignores a written row whose customer has never ordered', () => {
    const r = shopCustomers([a], [{ phoneKey: 'nobody00', note: 'orphan', tags: [] }], { now: NOW })
    expect(r.customers).toHaveLength(1)
    expect(r.customers[0]?.note).toBeNull()
  })
})

describe('shopCustomers — paging', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    group({ phoneKey: `1111111${i}`, orders: 7 - i, total: (7 - i) * 10 }))
  const keysOf = (opts: Parameters<typeof shopCustomers>[2]) =>
    shopCustomers(many, [], opts).customers.map(c => c.phoneKey)

  it('returns the first page when asked for one', () => {
    expect(keysOf({ now: NOW, sort: 'orders', page: 1, pageSize: 3 }))
      .toEqual(['11111110', '11111111', '11111112'])
  })

  it('returns a later page as the next slice, not an overlapping one', () => {
    expect(keysOf({ now: NOW, sort: 'orders', page: 2, pageSize: 3 }))
      .toEqual(['11111113', '11111114', '11111115'])
  })

  it('returns a short final page rather than padding it', () => {
    expect(keysOf({ now: NOW, sort: 'orders', page: 3, pageSize: 3 })).toEqual(['11111116'])
  })

  it('returns nothing past the end, and does not throw', () => {
    expect(keysOf({ now: NOW, page: 99, pageSize: 3 })).toEqual([])
  })

  it('reports the unpaged total, so the merchant can see what they are a slice of', () => {
    expect(shopCustomers(many, [], { now: NOW, page: 1, pageSize: 3 }).total).toBe(7)
  })

  it('returns every customer when no paging is asked for', () => {
    expect(keysOf({ now: NOW })).toHaveLength(7)
  })
})


// ── the shop's tag vocabulary (#150) ─────────────────────────────────────────
//
// What the tag suggestions in the drawer are drawn from. Every rule worth arguing about is
// here: what the list contains, in what order, and what it deliberately does NOT respond to.

describe('shopCustomers — the shop’s tag vocabulary', () => {
  const rec = (phoneKey: string, tags: string[]): ShopCustomerRecord => ({ phoneKey, note: null, tags })

  it('is empty for a shop that has never written a tag', () => {
    expect(page([group({})]).shopTags).toEqual([])
  })

  it('is empty when a row exists but carries no tags', () => {
    expect(page([group({})], [rec('23456789', [])]).shopTags).toEqual([])
  })

  it('collects every tag the shop has used, across customers', () => {
    const r = page(
      [group({ phoneKey: '23456789' }), group({ phoneKey: '87654321' })],
      [rec('23456789', ['office']), rec('87654321', ['wholesale'])],
    )
    expect(r.shopTags).toEqual(['office', 'wholesale'])
  })

  it('lists a tag once however many customers carry it', () => {
    const r = page(
      [group({ phoneKey: '23456789' }), group({ phoneKey: '87654321' })],
      [rec('23456789', ['vip']), rec('87654321', ['vip'])],
    )
    expect(r.shopTags).toEqual(['vip'])
  })

  it('sorts case-insensitively, so two spellings of one tag land side by side', () => {
    const r = page([group({})], [rec('23456789', ['zebra', 'VIP', 'apple', 'vip'])])
    expect(r.shopTags).toEqual(['apple', 'VIP', 'vip', 'zebra'])
  })

  it('keeps each spelling as the merchant typed it — this list offers, it does not normalise', () => {
    const r = page([group({})], [rec('23456789', ['V.I.P.', 'VIP'])])
    expect(r.shopTags).toEqual(['V.I.P.', 'VIP'])
  })

  it('is not narrowed by a tag filter — the vocabulary is what the filter chooses from', () => {
    const r = shopCustomers(
      [group({ phoneKey: '23456789' }), group({ phoneKey: '87654321' })],
      [rec('23456789', ['vip']), rec('87654321', ['office'])],
      { now: NOW, tag: 'vip' },
    )
    expect(r.customers).toHaveLength(1)
    expect(r.shopTags).toEqual(['office', 'vip'])
  })

  it('is not narrowed by a search', () => {
    const r = shopCustomers(
      [group({ phoneKey: '23456789', latestName: 'Ali' }), group({ phoneKey: '87654321', latestName: 'Bee' })],
      [rec('23456789', ['vip']), rec('87654321', ['office'])],
      { now: NOW, search: 'Ali' },
    )
    expect(r.customers).toHaveLength(1)
    expect(r.shopTags).toEqual(['office', 'vip'])
  })

  it('is not narrowed by paging — page 2 offers the same tags as page 1', () => {
    const groups = [group({ phoneKey: '23456789' }), group({ phoneKey: '87654321' })]
    const records = [rec('23456789', ['vip']), rec('87654321', ['office'])]
    const opts = { now: NOW, sort: 'orders' as const, pageSize: 1 }
    expect(shopCustomers(groups, records, { ...opts, page: 1 }).shopTags).toEqual(['office', 'vip'])
    expect(shopCustomers(groups, records, { ...opts, page: 2 }).shopTags).toEqual(['office', 'vip'])
  })

  it('keeps a tag written against a customer who has since stopped appearing in the orders', () => {
    const r = shopCustomers([group({})], [rec('nobody00', ['catering'])], { now: NOW })
    expect(r.customers).toHaveLength(1)
    expect(r.shopTags).toEqual(['catering'])
  })
})

describe('shopCustomers — segments', () => {
  // Member = a shop customer with an account (CONTEXT.md → Shop customer → Member).
  const ali = () => group({ phoneKey: '23456789', latestName: 'Ali', hasAccount: true })
  const bob = () => group({ phoneKey: '87654321', latestName: 'Bob', hasAccount: false })

  it('keeps only members when asked for the members segment', () => {
    const r = shopCustomers([ali(), bob()], [], { now: NOW, segment: 'members' })
    expect(r.customers.map(c => c.name)).toEqual(['Ali'])
    expect(r.total).toBe(1)
  })

  it('keeps everyone for the all segment, and when no segment is asked for', () => {
    expect(shopCustomers([ali(), bob()], [], { now: NOW, segment: 'all' }).total).toBe(2)
    expect(shopCustomers([ali(), bob()], [], { now: NOW }).total).toBe(2)
  })

  it('counts a member’s guest orders as the member’s — membership is per customer, not per order', () => {
    // One signed-in order and nine as a guest, under one phone: one member, ten orders.
    const r = shopCustomers([
      group({ status: 'completed', orders: 1, total: 10, hasAccount: true }),
      group({ status: 'new', orders: 9, total: 90, hasAccount: false }),
    ], [], { now: NOW, segment: 'members' })
    expect(r.customers).toHaveLength(1)
    expect(r.customers[0]?.bookedOrders).toBe(10)
  })

  it('still reports every unattributed order, which no segment can explain away', () => {
    const r = shopCustomers([ali(), group({ phoneKey: null, orders: 3 })], [], { now: NOW, segment: 'members' })
    expect(r.unattributedOrders).toBe(3)
  })
})

describe('shopCustomers — the stat row', () => {
  const ali = () => group({ phoneKey: '23456789', latestName: 'Ali', hasAccount: true, orders: 3, total: 30 })
  const bob = () => group({ phoneKey: '87654321', latestName: 'Bob', hasAccount: false, orders: 2, total: 50 })

  it('sums customers, booked orders and spend over the matched rows', () => {
    const r = shopCustomers([ali(), bob()], [], { now: NOW })
    expect(r.stats).toEqual({ customers: 2, bookedOrders: 5, spend: 80 })
  })

  it('follows the segment, so the members page and its rows share one scope', () => {
    const r = shopCustomers([ali(), bob()], [], { now: NOW, segment: 'members' })
    expect(r.stats).toEqual({ customers: 1, bookedOrders: 3, spend: 30 })
  })

  it('follows the search and the tag filter, exactly as `total` does', () => {
    const records = [{ phoneKey: '87654321', note: null, tags: ['vip'] }]
    expect(shopCustomers([ali(), bob()], records, { now: NOW, search: 'bob' }).stats).toEqual({ customers: 1, bookedOrders: 2, spend: 50 })
    expect(shopCustomers([ali(), bob()], records, { now: NOW, tag: 'vip' }).stats).toEqual({ customers: 1, bookedOrders: 2, spend: 50 })
  })

  it('is taken before paging — a page is a slice of it', () => {
    const r = shopCustomers([ali(), bob()], [], { now: NOW, page: 1, pageSize: 1 })
    expect(r.customers).toHaveLength(1)
    expect(r.stats.customers).toBe(2)
  })

  it('excludes cancelled orders, the booked rule the rows already follow', () => {
    const r = shopCustomers([ali(), group({ phoneKey: '23456789', status: 'cancelled', orders: 4, total: 400 })], [], { now: NOW })
    expect(r.stats).toEqual({ customers: 1, bookedOrders: 3, spend: 30 })
  })

  it('sums money in cents, so a spend never ends in floating dust', () => {
    const r = shopCustomers([group({ phoneKey: '1', total: 0.1 }), group({ phoneKey: '2', total: 0.2 })], [], { now: NOW })
    expect(r.stats.spend).toBe(0.3)
  })

  it('is all zeroes for an empty shop', () => {
    expect(shopCustomers([], [], { now: NOW }).stats).toEqual({ customers: 0, bookedOrders: 0, spend: 0 })
  })
})
