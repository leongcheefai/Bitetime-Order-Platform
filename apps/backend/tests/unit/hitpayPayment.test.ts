// tests/unit/hitpayPayment.test.ts
import { describe, it, expect } from 'vitest'
import {
  isLive, moneyString, judgePayment, readSignalRequestId, newWebhookToken, keyLast4, QR_LIFETIME_MINUTES,
} from '../../src/hitpayPayment.js'

const now = new Date('2026-10-02T10:00:00Z')
const remote = (over: Partial<{ status: string; amount: string; currency: string; referenceNumber: string | null }> = {}) => ({
  id: 'pr_1', status: 'completed', amount: '26.00', currency: 'myr', referenceNumber: 'order-1', ...over,
})
const expected = { amount: '26', currency: 'MYR', orderId: 'order-1' }

describe('isLive', () => {
  it('is live only while pending and before expiry', () => {
    expect(isLive({ status: 'pending', expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(true)
    expect(isLive({ status: 'pending', expiresAt: now }, now)).toBe(false)
    expect(isLive({ status: 'expired', expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(false)
    expect(isLive({ status: 'completed', expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(false)
  })
  it('uses a 15 minute lifetime', () => {
    expect(QR_LIFETIME_MINUTES).toBe(15)
  })
})

describe('moneyString', () => {
  it('always gives two decimals', () => {
    expect(moneyString(26)).toBe('26.00')
    expect(moneyString('26.5')).toBe('26.50')
    expect(moneyString('0.30')).toBe('0.30')
  })
})

describe('judgePayment', () => {
  it('accepts a completed request whose money and reference agree, across formats and case', () => {
    expect(judgePayment(remote(), expected)).toEqual({ kind: 'paid' })
    expect(judgePayment(remote({ amount: '26' }), { ...expected, amount: 26 })).toEqual({ kind: 'paid' })
  })
  it('keeps waiting on pending', () => {
    expect(judgePayment(remote({ status: 'pending' }), expected)).toEqual({ kind: 'pending' })
  })
  it('closes expired, failed, canceled and inactive', () => {
    expect(judgePayment(remote({ status: 'expired' }), expected)).toEqual({ kind: 'closed', status: 'expired' })
    for (const s of ['failed', 'canceled', 'inactive']) {
      expect(judgePayment(remote({ status: s }), expected)).toEqual({ kind: 'closed', status: 'failed' })
    }
  })
  it('refuses a wrong amount, currency or reference', () => {
    expect(judgePayment(remote({ amount: '25.99' }), expected).kind).toBe('mismatch')
    expect(judgePayment(remote({ currency: 'sgd' }), expected).kind).toBe('mismatch')
    expect(judgePayment(remote({ referenceNumber: 'order-2' }), expected).kind).toBe('mismatch')
    expect(judgePayment(remote({ referenceNumber: null }), expected).kind).toBe('mismatch')
  })
  it('treats an unknown status as pending, never as paid', () => {
    expect(judgePayment(remote({ status: 'something-new' }), expected)).toEqual({ kind: 'pending' })
  })
})

describe('readSignalRequestId', () => {
  it('reads a top-level payment_request_id or a nested payment_request.id', () => {
    expect(readSignalRequestId({ payment_request_id: 'pr_1' })).toBe('pr_1')
    expect(readSignalRequestId({ payment_request: { id: 'pr_2' } })).toBe('pr_2')
  })
  it('returns null for anything else', () => {
    for (const b of [null, 'x', {}, { payment_request_id: null }, { payment_request_id: 12 }, { payment_request_id: '' }]) {
      expect(readSignalRequestId(b)).toBeNull()
    }
  })
})

describe('tokens and keys', () => {
  it('makes a url-safe token of at least 32 characters, different each time', () => {
    const a = newWebhookToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(newWebhookToken()).not.toBe(a)
  })
  it('shows only the last four characters of a key', () => {
    expect(keyLast4('abcdef123456')).toBe('3456')
    expect(keyLast4('ab')).toBe('ab')
  })
})
