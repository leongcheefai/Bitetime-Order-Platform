import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./supabase', () => {
  // Terminal methods
  const single = vi.fn()
  const maybeSingle = vi.fn()

  // order() is a terminal for list queries like fetchAllMerchants.
  // Mock per-test with order.mockResolvedValueOnce({data, error}).
  const order = vi.fn()

  // select() returned from insert() chain → { single }
  const insertSelect = vi.fn(() => ({ single }))
  // select() returned from update().eq() chain → { single }
  const updateEqSelect = vi.fn(() => ({ single }))

  // eq() → { single, maybeSingle, select: updateEqSelect }
  // Used by: fetchMerchantBySlug (→single), fetchMyMerchant (→maybeSingle),
  //          updateMerchantSlug (→updateEqSelect→single)
  const eq = vi.fn(() => ({ single, maybeSingle, select: updateEqSelect }))

  // insert() → { select: insertSelect }
  const insert = vi.fn(() => ({ select: insertSelect }))

  // update() → { eq }
  const update = vi.fn(() => ({ eq }))

  // from().select() → { eq, single, maybeSingle, order } by default.
  // Override per-test with select.mockResolvedValueOnce({data, error}) for
  // terminal list queries (listTakenSlugs: from().select('slug')).
  // Use order.mockResolvedValueOnce({data, error}) for order-terminated chains
  // (fetchAllMerchants: from().select('*').order(...)).
  const select = vi.fn(() => ({ eq, single, maybeSingle, order }))

  // from() → { select, insert, update }
  const from = vi.fn(() => ({ select, insert, update }))

  // auth mock for getCurrentUser() → supabase.auth.getUser()
  const getUser = vi.fn()
  const auth = { getUser }

  return {
    supabase: { from, auth },
    __mocks: { from, select, eq, single, maybeSingle, insert, update, insertSelect, updateEqSelect, getUser, order },
  }
})

import {
  fetchMerchantBySlug,
  listTakenSlugs,
  fetchMyMerchant,
  createMerchant,
  updateMerchantSlug,
  fetchAllMerchants,
  setMerchantStatus,
} from './store'
import { __mocks } from './supabase'

beforeEach(() => { vi.clearAllMocks() })

// ── fetchMerchantBySlug (Task 1.2) ────────────────────────────────────────────

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

// ── listTakenSlugs (Task 2.2) ─────────────────────────────────────────────────

describe('listTakenSlugs', () => {
  it('queries merchants.slug and returns array of slug strings', async () => {
    __mocks.select.mockResolvedValueOnce({
      data: [{ slug: 'shop-a' }, { slug: 'shop-b' }],
      error: null,
    })
    const result = await listTakenSlugs()
    expect(__mocks.from).toHaveBeenCalledWith('merchants')
    expect(__mocks.select).toHaveBeenCalledWith('slug')
    expect(result).toEqual(['shop-a', 'shop-b'])
  })

  it('returns empty array on DB error', async () => {
    __mocks.select.mockResolvedValueOnce({ data: null, error: { message: 'connection failed' } })
    expect(await listTakenSlugs()).toEqual([])
  })
})

// ── fetchMyMerchant (Task 2.2) ────────────────────────────────────────────────

describe('fetchMyMerchant', () => {
  it('queries merchants by owner_id and returns the row', async () => {
    const row = { id: 'm1', owner_id: 'u1', slug: 'shop-a' }
    __mocks.maybeSingle.mockResolvedValueOnce({ data: row, error: null })
    const result = await fetchMyMerchant('u1')
    expect(__mocks.from).toHaveBeenCalledWith('merchants')
    expect(__mocks.eq).toHaveBeenCalledWith('owner_id', 'u1')
    expect(result).toEqual(row)
  })

  it('returns null on DB error', async () => {
    __mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'fail' } })
    expect(await fetchMyMerchant('u1')).toBeNull()
  })

  it('returns null immediately for null userId without hitting the DB', async () => {
    expect(await fetchMyMerchant(null)).toBeNull()
    expect(__mocks.from).not.toHaveBeenCalled()
  })
})

// ── createMerchant (Task 2.2) ─────────────────────────────────────────────────

describe('createMerchant', () => {
  it('inserts with owner_id, status:pending, slug derived from name, and order_prefix', async () => {
    const user = { id: 'user-abc' }
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    // listTakenSlugs call: select('slug') returns empty list
    __mocks.select.mockResolvedValueOnce({ data: [], error: null })
    const merchantRow = {
      id: 'm1', name: 'My Shop', slug: 'my-shop',
      order_prefix: 'MY', owner_id: 'user-abc', status: 'pending',
    }
    __mocks.single.mockResolvedValueOnce({ data: merchantRow, error: null })

    const result = await createMerchant({ name: 'My Shop' })

    expect(__mocks.from).toHaveBeenCalledWith('merchants')
    expect(__mocks.insert).toHaveBeenCalledWith({
      name: 'My Shop',
      slug: 'my-shop',
      order_prefix: 'MY',
      owner_id: 'user-abc',
      status: 'pending',
    })
    expect(result).toEqual(merchantRow)
  })

  it('throws "Not signed in" when no user session exists', async () => {
    __mocks.getUser.mockResolvedValueOnce({ data: { user: null } })
    await expect(createMerchant({ name: 'My Shop' })).rejects.toThrow('Not signed in')
    expect(__mocks.insert).not.toHaveBeenCalled()
  })
})

// ── updateMerchantSlug (Task 2.2) ─────────────────────────────────────────────

describe('updateMerchantSlug', () => {
  it('throws for a reserved slug without hitting the DB', async () => {
    await expect(updateMerchantSlug('m1', 'admin')).rejects.toThrow('Reserved or empty slug')
    expect(__mocks.from).not.toHaveBeenCalled()
  })

  it('throws for an empty slug without hitting the DB', async () => {
    await expect(updateMerchantSlug('m1', '')).rejects.toThrow('Reserved or empty slug')
    expect(__mocks.from).not.toHaveBeenCalled()
  })

  it('throws when the slug is already taken by another merchant', async () => {
    __mocks.select.mockResolvedValueOnce({
      data: [{ slug: 'taken-slug' }], error: null,
    })
    await expect(updateMerchantSlug('m1', 'taken-slug')).rejects.toThrow('Slug already taken')
    expect(__mocks.update).not.toHaveBeenCalled()
  })

  it('updates slug field on merchants table when slug is valid and available', async () => {
    __mocks.select.mockResolvedValueOnce({ data: [], error: null }) // listTakenSlugs
    const updated = { id: 'm1', slug: 'new-shop' }
    __mocks.single.mockResolvedValueOnce({ data: updated, error: null })

    const result = await updateMerchantSlug('m1', 'new-shop')

    expect(__mocks.from).toHaveBeenCalledWith('merchants')
    expect(__mocks.update).toHaveBeenCalledWith({ slug: 'new-shop' })
    expect(__mocks.eq).toHaveBeenCalledWith('id', 'm1')
    expect(result).toEqual(updated)
  })
})

// ── fetchAllMerchants (Task 3.2) ──────────────────────────────────────────────

describe('fetchAllMerchants', () => {
  it('queries merchants table with select(*) + order and returns list', async () => {
    const rows = [{ id: 'm2', created_at: '2025-02-01' }, { id: 'm1', created_at: '2025-01-01' }]
    __mocks.order.mockResolvedValueOnce({ data: rows, error: null })
    const result = await fetchAllMerchants()
    expect(__mocks.from).toHaveBeenCalledWith('merchants')
    expect(__mocks.select).toHaveBeenCalledWith('*')
    expect(__mocks.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual(rows)
  })

  it('returns empty array when data is null', async () => {
    __mocks.order.mockResolvedValueOnce({ data: null, error: null })
    expect(await fetchAllMerchants()).toEqual([])
  })

  it('throws on DB error', async () => {
    __mocks.order.mockResolvedValueOnce({ data: null, error: new Error('DB fail') })
    await expect(fetchAllMerchants()).rejects.toThrow('DB fail')
  })
})

// ── setMerchantStatus (Task 3.2) ──────────────────────────────────────────────

describe('setMerchantStatus', () => {
  it('throws "Invalid status" for an unknown status without calling update', async () => {
    await expect(setMerchantStatus('m1', 'banned')).rejects.toThrow('Invalid status')
    expect(__mocks.update).not.toHaveBeenCalled()
  })

  it('updates status on merchants table and returns the updated row', async () => {
    const row = { id: 'm1', status: 'active' }
    __mocks.single.mockResolvedValueOnce({ data: row, error: null })
    const result = await setMerchantStatus('m1', 'active')
    expect(__mocks.from).toHaveBeenCalledWith('merchants')
    expect(__mocks.update).toHaveBeenCalledWith({ status: 'active' })
    expect(__mocks.eq).toHaveBeenCalledWith('id', 'm1')
    expect(result).toEqual(row)
  })

  it('accepts all three valid statuses: pending, active, suspended', async () => {
    for (const status of ['pending', 'active', 'suspended']) {
      vi.clearAllMocks()
      __mocks.single.mockResolvedValueOnce({ data: { id: 'm1', status }, error: null })
      const result = await setMerchantStatus('m1', status)
      expect(result.status).toBe(status)
    }
  })

  it('throws on DB error after a valid status', async () => {
    __mocks.single.mockResolvedValueOnce({ data: null, error: new Error('write failed') })
    await expect(setMerchantStatus('m1', 'suspended')).rejects.toThrow('write failed')
  })
})
