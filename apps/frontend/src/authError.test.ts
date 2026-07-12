import { describe, it, expect } from 'vitest'
import { authErrorCode } from './authError'

describe('authErrorCode', () => {
  it('reads a wrong password from the error code', () => {
    expect(authErrorCode({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe('invalid_credentials')
  })

  it('falls back to the message when no code is present', () => {
    // Older supabase-js versions (and the REST error shape) carry no `code`.
    expect(authErrorCode({ message: 'Invalid login credentials' })).toBe('invalid_credentials')
  })

  it('recognises an unconfirmed email', () => {
    expect(authErrorCode({ code: 'email_not_confirmed', message: 'Email not confirmed' })).toBe('email_not_confirmed')
  })

  it('recognises a rate limit', () => {
    expect(authErrorCode({ status: 429, message: 'Request rate limit reached' })).toBe('rate_limited')
  })

  it('falls back to unknown for anything else', () => {
    expect(authErrorCode({ message: 'Network request failed' })).toBe('unknown')
    expect(authErrorCode(null)).toBe('unknown')
  })
})
