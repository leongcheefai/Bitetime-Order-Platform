import { describe, it, expect } from 'vitest'
import { resetRedirectUrl, resetDestination } from './resetPassword'

describe('resetRedirectUrl', () => {
  it('carries the shop the customer started from', () => {
    expect(resetRedirectUrl('https://bitetime.co', 'cookie-lab'))
      .toBe('https://bitetime.co/reset-password?shop=cookie-lab')
  })

  it('is a TOP-LEVEL route, never nested under the storefront', () => {
    // Nested under /s/:slug the storefront shell's status gate would swallow the page, and a
    // suspended shop must never lock a customer out of their own account. A top-level route also
    // needs exactly one static entry on Supabase's redirect allow-list rather than a wildcard.
    const url = resetRedirectUrl('https://bitetime.co', 'cookie-lab')
    expect(url).not.toContain('/s/')
    expect(new URL(url).pathname).toBe('/reset-password')
  })

  it('omits the shop when there is none — a merchant resets from the same route', () => {
    expect(resetRedirectUrl('https://bitetime.co', null)).toBe('https://bitetime.co/reset-password')
  })

  it('escapes a slug rather than letting it forge the query string', () => {
    expect(resetRedirectUrl('https://bitetime.co', 'a&b=c'))
      .toBe('https://bitetime.co/reset-password?shop=a%26b%3Dc')
  })
})

describe('resetDestination', () => {
  it('returns a customer to the shop they were ordering from', () => {
    expect(resetDestination('cookie-lab')).toBe('/s/cookie-lab')
  })

  it('sends a reset with no shop to the merchant dashboard', () => {
    // The route is role-blind on purpose: merchants have no reset path today either, so their
    // link later is a one-liner with no new infrastructure.
    expect(resetDestination(null)).toBe('/merchant')
    expect(resetDestination('')).toBe('/merchant')
  })

  it('refuses a slug that is trying to be a URL', () => {
    // `shop` arrives from the query string of a link that has been through an inbox. It is used to
    // navigate, so an open redirect starts exactly here.
    expect(resetDestination('//evil.example.com')).toBe('/merchant')
    expect(resetDestination('https://evil.example.com')).toBe('/merchant')
    expect(resetDestination('../admin')).toBe('/merchant')
  })
})
