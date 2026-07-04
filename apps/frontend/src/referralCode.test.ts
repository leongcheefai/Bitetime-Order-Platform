import { describe, it, expect } from 'vitest'
import { normalizeReferralCode, resolveReferredByCode } from './referralCode'

describe('normalizeReferralCode', () => {
  it('accepts an 8-char hex code, uppercased', () => {
    expect(normalizeReferralCode('ab12cd34')).toBe('AB12CD34')
  })
  it('trims surrounding whitespace', () => {
    expect(normalizeReferralCode('  AB12CD34 ')).toBe('AB12CD34')
  })
  it('rejects wrong length', () => {
    expect(normalizeReferralCode('AB12CD3')).toBeNull()
    expect(normalizeReferralCode('AB12CD345')).toBeNull()
  })
  it('rejects non-hex characters', () => {
    expect(normalizeReferralCode('AB12CG34')).toBeNull()
  })
  it('returns null for empty / nullish', () => {
    expect(normalizeReferralCode('')).toBeNull()
    expect(normalizeReferralCode(null)).toBeNull()
    expect(normalizeReferralCode(undefined)).toBeNull()
  })
})

describe('resolveReferredByCode', () => {
  it('returns the normalized code when it differs from the owner code', () => {
    expect(resolveReferredByCode('ab12cd34', 'FFFFFFFF')).toBe('AB12CD34')
  })
  it('returns null on self-referral (equals owner code)', () => {
    expect(resolveReferredByCode('AB12CD34', 'AB12CD34')).toBeNull()
    expect(resolveReferredByCode('ab12cd34', 'AB12CD34')).toBeNull()
  })
  it('returns null for a malformed code', () => {
    expect(resolveReferredByCode('nope', 'FFFFFFFF')).toBeNull()
  })
})
