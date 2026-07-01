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
