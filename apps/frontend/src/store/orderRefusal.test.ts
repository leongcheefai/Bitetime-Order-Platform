import { describe, it, expect } from 'vitest'
import { ORDER_REFUSALS, QUOTE_REFUSALS } from '@bitetime/shared'
import { orderRefusalPlan, quoteRefusalPlan, type OrderRefusalCtx, type QuoteRefusalCtx } from './orderRefusal'

const t = (en: string) => en
const ctx = (over: Partial<OrderRefusalCtx> = {}): OrderRefusalCtx =>
  ({ t, pickupEscape: false, canRequote: false, ...over })

const GENERIC = 'Failed to place order. Please try again.'

describe('orderRefusalPlan', () => {
  it.each([...ORDER_REFUSALS, 'network' as const])('%s has copy of its own', (code) => {
    // `order_failed` is the one code that legitimately wears the generic sentence: it is a
    // server fault with no reason to give. Everything else knows why it refused and must say so.
    const { message } = orderRefusalPlan(code, ctx())
    if (code === 'order_failed') expect(message).toBe(GENERIC)
    else expect(message).not.toBe(GENERIC)
  })

  it('falls back rather than showing a stale client a raw code', () => {
    // A deployed browser is always older than the server. An unknown code must read as a
    // sentence, never as `some_new_code` on the checkout screen.
    expect(orderRefusalPlan('some_new_code' as never, ctx()).message).toBe(GENERIC)
    expect(orderRefusalPlan(undefined, ctx()).message).toBe(GENERIC)
  })

  it('adopts the clock before it re-quotes', () => {
    // Load-bearing ORDER, not a list. `refresh_sources` carries the server clock out of the
    // refusal body; re-quoting first would re-quote against the skewed offset and be refused
    // again — the permanent refusal loop of I-3, #69.
    const { actions } = orderRefusalPlan('price_changed', ctx({ canRequote: true }))
    expect(actions).toEqual(['refresh_sources', 'clear_quote', 'requote'])
  })

  it('does not re-quote an order that has nothing to re-quote', () => {
    const { actions } = orderRefusalPlan('price_changed', ctx({ canRequote: false }))
    expect(actions).toEqual(['refresh_sources', 'clear_quote'])
  })

  it('drops the voucher on every voucher refusal', () => {
    for (const code of ['voucher_not_found', 'voucher_customer_limit_reached', 'voucher_fully_used', 'voucher_requires_account', 'voucher_expired', 'voucher_below_minimum'] as const) {
      expect(orderRefusalPlan(code, ctx()).actions).toEqual(['drop_voucher'])
    }
  })

  it('refetches the menu when something in the cart went away', () => {
    expect(orderRefusalPlan('product_unavailable', ctx()).actions).toEqual(['refresh_sources'])
  })

  it('clears the date so the stale one leaves the grid', () => {
    expect(orderRefusalPlan('fulfil_date_unavailable', ctx()).actions).toEqual(['clear_date'])
    expect(orderRefusalPlan('fulfil_date_required', ctx()).actions).toEqual(['clear_date'])
  })

  it('clears the slot, not the date, on a slot refusal', () => {
    expect(orderRefusalPlan('fulfil_time_unavailable', ctx()).actions).toEqual(['clear_slot'])
    expect(orderRefusalPlan('fulfil_time_required', ctx()).actions).toEqual(['clear_slot'])
  })

  it('offers pickup only when the shop offers pickup', () => {
    // Pointing at a button that is not on screen is worse than no suggestion at all.
    for (const code of ['delivery_out_of_range', 'distance_lookup_failed'] as const) {
      expect(orderRefusalPlan(code, ctx({ pickupEscape: true })).message).toContain('pickup')
      expect(orderRefusalPlan(code, ctx({ pickupEscape: false })).message).not.toContain('pickup')
    }
  })

  it('never promises a retry for the distance lookup', () => {
    // The same code is thrown by a shop whose daily Google ceiling is spent, and that does not
    // clear for up to 24 hours — "in a moment" is a lie for that shop.
    expect(orderRefusalPlan('distance_lookup_failed', ctx()).message).not.toContain('moment')
  })

  it('names the caps the customer has to get under', () => {
    const { message } = orderRefusalPlan('invalid_body', ctx())
    expect(message).toContain('1000')
    expect(message).toContain('100')
  })

  it('asks for nothing back when the shop is closed', () => {
    expect(orderRefusalPlan('merchant_inactive', ctx()).actions).toEqual([])
    expect(orderRefusalPlan('merchant_not_found', ctx()).actions).toEqual([])
  })
})

const qctx = (over: Partial<QuoteRefusalCtx> = {}): QuoteRefusalCtx =>
  ({ t, pickupEscape: false, ...over })

const QUOTE_GENERIC = 'We could not work out the delivery fee just now. Please try again.'

describe('quoteRefusalPlan', () => {
  it.each([...QUOTE_REFUSALS, 'network' as const])('%s has a message', (code) => {
    expect(quoteRefusalPlan(code, qctx()).length).toBeGreaterThan(0)
  })

  it('stops telling a quota-exhausted shop to try again', () => {
    // The collapse this replaces mapped `quota_exceeded` onto `lookup_failed`'s copy, which says
    // "try again" — for a ceiling that does not clear for up to 24 hours.
    const msg = quoteRefusalPlan('quota_exceeded', qctx())
    expect(msg).not.toBe(QUOTE_GENERIC)
    expect(msg).not.toContain('try again')
  })

  it('says a closed shop is closed instead of blaming the lookup', () => {
    for (const code of ['merchant_inactive', 'merchant_not_found'] as const) {
      expect(quoteRefusalPlan(code, qctx())).toBe('This shop is not taking orders right now.')
    }
  })

  it('keeps out-of-range as one message for both facts', () => {
    expect(quoteRefusalPlan('out_of_range', qctx())).toContain('does not deliver')
  })

  it('offers pickup only when the shop offers pickup', () => {
    expect(quoteRefusalPlan('lookup_failed', qctx({ pickupEscape: true }))).toContain('pickup')
    expect(quoteRefusalPlan('lookup_failed', qctx({ pickupEscape: false }))).not.toContain('pickup')
  })

  it('falls back for a stale client', () => {
    expect(quoteRefusalPlan('some_new_code' as never, qctx())).toBe(QUOTE_GENERIC)
  })
})

describe('option_unavailable', () => {
  // Order as DATA, for the same reason price_changed's is: repairing against the stale menu
  // would keep the very option that was just withdrawn, and the retry would be refused again.
  it('refreshes the menu BEFORE repairing the lines', () => {
    const { actions } = orderRefusalPlan('option_unavailable', ctx())
    expect(actions).toEqual(['refresh_sources', 'repair_selections'])
  })

  // product_unavailable removes the item; this one keeps it and fixes the choice. Telling a
  // customer their coffee is gone because the oat milk ran out is the wrong sentence.
  it('does not reuse the product_unavailable copy', () => {
    const optionMsg = orderRefusalPlan('option_unavailable', ctx()).message
    const productMsg = orderRefusalPlan('product_unavailable', ctx()).message
    expect(optionMsg).not.toBe(productMsg)
  })
})
