import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./supabase', () => {
  // Terminal methods
  const single = vi.fn()
  const maybeSingle = vi.fn()

  // order() — used for ordered list queries.
  // Default returns { order } so chains like .eq().order().order() work;
  // mock the LAST call with .mockResolvedValueOnce({data, error}) to terminate.
  const order = vi.fn(() => ({ order }))

  // select() returned from insert() chain → { single }
  const insertSelect = vi.fn(() => ({ single }))
  // select() returned from update().eq() chain → { single }
  const updateEqSelect = vi.fn(() => ({ single }))
  // select() returned from upsert() chain → { single }
  const upsertSelect = vi.fn(() => ({ single }))

  // deleteEq — terminal for delete().eq() chain; awaited directly.
  const deleteEq = vi.fn()
  // del (delete) → { eq: deleteEq }
  const del = vi.fn(() => ({ eq: deleteEq }))

  // upsert() → { select: upsertSelect } by default (for .upsert().select().single() chains).
  // For terminal-await use (no .select()), mock with .mockResolvedValueOnce({error}).
  const upsert = vi.fn(() => ({ select: upsertSelect }))

  // eq() → { single, maybeSingle, select: updateEqSelect, order }
  // Used by: fetchMerchantBySlug (→single), fetchMyMerchant (→maybeSingle),
  //          updateMerchantSlug / setMerchantStatus (→updateEqSelect→single),
  //          fetchProducts (→order→order)
  const eq = vi.fn(() => ({ single, maybeSingle, select: updateEqSelect, order }))

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

  // from() → { select, insert, update, upsert, delete: del }
  const from = vi.fn(() => ({ select, insert, update, upsert, delete: del }))

  // auth mock for getCurrentUser() → supabase.auth.getUser()
  const getUser = vi.fn()
  const auth = { getUser }

  return {
    supabase: { from, auth },
    __mocks: {
      from, select, eq, single, maybeSingle, insert, update,
      insertSelect, updateEqSelect, upsertSelect, getUser, order,
      upsert, del, deleteEq,
    },
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
  fetchProducts,
  upsertProduct,
  deleteProduct,
  updateMerchantConfig,
  fetchMerchantSecret,
  upsertMerchantSecret,
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

// ── fetchProducts (Task 4.1) ───────────────────────────────────────────────────

describe('fetchProducts', () => {
  it('returns empty array immediately when merchantId is falsy', async () => {
    expect(await fetchProducts(null)).toEqual([])
    expect(await fetchProducts('')).toEqual([])
    expect(__mocks.from).not.toHaveBeenCalled()
  })

  it('queries products by merchant_id, ordered by sort then created_at', async () => {
    const rows = [{ id: 'p1', sort: 0 }, { id: 'p2', sort: 1 }]
    __mocks.order
      .mockReturnValueOnce({ order: __mocks.order }) // first .order() → chainable
      .mockResolvedValueOnce({ data: rows, error: null }) // second .order() → terminal

    const result = await fetchProducts('m1')

    expect(__mocks.from).toHaveBeenCalledWith('products')
    expect(__mocks.select).toHaveBeenCalledWith('*')
    expect(__mocks.eq).toHaveBeenCalledWith('merchant_id', 'm1')
    expect(__mocks.order).toHaveBeenNthCalledWith(1, 'sort', { ascending: true })
    expect(__mocks.order).toHaveBeenNthCalledWith(2, 'created_at', { ascending: true })
    expect(result).toEqual(rows)
  })

  it('returns empty array on DB error', async () => {
    __mocks.order
      .mockReturnValueOnce({ order: __mocks.order })
      .mockResolvedValueOnce({ data: null, error: { message: 'fail' } })
    expect(await fetchProducts('m1')).toEqual([])
  })

  it('returns empty array when data is null with no error', async () => {
    __mocks.order
      .mockReturnValueOnce({ order: __mocks.order })
      .mockResolvedValueOnce({ data: null, error: null })
    expect(await fetchProducts('m1')).toEqual([])
  })
})

// ── upsertProduct (Task 4.1) ──────────────────────────────────────────────────

describe('upsertProduct', () => {
  it('upserts the product and returns the single row', async () => {
    const product = { name: 'Cookie', merchant_id: 'm1' }
    const saved = { id: 'p1', ...product }
    __mocks.single.mockResolvedValueOnce({ data: saved, error: null })

    const result = await upsertProduct(product)

    expect(__mocks.from).toHaveBeenCalledWith('products')
    expect(__mocks.upsert).toHaveBeenCalledWith(product)
    expect(__mocks.upsertSelect).toHaveBeenCalled()
    expect(result).toEqual(saved)
  })

  it('throws on DB error', async () => {
    __mocks.single.mockResolvedValueOnce({ data: null, error: new Error('write failed') })
    await expect(upsertProduct({ name: 'x', merchant_id: 'm1' })).rejects.toThrow('write failed')
  })
})

// ── deleteProduct (Task 4.1) ──────────────────────────────────────────────────

describe('deleteProduct', () => {
  it('calls delete().eq(id) on products table', async () => {
    __mocks.deleteEq.mockResolvedValueOnce({ error: null })

    await deleteProduct('p1')

    expect(__mocks.from).toHaveBeenCalledWith('products')
    expect(__mocks.del).toHaveBeenCalled()
    expect(__mocks.deleteEq).toHaveBeenCalledWith('id', 'p1')
  })

  it('throws on DB error', async () => {
    __mocks.deleteEq.mockResolvedValueOnce({ error: new Error('delete failed') })
    await expect(deleteProduct('p1')).rejects.toThrow('delete failed')
  })
})

// ── updateMerchantConfig (Task 4.1) ───────────────────────────────────────────

describe('updateMerchantConfig', () => {
  it('updates the merchants row with the given patch and returns it', async () => {
    const patch = { name: 'New Name', shipping: { WM: 10 } }
    const row = { id: 'm1', ...patch }
    __mocks.single.mockResolvedValueOnce({ data: row, error: null })

    const result = await updateMerchantConfig('m1', patch)

    expect(__mocks.from).toHaveBeenCalledWith('merchants')
    expect(__mocks.update).toHaveBeenCalledWith(patch)
    expect(__mocks.eq).toHaveBeenCalledWith('id', 'm1')
    expect(result).toEqual(row)
  })

  it('throws on DB error', async () => {
    __mocks.single.mockResolvedValueOnce({ data: null, error: new Error('update failed') })
    await expect(updateMerchantConfig('m1', { name: 'x' })).rejects.toThrow('update failed')
  })
})

// ── fetchMerchantSecret (Task 4.1) ────────────────────────────────────────────

describe('fetchMerchantSecret', () => {
  it('selects tg_token and tg_chat_id from merchant_secrets by merchant_id', async () => {
    const secret = { tg_token: 'tok123', tg_chat_id: '456' }
    __mocks.maybeSingle.mockResolvedValueOnce({ data: secret, error: null })

    const result = await fetchMerchantSecret('m1')

    expect(__mocks.from).toHaveBeenCalledWith('merchant_secrets')
    expect(__mocks.select).toHaveBeenCalledWith('tg_token, tg_chat_id')
    expect(__mocks.eq).toHaveBeenCalledWith('merchant_id', 'm1')
    expect(result).toEqual(secret)
  })

  it('returns null when no row exists', async () => {
    __mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null })
    expect(await fetchMerchantSecret('m1')).toBeNull()
  })

  it('returns null on DB error', async () => {
    __mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'fail' } })
    expect(await fetchMerchantSecret('m1')).toBeNull()
  })
})

// ── upsertMerchantSecret (Task 4.1) ───────────────────────────────────────────

describe('upsertMerchantSecret', () => {
  it('upserts merchant_id + secret fields into merchant_secrets', async () => {
    __mocks.upsert.mockResolvedValueOnce({ error: null })

    await upsertMerchantSecret('m1', { tg_token: 'tok', tg_chat_id: '123' })

    expect(__mocks.from).toHaveBeenCalledWith('merchant_secrets')
    expect(__mocks.upsert).toHaveBeenCalledWith({
      merchant_id: 'm1',
      tg_token: 'tok',
      tg_chat_id: '123',
    })
  })

  it('throws on DB error', async () => {
    __mocks.upsert.mockResolvedValueOnce({ error: new Error('upsert failed') })
    await expect(
      upsertMerchantSecret('m1', { tg_token: 'x', tg_chat_id: 'y' })
    ).rejects.toThrow('upsert failed')
  })
})
