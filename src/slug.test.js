import { describe, it, expect } from 'vitest'
import { slugify } from './slug'

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Joe\'s Cookie Shop')).toBe('joe-s-cookie-shop')
  })
  it('collapses repeated separators', () => {
    expect(slugify('  Aunt   May -- Bakes ')).toBe('aunt-may-bakes')
  })
  it('returns empty string for non-latin input', () => {
    expect(slugify('点心铺')).toBe('')
  })
})
