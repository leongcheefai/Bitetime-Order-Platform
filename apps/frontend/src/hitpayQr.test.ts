// src/hitpayQr.test.ts
import { describe, it, expect } from 'vitest'
import { secondsLeft, formatCountdown, paysWithHitpay, isPaid, isCancelled, POLL_MS } from './hitpayQr'

describe('hitpayQr', () => {
  it('counts down to zero and never below', () => {
    const now = Date.parse('2026-10-02T10:00:00Z')
    expect(secondsLeft('2026-10-02T10:15:00Z', now)).toBe(900)
    expect(secondsLeft('2026-10-02T10:00:00.400Z', now)).toBe(1)
    expect(secondsLeft('2026-10-02T09:59:00Z', now)).toBe(0)
  })
  it('formats m:ss', () => {
    expect(formatCountdown(900)).toBe('15:00')
    expect(formatCountdown(61)).toBe('1:01')
    expect(formatCountdown(0)).toBe('0:00')
  })
  it('pays with HitPay only for a connected shop and an unpaid order', () => {
    expect(paysWithHitpay({ hitpay_connected: true }, 'pending_payment')).toBe(true)
    expect(paysWithHitpay({ hitpay_connected: true }, 'new')).toBe(false)
    expect(paysWithHitpay({ hitpay_connected: false }, 'pending_payment')).toBe(false)
    expect(paysWithHitpay({}, 'pending_payment')).toBe(false)
  })
  it('reads paid from the payment row or from an order that moved on', () => {
    expect(isPaid({ payment: 'completed', orderStatus: 'new', expiresAt: null })).toBe(true)
    expect(isPaid({ payment: 'pending', orderStatus: 'new', expiresAt: null })).toBe(true)
    expect(isPaid({ payment: 'pending', orderStatus: 'pending_payment', expiresAt: null })).toBe(false)
    expect(isPaid({ payment: 'expired', orderStatus: 'pending_payment', expiresAt: null })).toBe(false)
  })
  it('never reads a cancelled order as paid', () => {
    expect(isPaid({ payment: 'pending', orderStatus: 'cancelled', expiresAt: null })).toBe(false)
    expect(isCancelled({ payment: 'pending', orderStatus: 'cancelled', expiresAt: null })).toBe(true)
    expect(isCancelled({ payment: 'pending', orderStatus: 'pending_payment', expiresAt: null })).toBe(false)
  })
  it('polls every 3 seconds', () => {
    expect(POLL_MS).toBe(3000)
  })
})
