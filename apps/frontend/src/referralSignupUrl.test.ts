import { describe, it, expect } from 'vitest'
import { referralSignupUrl } from './referralSignupUrl'

describe('referralSignupUrl', () => {
  it('builds a signup URL carrying the ref query param', () => {
    expect(referralSignupUrl('AB12CD34', 'https://bitetime.co'))
      .toBe('https://bitetime.co/merchant/signup?ref=AB12CD34')
  })

  it('strips a trailing slash from origin', () => {
    expect(referralSignupUrl('AB12CD34', 'https://bitetime.co/'))
      .toBe('https://bitetime.co/merchant/signup?ref=AB12CD34')
  })

  it('url-encodes the code', () => {
    expect(referralSignupUrl('a b', 'https://x.co'))
      .toBe('https://x.co/merchant/signup?ref=a%20b')
  })
})
