import { describe, it, expect } from 'vitest'
import { ORDER_EVENT_KINDS, type OrderEvent } from '@bitetime/shared'
import { orderEventLine } from './orderEventLine'

const en = (e: string) => e
const zh = (_e: string, z?: string) => z ?? ''

function ev(partial: Partial<OrderEvent> & { kind: OrderEvent['kind'] }): OrderEvent {
  return { id: '1', actor_kind: 'merchant', actor_id: null, detail: {}, created_at: '2026-09-04T03:02:00.000Z', ...partial }
}

describe('orderEventLine', () => {
  it('has words for every kind the backend can write, in both languages', () => {
    // The backend's CHECK constraint and this table must agree: a kind that reaches the drawer
    // without a sentence would render as nothing, which reads as "nothing happened".
    for (const kind of ORDER_EVENT_KINDS) {
      expect(orderEventLine(ev({ kind }), en).length, kind).toBeGreaterThan(0)
      expect(orderEventLine(ev({ kind }), zh).length, kind).toBeGreaterThan(0)
    }
  })

  it('says who did it only when it was not the merchant', () => {
    expect(orderEventLine(ev({ kind: 'payment_proof_uploaded', actor_kind: 'customer' }), en)).toBe('Customer uploaded a payment proof')
    expect(orderEventLine(ev({ kind: 'merchant_payment_proof_uploaded' }), en)).toBe('You filed a payment proof')
  })

  it('reads a status move as the merchant\'s choice or the system\'s consequence', () => {
    expect(orderEventLine(ev({ kind: 'status_changed', detail: { from: 'new', to: 'preparing' } }), en)).toBe('You marked it Preparing')
    expect(orderEventLine(ev({ kind: 'status_changed', actor_kind: 'system', detail: { from: 'pending_payment', to: 'new' } }), en))
      .toBe('Moved to New automatically')
  })

  it('tells a pending birth from a paid one', () => {
    expect(orderEventLine(ev({ kind: 'created', actor_kind: 'customer', detail: { status: 'new' } }), en)).toBe('Order placed')
    expect(orderEventLine(ev({ kind: 'created', actor_kind: 'customer', detail: { status: 'pending_payment' } }), en)).toBe('Order placed, awaiting payment')
  })

  it('names the courier and the tracking number, and says when one was cleared', () => {
    expect(orderEventLine(ev({ kind: 'courier_changed', detail: { from: null, to: 'jnt' } }), en)).toBe('You set the courier to J&T Express')
    expect(orderEventLine(ev({ kind: 'courier_changed', detail: { from: 'jnt', to: null } }), en)).toBe('You cleared the courier')
    expect(orderEventLine(ev({ kind: 'awb_changed', detail: { from: null, to: 'JT123' } }), en)).toBe('You set the tracking number to JT123')
    expect(orderEventLine(ev({ kind: 'awb_changed', detail: { from: 'JT123', to: null } }), en)).toBe('You cleared the tracking number')
  })

  it('reads a date move as the day it landed on, and says when a legacy order gained one', () => {
    expect(orderEventLine(ev({ kind: 'fulfil_date_changed', detail: { from: '2026-07-21', to: '2026-07-25' } }), en))
      .toBe('You moved the date from 21 Jul 2026 to 25 Jul 2026')
    expect(orderEventLine(ev({ kind: 'fulfil_date_changed', detail: { from: null, to: '2026-07-25' } }), en))
      .toBe('You set the date to 25 Jul 2026')
  })

  it('never shows the note', () => {
    expect(orderEventLine(ev({ kind: 'note_changed' }), en)).toBe('You edited the note')
  })

  it('names the voucher a cancellation returned', () => {
    expect(orderEventLine(ev({ kind: 'voucher_released', actor_kind: 'system', detail: { code: 'SAVE5' } }), en)).toBe('Voucher SAVE5 use returned')
    expect(orderEventLine(ev({ kind: 'voucher_restored', actor_kind: 'system', detail: { code: 'SAVE5' } }), en)).toBe('Voucher SAVE5 use taken back')
  })
})
