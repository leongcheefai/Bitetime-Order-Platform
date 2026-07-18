import { describe, it, expect } from 'vitest'
import { resolveSlug, orderPrefix, RESERVED_SLUGS, resolveReferredByCode, referralCodeOf } from '../../src/slug.js'

describe('resolveSlug', () => {
  it('slugifies a latin name', async () => {
    expect(await resolveSlug('Joe\'s Coffee')).toBe('joe-s-coffee')
  })
  it('appends a numeric suffix when the base is taken', async () => {
    expect(await resolveSlug('Joe Coffee', { taken: ['joe-coffee'] })).toBe('joe-coffee-2')
    expect(await resolveSlug('Joe Coffee', { taken: ['joe-coffee', 'joe-coffee-2'] })).toBe('joe-coffee-3')
  })
  it('avoids reserved segments by suffixing', async () => {
    expect(await resolveSlug('admin')).toBe('admin-2')
  })
  it('transliterates CJK via pinyin', async () => {
    expect(await resolveSlug('北京烤鸭')).toBe('bei-jing-kao-ya')
  })
  it('falls back to shop-<id> when the name yields no base', async () => {
    expect(await resolveSlug('!!!', { id: 'abcdef12-0000-0000-0000-000000000000' })).toBe('shop-abcdef')
  })
})

describe('orderPrefix', () => {
  it('takes the first two alphanumerics uppercased', () => expect(orderPrefix('joe-coffee')).toBe('JO'))
  it('falls back to SH when under two alnum', () => expect(orderPrefix('a')).toBe('SH'))
})

describe('referral helpers', () => {
  it('referralCodeOf is the first 8 hex of the id, uppercased', () =>
    expect(referralCodeOf('abcdef12-3456-7890-0000-000000000000')).toBe('ABCDEF12'))
  it('resolveReferredByCode rejects self-referral', () =>
    expect(resolveReferredByCode('ABCDEF12', 'ABCDEF12')).toBeNull())
  it('resolveReferredByCode normalizes and validates', () => {
    expect(resolveReferredByCode(' abcdef12 ', 'ZZZZ0000')).toBe('ABCDEF12')
    expect(resolveReferredByCode('nothex', 'ZZZZ0000')).toBeNull()
  })
})

describe('RESERVED_SLUGS', () => {
  it('includes the router segments', () => {
    for (const s of ['s', 'admin', 'api', 'merchant']) expect(RESERVED_SLUGS).toContain(s)
  })
})
