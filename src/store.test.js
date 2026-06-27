import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./supabase', () => {
  const single = vi.fn()
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { supabase: { from }, __mocks: { from, select, eq, single } }
})

import { fetchMerchantBySlug } from './store'
import { __mocks } from './supabase'

beforeEach(() => { vi.clearAllMocks() })

describe('fetchMerchantBySlug', () => {
  it('returns null for a reserved slug without hitting the DB', async () => {
    expect(await fetchMerchantBySlug('admin')).toBeNull()
    expect(__mocks.from).not.toHaveBeenCalled()
  })
  it('returns the merchant row when found', async () => {
    __mocks.single.mockResolvedValueOnce({ data: { id: 'm1', slug: 'shop-a' }, error: null })
    expect(await fetchMerchantBySlug('shop-a')).toEqual({ id: 'm1', slug: 'shop-a' })
  })
  it('returns null when not found', async () => {
    __mocks.single.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } })
    expect(await fetchMerchantBySlug('missing')).toBeNull()
  })
})
