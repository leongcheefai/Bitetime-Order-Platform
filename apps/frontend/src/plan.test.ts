// isRequiresPro is the single point that decides whether four write paths (vouchers create,
// voucher delete, notifications save, product save) show a merchant an upgrade prompt or a raw
// error string. `apiSend` throws `new Error(body.error)`, so what reaches these call sites is
// an Error whose message is the backend's code verbatim — that shape is what these pin.
import { describe, it, expect } from 'vitest'
import { isRequiresPro, REQUIRES_PRO } from './plan'

describe('isRequiresPro', () => {
  it('recognises the error apiSend throws for a 403 requires_pro', () => {
    expect(isRequiresPro(new Error(REQUIRES_PRO))).toBe(true)
  })

  it('does not fire on any other backend refusal', () => {
    // Every one of these is a real message from a gated route's neighbours — misreading any of
    // them as the plan gate would tell a Pro merchant to upgrade to the plan they already pay for.
    for (const message of ['Forbidden', 'Not found', 'Upsert failed', 'Request failed: 500', '']) {
      expect(isRequiresPro(new Error(message))).toBe(false)
    }
  })

  it('does not fire on a substring or a differently-cased match', () => {
    expect(isRequiresPro(new Error('requires_pro_plan'))).toBe(false)
    expect(isRequiresPro(new Error('Requires_Pro'))).toBe(false)
  })

  // `catch (err)` catches anything, not just Errors — a rejected fetch, a thrown string, a
  // null. None of those are the plan gate, and none may throw while being checked.
  it('is safe on non-Error throwables', () => {
    for (const thrown of [REQUIRES_PRO, null, undefined, 0, { error: REQUIRES_PRO }]) {
      expect(isRequiresPro(thrown)).toBe(false)
    }
  })
})
