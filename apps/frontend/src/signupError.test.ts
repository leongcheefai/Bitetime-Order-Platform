import { describe, it, expect } from 'vitest'
import { signupErrorCode } from './signupError'

describe('signupErrorCode', () => {
  it('reads a duplicate email, the outcome that flips the panel to sign-in', () => {
    expect(signupErrorCode(409, { error: 'duplicate_email' })).toBe('duplicate_email')
  })

  it('distinguishes the two rejections the backend sends as 400', () => {
    expect(signupErrorCode(400, { error: 'weak_password' })).toBe('weak_password')
    expect(signupErrorCode(400, { error: 'invalid_email' })).toBe('invalid_email')
  })

  it('reads a rate limit', () => {
    expect(signupErrorCode(429, { error: 'rate_limited' })).toBe('rate_limited')
  })

  it('trusts the status over an unrecognised body', () => {
    // A proxy or a crash can answer with something that is not our JSON at all.
    expect(signupErrorCode(502, {})).toBe('server')
    expect(signupErrorCode(500, null)).toBe('server')
    expect(signupErrorCode(400, {})).toBe('server')
  })
})
