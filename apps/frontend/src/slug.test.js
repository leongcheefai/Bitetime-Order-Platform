import { describe, it, expect } from 'vitest'
import { slugify, toSlugBase, resolveSlug, RESERVED_SLUGS } from './slug'

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
  it('passes latin names through slugify', async () => {
    expect(await toSlugBase('Cookie Corner')).toBe('cookie-corner')
  })
  it('transliterates Chinese to pinyin', async () => {
    expect(await toSlugBase('点心铺')).toBe('dian-xin-pu')
  })
  it('handles mixed latin + Chinese', async () => {
    expect(await toSlugBase('点心 Cafe')).toBe('dian-xin-cafe')
  })
  it('returns empty for pure punctuation', async () => {
    expect(await toSlugBase('!!!')).toBe('')
  })
})

describe('resolveSlug', () => {
  it('returns the base slug when free', async () => {
    expect(await resolveSlug('Cookie Corner', { taken: [] })).toBe('cookie-corner')
  })
  it('suffixes on collision', async () => {
    expect(await resolveSlug('Cookie Corner', { taken: ['cookie-corner'] })).toBe('cookie-corner-2')
    expect(await resolveSlug('Cookie Corner', { taken: ['cookie-corner', 'cookie-corner-2'] })).toBe('cookie-corner-3')
  })
  it('avoids reserved words by suffixing', async () => {
    expect(RESERVED_SLUGS).toContain('admin')
    expect(await resolveSlug('Admin', { taken: [] })).toBe('admin-2')
  })
  it('falls back to shop-<id> when base is empty', async () => {
    expect(await resolveSlug('!!!', { taken: [], id: 'a3f9c1d2-xxxx' })).toBe('shop-a3f9c1')
  })
  it('de-dupes fallback shop-<id> against taken', async () => {
    expect(await resolveSlug('!!!', { taken: ['shop-a3f9c1'], id: 'a3f9c1d2-xxxx' })).toBe('shop-a3f9c1-2')
  })
})
