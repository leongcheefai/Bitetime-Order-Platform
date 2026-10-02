import { describe, it, expect } from 'vitest'
import {
  SUPPORT_EMAIL, supportMailto,
} from './support'

describe('supportMailto', () => {
  it('names the shop and its slug, so a mail arrives triageable', () => {
    expect(supportMailto({ name: 'Ah Meng Bakery', slug: 'ah-meng-bakery' }))
      .toBe(`mailto:${SUPPORT_EMAIL}?subject=Support%20%E2%80%94%20Ah%20Meng%20Bakery%20(ah-meng-bakery)`)
  })

  it('encodes a shop name that would otherwise end the subject early', () => {
    // `&` unencoded starts a second mailto parameter: the subject arrives as "Kopi", and the
    // half of the name that identifies the shop is dropped without any error.
    const href = supportMailto({ name: 'Kopi & Kaya', slug: 'kopi-kaya' })
    expect(href).toContain('Kopi%20%26%20Kaya')
    expect(href.split('?')[1]).toMatch(/^subject=[^&]*$/)
  })

  it('still gives an address when there is no shop to name', () => {
    expect(supportMailto()).toBe(`mailto:${SUPPORT_EMAIL}`)
  })
})
