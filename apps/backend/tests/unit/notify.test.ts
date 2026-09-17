import { describe, it, expect, vi } from 'vitest'
import { MAX_CART_LINES } from '@bitetime/shared'
import { buildOrderMessage, notifyOrderPlaced, TELEGRAM_MAX_CHARS, type TelegramSend } from '../../src/notify.js'

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

  it('prints the slot on the date line when the order carries one', () => {
    const msg = buildOrderMessage({ ...ORDER, fulfil_date: '2026-07-22', fulfil_time_from: '14:00:00', fulfil_time_to: '15:00:00' })
    expect(msg).toContain('*Date:* 2026-07-22 14:00 – 15:00')
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

// Telegram REFUSES an over-long sendMessage rather than truncating it, and notify runs after the
// order has already committed — so an unguarded overflow is a committed order the merchant never
// hears about at all. A full cart (MAX_CART_LINES) already sits at the ceiling before the header
// and totals are counted; #145's per-item selections line doubles the item block.
describe('buildOrderMessage length cap', () => {
  const bigCart = (lines: number, name = 'Chocolate chip cookie box') =>
    Array.from({ length: lines }, (_, n) => ({ name: `${name} ${n + 1}`, qty: 3, price: 12.5 }))

  it('leaves a normal order untouched', () => {
    // The guard must be invisible on the orders that do fit — no notice, no dropped lines.
    const msg = buildOrderMessage(ORDER, 'Cookie Corner')
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
    expect(msg).not.toContain('items shown')
    expect(msg).toContain('*Total: RM 18.00*')
  })

  it('keeps a legal-but-huge cart inside the sendMessage ceiling', () => {
    const msg = buildOrderMessage({ ...ORDER, items: bigCart(MAX_CART_LINES) }, 'Cookie Corner')
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
  })

  it('still carries the order number and the money when it truncates', () => {
    // What the merchant acts on: which order this is, and what it is worth. The item block is
    // the part that gives way, so these survive at the head and the tail.
    const msg = buildOrderMessage(
      { ...ORDER, items: bigCart(MAX_CART_LINES), total: 3750 },
      'Cookie Corner',
    )
    expect(msg).toContain('*Order No.:* BT-260629-0051')
    expect(msg).toContain('*Shipping:* RM 8.00')
    expect(msg).toContain('*Total: RM 3,750.00*')
  })

  it('says plainly that it was truncated, with how many items are missing', () => {
    // Silent truncation reads as a complete order (CONTEXT.md → Merchant order reads): the
    // merchant has to know there is more, and where to go for it.
    const msg = buildOrderMessage({ ...ORDER, items: bigCart(MAX_CART_LINES) }, 'Cookie Corner')
    const m = msg.match(/⚠️ \*(\d+) of (\d+) items shown — open your dashboard for the full order\.\*/)
    expect(m).not.toBeNull()
    const [, shown, total] = m!
    expect(Number(total)).toBe(MAX_CART_LINES)
    expect(Number(shown)).toBeGreaterThan(0)
    expect(Number(shown)).toBeLessThan(MAX_CART_LINES)
    // The count is the truth, not a decoration: exactly that many item lines survived.
    expect(msg.split('\n').filter(l => l.startsWith('• ')).length).toBe(Number(shown))
  })

  it('keeps the Markdown parseable — an unclosed * is itself a 400', () => {
    // The message goes out with parse_mode: 'Markdown'. A cut that lands mid-`*bold*` turns a
    // length failure into a parse failure and loses the notification just the same.
    const msg = buildOrderMessage({ ...ORDER, items: bigCart(MAX_CART_LINES) }, 'Cookie Corner')
    expect((msg.match(/\*/g) ?? []).length % 2).toBe(0)
  })

  it('survives a head that alone overflows, keeping the order number', () => {
    // A pathologically long shop name or address leaves nothing to drop. Everything else can go;
    // the order number cannot, because without it the merchant cannot find the order at all.
    const msg = buildOrderMessage(
      { ...ORDER, address: 'x'.repeat(TELEGRAM_MAX_CHARS * 2), items: bigCart(MAX_CART_LINES) },
      'C'.repeat(TELEGRAM_MAX_CHARS),
    )
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
    expect(msg).toContain('BT-260629-0051')
    expect(msg).toContain('open your dashboard')
    expect((msg.match(/\*/g) ?? []).length % 2).toBe(0)
  })

  it('holds when an item block twice the size lands (#145 menu options)', () => {
    // The selections sub-line #145 adds roughly doubles each item; the guard is on the rendered
    // length, not on a count, so it absorbs that without a second fix.
    const withOptions = Array.from({ length: MAX_CART_LINES }, (_, n) => ({
      name: `Cookie box ${n + 1}\n    Flavour: Chocolate chip · Size: Large · Packaging: Gift box`,
      qty: 3,
      price: 12.5,
    }))
    const msg = buildOrderMessage({ ...ORDER, items: withOptions }, 'Cookie Corner')
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
    expect(msg).toContain('*Order No.:* BT-260629-0051')
    expect(msg).toContain('items shown')
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

  // The tier is gone (#222), so a configured token IS the entitlement. This is the case that used
  // to be refused for being on the wrong plan; it must now send.
  it('sends for any shop that has configured a token', async () => {
    const spy = vi.fn(async () => {})
    const db = fakeDb({
      orders: { data: ORDER, error: null },
      merchant_secrets: { data: { tg_token: 'TOK', tg_chat_id: 'CHAT' }, error: null },
      merchants: { data: { name: 'Cookie Corner' }, error: null },
    })
    expect(await notifyOrderPlaced(db, spy, { merchantId: 'm1', orderNumber: ORDER.order_number }))
      .toEqual({ ok: true })
    expect(spy).toHaveBeenCalledOnce()
  })

})

describe('menu options on the ticket (#145)', () => {
  const order = (items: unknown[]) => ({
    order_number: 'BT-260728-0050', customer_name: 'Ah Meng', customer_wa: '60123456789',
    mode: 'pickup', items, total: 30, currency: 'MYR',
  })

  // A SUB-LINE. The person packing the box scans for quantities per flavour; inline parentheses
  // between the name and the price is the format most likely to be misread at speed.
  it('lists the chosen options under the item', () => {
    const msg = buildOrderMessage(order([{
      name: 'Box of 6', qty: 1, price: 30,
      selections: [
        { groupId: 'f', groupName: 'Flavours', optionId: 'c', optionName: 'Chocolate', qty: 3, delta: 0 },
        { groupId: 'f', groupName: 'Flavours', optionId: 'v', optionName: 'Vanilla', qty: 3, delta: 0 },
      ],
    }]) as never)
    expect(msg).toContain('↳ Chocolate ×3, Vanilla ×3')
    // The sub-line sits under its item, not spliced into it.
    expect(msg.indexOf('Box of 6')).toBeLessThan(msg.indexOf('↳ Chocolate'))
  })

  // Every order placed before this feature existed. `selections` is simply absent, and absent
  // must read as "no options" rather than as a crash in the one call that tells a merchant an
  // order arrived at all.
  it('renders an order that predates menu options unchanged', () => {
    const msg = buildOrderMessage(order([{ name: 'Cookie', qty: 2, price: 5 }]) as never)
    expect(msg).toContain('Cookie')
    expect(msg).not.toContain('↳')
  })

  // No `*` markers in the sub-line: the send is Markdown, and an unclosed marker is itself a 400
  // — a decoration that loses the whole notification.
  it('adds no Markdown markers that could break the send', () => {
    const msg = buildOrderMessage(order([{
      name: 'Latte', qty: 1, price: 12,
      selections: [{ groupId: 'm', groupName: 'Milk', optionId: 'o', optionName: 'Oat', qty: 1, delta: 2 }],
    }]) as never)
    const subLine = msg.split('\n').find(l => l.includes('↳')) ?? ''
    expect(subLine).not.toContain('*')
  })
})
