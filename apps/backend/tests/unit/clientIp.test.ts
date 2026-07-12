import { describe, it, expect } from 'vitest'
import { clientIp } from '../../src/clientIp.js'

// The rate limit is the only control on /api/customer/signup ("CORS is not the guard"),
// and its IP key is only worth anything if the caller cannot choose it.
describe('clientIp', () => {
  it('takes the last X-Forwarded-For entry — the one our own edge appended', () => {
    // A non-browser caller can send any XFF it likes; the proxy in front of us appends the
    // address it actually saw. Reading the leftmost entry would let a caller mint a fresh
    // IP per request and never trip the window.
    expect(clientIp({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' })).toBe('203.0.113.7')
  })

  it('prefers the CDN header, which a caller cannot forge through the CDN', () => {
    expect(clientIp({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '9.9.9.9' })).toBe('203.0.113.7')
  })

  it('falls back to the socket address when no proxy header is present (local dev)', () => {
    expect(clientIp({}, '127.0.0.1')).toBe('127.0.0.1')
  })

  it('reports one shared key rather than a forgeable one when it knows nothing', () => {
    // Everything anonymous shares a single bucket. Blunt on purpose: an unknown caller must
    // not get its own private window just by withholding headers.
    expect(clientIp({})).toBe('unknown')
  })
})
