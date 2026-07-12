import { describe, it, expect } from 'vitest'
import { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from './password.js'

describe('isPasswordLongEnough', () => {
  it('accepts a password at the floor', () => {
    expect(isPasswordLongEnough('a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true)
  })

  it('rejects one character short of it', () => {
    expect(isPasswordLongEnough('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false)
  })

  it('sits above Supabase’s own floor of 6, which is why we enforce it ourselves', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThan(6)
  })
})
