import { describe, it, expect, vi } from 'vitest'
import { buildOrderMessage, notifyOrderPlaced, type TelegramSend } from '../../src/notify.js'

// Minimal fake of the service-role client: each table returns a preset row.
function fakeDb(tables: Record<string, any>) {
  return {
    from(table: string) {
      const result = tables[table] ?? { data: null, error: null }
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => result,
      }
      return chain
    },
  }
}

const ORDER = {
  order_number: 'BT-260629-0051',
  customer_name: 'Sam',
  customer_wa: '0123456789',
  mode: 'delivery',
  address: '12 Jalan Test',
  items: [{ name: 'Cookie', qty: 2, price: 5 }],
  shipping_fee: 8,
  total: 18,
}

describe('buildOrderMessage', () => {
  it('renders order fields and an itemised total, defaulting to RM for legacy rows', () => {
    const msg = buildOrderMessage(ORDER, 'Cookie Corner')
    expect(msg).toContain('Cookie Corner')
    expect(msg).toContain('BT-260629-0051')
    expect(msg).toContain('Cookie × 2 — RM 10.00')
    expect(msg).toContain('*Shipping:* RM 8.00')
    expect(msg).toContain('*Total: RM 18.00*')
  })

  it('renders amounts in the order\'s stamped currency', () => {
    const sgd = buildOrderMessage({ ...ORDER, currency: 'SGD' }, 'Cookie Corner')
    expect(sgd).toContain('Cookie × 2 — S$ 10.00')
    expect(sgd).toContain('*Total: S$ 18.00*')
  })

  it('omits cents for a 0-decimal currency', () => {
    const jpy = buildOrderMessage(
      { ...ORDER, currency: 'JPY', items: [{ name: 'Cookie', qty: 2, price: 500 }], shipping_fee: 800, total: 1800 },
      'Cookie Corner',
    )
    expect(jpy).toContain('Cookie × 2 — ¥ 1,000')
    expect(jpy).toContain('*Total: ¥ 1,800*')
  })

  it('prints the fulfilment date when the order carries one', () => {
    const msg = buildOrderMessage({ ...ORDER, fulfil_date: '2026-07-22' })
    expect(msg).toContain('*Date:* 2026-07-22')
  })

  it('omits the line entirely for a legacy order with no date', () => {
    const msg = buildOrderMessage({ ...ORDER, fulfil_date: null })
    expect(msg).not.toContain('*Date:*')
  })

  it('carries the delivery distance so a rider can be dispatched without opening the dashboard', () => {
    const msg = buildOrderMessage({ ...ORDER, delivery_distance_km: 25.2, shipping_fee: 31.2 }, 'Cookie Corner')
    expect(msg).toContain('*Distance:* 25.2 km')
    expect(msg).toContain('*Shipping:* RM 31.20')
  })

  it('omits the distance line entirely for a region-priced order', () => {
    expect(buildOrderMessage(ORDER, 'Cookie Corner')).not.toContain('Distance')
  })

  // ORDER has no delivery_distance_km key at all (the absent shape a plain object gives you).
  // A real Postgres row instead returns the column as an explicit SQL null — a different shape
  // in JS (`null` vs `undefined`) that must be excluded the same way, not just the absent one.
  it('omits the distance line for an explicit null, not just a missing key', () => {
    expect(buildOrderMessage({ ...ORDER, delivery_distance_km: null }, 'Cookie Corner')).not.toContain('Distance')
  })

  it('names the fulfilment method rather than printing the column value', () => {
    expect(buildOrderMessage({ ...ORDER, mode: 'express' })).toContain('*Mode:* Express delivery')
    expect(buildOrderMessage({ ...ORDER, mode: 'delivery' })).toContain('*Mode:* Delivery')
    expect(buildOrderMessage({ ...ORDER, mode: 'pickup' })).toContain('*Mode:* Pickup')
  })

  it('prints an unknown mode as-is rather than dropping the line', () => {
    // A row written by an older build still has to say something. Losing the line entirely is
    // worse than an unpolished one — the merchant reads this to know whether to expect a rider.
    expect(buildOrderMessage({ ...ORDER, mode: 'sameday' })).toContain('*Mode:* sameday')
  })

  it('carries the unit/floor so the rider can complete the drop', () => {
    const msg = buildOrderMessage({
      ...ORDER,
      address: { line1: '12 Jalan Test', unit: 'A-3-2', postcode: '50000', city: 'Kuala Lumpur', state: 'Selangor' },
    })
    // The whole address line, not two substrings: the unit must come FIRST, where a rider reads
    // it before the street. Two `toContain`s pass just as happily with the unit appended after
    // the state, which is the one placement the comment on `formatAddress` rules out.
    expect(msg).toContain('*Address:* A-3-2, 12 Jalan Test, 50000 Kuala Lumpur, Selangor')
  })
})

describe('notifyOrderPlaced', () => {
  const send: TelegramSend = vi.fn(async () => {})

  it('rejects missing input without touching the db', async () => {
    const db = fakeDb({})
    expect(await notifyOrderPlaced(db, send, { merchantId: '', orderNumber: '' }))
      .toEqual({ ok: false, error: 'missing merchantId or orderNumber' })
  })

  it('returns order not found when the order does not exist', async () => {
    const db = fakeDb({ orders: { data: null, error: null } })
    expect(await notifyOrderPlaced(db, send, { merchantId: 'm1', orderNumber: 'X' }))
      .toEqual({ ok: false, error: 'order not found' })
  })

  it('skips (still ok) when the merchant has no telegram configured', async () => {
    const db = fakeDb({ orders: { data: ORDER, error: null }, merchant_secrets: { data: null, error: null } })
    expect(await notifyOrderPlaced(db, send, { merchantId: 'm1', orderNumber: ORDER.order_number }))
      .toEqual({ ok: true, skipped: true })
  })

  it('sends with the merchant secret and reports ok', async () => {
    const spy = vi.fn(async () => {})
    const db = fakeDb({
      orders: { data: ORDER, error: null },
      merchant_secrets: { data: { tg_token: 'TOK', tg_chat_id: 'CHAT' }, error: null },
      merchants: { data: { name: 'Cookie Corner' }, error: null },
    })
    const result = await notifyOrderPlaced(db, spy, { merchantId: 'm1', orderNumber: ORDER.order_number })
    expect(result).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledWith('TOK', 'CHAT', expect.stringContaining('BT-260629-0051'))
  })

  it('reports the error when the send fails', async () => {
    const boom: TelegramSend = vi.fn(async () => { throw new Error('Telegram sendMessage failed: 401') })
    const db = fakeDb({
      orders: { data: ORDER, error: null },
      merchant_secrets: { data: { tg_token: 'TOK', tg_chat_id: 'CHAT' }, error: null },
      merchants: { data: { name: 'X' }, error: null },
    })
    expect(await notifyOrderPlaced(db, boom, { merchantId: 'm1', orderNumber: ORDER.order_number }))
      .toEqual({ ok: false, error: 'Telegram sendMessage failed: 401' })
  })
})
