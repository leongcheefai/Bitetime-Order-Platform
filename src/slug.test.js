import { describe, it, expect } from 'vitest'
import { slugify, toSlugBase } from './slug'

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

describe('toSlugBase', () => {
  it('passes latin names through slugify', () => {
    expect(toSlugBase('Cookie Corner')).toBe('cookie-corner')
  })
  it('transliterates Chinese to pinyin', () => {
    expect(toSlugBase('点心铺')).toBe('dian-xin-pu')
  })
  it('handles mixed latin + Chinese', () => {
    expect(toSlugBase('点心 Cafe')).toBe('dian-xin-c-a-f-e-cafe')
  })
  it('returns empty for pure punctuation', () => {
    expect(toSlugBase('!!!')).toBe('')
  })
})
