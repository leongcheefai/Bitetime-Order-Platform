// tests/unit/phone.test.ts
// The phone rule, on its own, with no database in sight.
//
// It is the entire security of guest tracking. Order numbers are a per-shop daily counter
// and therefore guessable; the phone is what makes a guess cost ~10^8 tries instead of one.
// But a rule too strict is not "more secure" — it locks customers out of their own orders,
// which is the failure that actually happens, so both halves are asserted here.
import { describe, it, expect } from 'vitest'
import { phoneKey, phonesMatch } from '../../src/phone.js'

describe('phoneKey', () => {
  it('keeps digits only', () => {
    expect(phoneKey('+60 12-345 6789')).toBe('23456789')
  })

  it('takes the last eight digits, so the same phone written three ways is one key', () => {
    expect(phoneKey('+60 12-345 6789')).toBe('23456789')
    expect(phoneKey('0123456789')).toBe('23456789')
    expect(phoneKey('60123456789')).toBe('23456789')
  })

  it('keeps a shorter number whole rather than padding it', () => {
    expect(phoneKey('12345')).toBe('12345')
  })

  // A phone with no digits normalises to the empty string, and so does an absent one. If the
  // empty string were a key, every order with no phone on file would match a request that
  // sent no phone — the enumeration hole the phone requirement exists to close.
  it('has no key for a phone with no digits at all', () => {
    expect(phoneKey('')).toBeNull()
    expect(phoneKey('   ')).toBeNull()
    expect(phoneKey('n/a')).toBeNull()
    expect(phoneKey(null)).toBeNull()
    expect(phoneKey(undefined)).toBeNull()
  })
})

describe('phonesMatch', () => {
  it('matches the three common ways one human writes one phone', () => {
    expect(phonesMatch('+60 12-345 6789', '0123456789')).toBe(true)
    expect(phonesMatch('60123456789', '+60 12-345 6789')).toBe(true)
  })

  it('does not match a different phone', () => {
    expect(phonesMatch('0123456789', '0198765432')).toBe(false)
  })

  it('never matches when either side has no digits', () => {
    expect(phonesMatch(null, '')).toBe(false)
    expect(phonesMatch('', '')).toBe(false)
    expect(phonesMatch('0123456789', '')).toBe(false)
    expect(phonesMatch(null, '0123456789')).toBe(false)
  })
})
