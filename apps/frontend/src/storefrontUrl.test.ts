import { describe, it, expect } from 'vitest'
import { storefrontUrl } from './storefrontUrl'

describe('storefrontUrl', () => {
  it('joins origin and slug into the storefront path', () => {
    expect(storefrontUrl('joes-cafe', 'https://bitetime.co')).toBe('https://bitetime.co/s/joes-cafe')
  })

  it('does not produce a double slash when origin has a trailing slash', () => {
    expect(storefrontUrl('joes-cafe', 'https://bitetime.co/')).toBe('https://bitetime.co/s/joes-cafe')
  })

  it('interpolates the exact slug', () => {
    expect(storefrontUrl('shop-42', 'http://localhost:5173')).toBe('http://localhost:5173/s/shop-42')
  })
})
