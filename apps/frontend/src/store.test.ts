import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./supabase', () => {
  // Terminal methods
  const single = vi.fn()
  const maybeSingle = vi.fn()

  // limit() — terminal for capped list queries (fetchMyOrdersAtShop).
  const limit = vi.fn()

  // order() — used for ordered list queries.
  // Default returns { order, limit } so chains like .eq().order().order() and
  // .eq().order().limit() work; mock the LAST call with
  // .mockResolvedValueOnce({data, error}) to terminate.
  const order = vi.fn(() => ({ order, limit }))

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

  // is() → { maybeSingle, single, is } — for .eq().is('merchant_id', null) chains
  // (fetchProfileByUserId, ensureGlobalProfile). Terminal via maybeSingle.
  const is = vi.fn(() => ({ maybeSingle, single, is }))

  // eq() → { eq, single, maybeSingle, select: updateEqSelect, order, is }
  // Used by: fetchMerchantBySlug (→single), fetchMyMerchant (→maybeSingle),
  //          updateMerchantSlug / setMerchantStatus (→updateEqSelect→single),
  //          fetchProducts (→order→order), fetchProfileByUserId (→is→maybeSingle),
  //          fetchMyOrdersAtShop (→eq→order→limit: filters on merchant AND user)
  const eq: any = vi.fn(() => ({ eq, single, maybeSingle, select: updateEqSelect, order, is }))

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
  // getSession() → used by backend-calling helpers (setMerchantStatus, etc.)
  const getSession = vi.fn()
  // signUp() → supabase.auth.signUp() for signUp() store fn
  const signUp = vi.fn()
  const auth = { getUser, getSession, signUp }

  // rpc mock — top-level supabase.rpc(name, params) → awaited directly.
  const rpc = vi.fn()

  return {
    supabase: { from, auth, rpc },
    __mocks: {
      from, select, eq, is, single, maybeSingle, insert, update,
      insertSelect, updateEqSelect, upsertSelect, getUser, getSession, signUp: auth.signUp, order, limit,
      upsert, del, deleteEq, rpc,
    },
  }
})

import {
  fetchMerchantBySlug,
  fetchProfileByUserId,
  signUp,
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
  placeOrder,
  fetchMerchantOrders,
  fetchMyOrdersAtShop,
  ORDER_HISTORY_LIMIT,
  setOrderStatus,
  fetchMerchantCustomers,
  voucherFromRow,
  fetchMerchantVouchers,
  redeemVoucher,
  createMerchantVoucher,
  deleteMerchantVoucher,
} from './store'
import * as supabaseModule from './supabase'

const { __mocks } = supabaseModule as any

beforeEach(() => { vi.clearAllMocks() })

// ── profiles: user_id keying (issue #31) ──────────────────────────────────────
// The profiles restructure made `id` a surrogate PK and moved auth identity to
// `user_id`; client writes/reads must key on user_id or RLS rejects them.
describe('fetchProfileByUserId', () => {
  it('queries the global profile by user_id, not id', async () => {
    __mocks.maybeSingle.mockResolvedValueOnce({
      data: { id: 'p1', name: 'Fai', email: 'f@x.co', app_role: null, merchant_id: null },
      error: null,
    })
    const result = await fetchProfileByUserId('u1')
    expect(__mocks.eq).toHaveBeenCalledWith('user_id', 'u1')
    expect(__mocks.is).toHaveBeenCalledWith('merchant_id', null)
    expect(result).toMatchObject({ id: 'p1', name: 'Fai' })
  })

  it('returns null when the query errors', async () => {
    __mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: new Error('rls') })
    expect(await fetchProfileByUserId('u1')).toBeNull()
  })
})

describe('signUp profile write', () => {
  it('inserts a new profile keyed on user_id, never id', async () => {
    __mocks.signUp.mockResolvedValueOnce({
      data: { user: { id: 'u1', email_confirmed_at: null } }, error: null,
    })
    __mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null }) // no existing row
    await signUp('Fai', 'f@x.co', 'pw')
    expect(__mocks.eq).toHaveBeenCalledWith('user_id', 'u1')
    expect(__mocks.is).toHaveBeenCalledWith('merchant_id', null)
    const inserted = __mocks.insert.mock.calls[0][0]
    expect(inserted).toMatchObject({
      user_id: 'u1', name: 'Fai', email: 'f@x.co', email_confirmed: false,
    })
    expect(inserted).not.toHaveProperty('id')
    expect(__mocks.update).not.toHaveBeenCalled()
  })

  it('updates the existing global profile in place, not insert', async () => {
    __mocks.signUp.mockResolvedValueOnce({
      data: { user: { id: 'u1', email_confirmed_at: '2026-07-02T00:00:00Z' } }, error: null,
    })
    __mocks.maybeSingle.mockResolvedValueOnce({ data: { id: 'p1' }, error: null })
    await signUp('Fai', 'f@x.co', 'pw')
    const updated = __mocks.update.mock.calls[0][0]
    expect(updated).toMatchObject({ user_id: 'u1', email_confirmed: true })
    expect(__mocks.eq).toHaveBeenCalledWith('id', 'p1')
    expect(__mocks.insert).not.toHaveBeenCalled()
  })
})

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
    expect(await fetchMyMerchant(null as any)).toBeNull()
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
      plan: 'basic',
      billing_cycle: 'monthly',
      billing_region: 'US',
      referred_by_code: null,
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
  const okSession = { data: { session: { access_token: 'tok' } } }

  it('throws "Invalid status" for an unknown status without calling the backend', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(setMerchantStatus('m1', 'banned')).rejects.toThrow('Invalid status')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('throws when there is no session (not signed in)', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    await expect(setMerchantStatus('m1', 'active')).rejects.toThrow('Not signed in')
  })

  it('POSTs merchantId + status to the admin endpoint with a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce(okSession)
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => ({ ok: true, status: 'suspended' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await setMerchantStatus('m1', 'suspended')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/admin\/set-merchant-status$/)
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(opts.body)).toEqual({ merchantId: 'm1', status: 'suspended' })
    expect(result).toEqual({ ok: true, status: 'suspended' })
    vi.unstubAllGlobals()
  })

  it('throws with the backend error message on a non-ok response', async () => {
    __mocks.getSession.mockResolvedValueOnce(okSession)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, json: async () => ({ error: 'Forbidden' }),
    }))
    await expect(setMerchantStatus('m1', 'active')).rejects.toThrow('Forbidden')
    vi.unstubAllGlobals()
  })
})

// ── fetchProducts (Task 4.1) ───────────────────────────────────────────────────

describe('fetchProducts', () => {
  it('returns empty array immediately when merchantId is falsy', async () => {
    expect(await fetchProducts(null as any)).toEqual([])
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

// ── placeOrder (Task 5.2) ─────────────────────────────────────────────────────

describe('placeOrder', () => {
  it('calls rpc(next_order_number, {p_merchant}) then inserts with correct fields', async () => {
    __mocks.rpc.mockResolvedValueOnce({ data: 'BT-0001', error: null })
    __mocks.insert.mockResolvedValueOnce({ error: null })

    const result = await placeOrder({
      merchantId: 'm1',
      customerName: 'Alice',
      customerWa: '60123456789',
      mode: 'delivery',
      address: '123 Jalan ABC',
      shippingFee: 8,
      items: [{ id: 'p1', qty: 2 }],
      total: 24,
    })

    expect(__mocks.rpc).toHaveBeenCalledWith('next_order_number', { p_merchant: 'm1' })
    expect(__mocks.from).toHaveBeenCalledWith('orders')
    expect(__mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      merchant_id: 'm1',
      order_number: 'BT-0001',
      status: 'new',
      items: [{ id: 'p1', qty: 2 }],
      total: 24,
    }))
    expect(result).toEqual({ orderNumber: 'BT-0001' })
  })

  // A guest's own order is invisible to them under RLS (orders_select_scoped
  // matches on user_id = auth.uid(), which is NULL for a guest). So asking for
  // the row back with .select() makes Postgres reject the whole insert — guest
  // checkout dies. Nothing consumes the row; only the order number is used.
  it('never reads the inserted row back, so a guest checkout is not blocked by RLS', async () => {
    __mocks.rpc.mockResolvedValueOnce({ data: 'BT-0002', error: null })
    __mocks.insert.mockResolvedValueOnce({ error: null })

    await placeOrder({ merchantId: 'm1', items: [], total: 0 } as any)

    expect(__mocks.insertSelect).not.toHaveBeenCalled()
  })

  it('throws when rpc returns an error without calling insert', async () => {
    __mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error('rpc failed') })
    await expect(placeOrder({ merchantId: 'm1', items: [], total: 0 } as any)).rejects.toThrow('rpc failed')
    expect(__mocks.insert).not.toHaveBeenCalled()
  })

  it('throws when insert returns an error', async () => {
    __mocks.rpc.mockResolvedValueOnce({ data: 'BT-0001', error: null })
    __mocks.insert.mockResolvedValueOnce({ error: new Error('insert failed') })
    await expect(placeOrder({ merchantId: 'm1', items: [], total: 0 } as any)).rejects.toThrow('insert failed')
  })
})

// ── fetchMerchantOrders (Task 5.2) ────────────────────────────────────────────

describe('fetchMerchantOrders', () => {
  it('returns empty array immediately for falsy merchantId', async () => {
    expect(await fetchMerchantOrders(null as any)).toEqual([])
    expect(await fetchMerchantOrders('')).toEqual([])
    expect(__mocks.from).not.toHaveBeenCalled()
  })

  it('queries orders filtered by merchant_id ordered desc', async () => {
    const rows = [{ id: 'o2', merchant_id: 'm1' }, { id: 'o1', merchant_id: 'm1' }]
    __mocks.order.mockResolvedValueOnce({ data: rows, error: null })

    const result = await fetchMerchantOrders('m1')

    expect(__mocks.from).toHaveBeenCalledWith('orders')
    expect(__mocks.select).toHaveBeenCalledWith('*')
    expect(__mocks.eq).toHaveBeenCalledWith('merchant_id', 'm1')
    expect(__mocks.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual(rows)
  })

  it('returns empty array on DB error', async () => {
    __mocks.order.mockResolvedValueOnce({ data: null, error: { message: 'fail' } })
    expect(await fetchMerchantOrders('m1')).toEqual([])
  })

  it('returns empty array when data is null with no error', async () => {
    __mocks.order.mockResolvedValueOnce({ data: null, error: null })
    expect(await fetchMerchantOrders('m1')).toEqual([])
  })
})

// ── fetchMyOrdersAtShop (#55: per-shop order history) ─────────────────────────

describe('fetchMyOrdersAtShop', () => {
  const user = { id: 'u1' }

  it('filters by the signed-in user as well as the shop', async () => {
    // The `user_id` filter is load-bearing, not belt-and-braces. RLS lets a shop OWNER read
    // every order at their own shop, so a merchant opening their own storefront's history
    // would otherwise be shown their customers' orders as though they were their own.
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    __mocks.limit.mockResolvedValueOnce({ data: [{ id: 'o1' }], error: null })

    const result = await fetchMyOrdersAtShop('m1')

    expect(__mocks.from).toHaveBeenCalledWith('orders')
    expect(__mocks.eq).toHaveBeenCalledWith('merchant_id', 'm1')
    expect(__mocks.eq).toHaveBeenCalledWith('user_id', 'u1')
    expect(result).toEqual([{ id: 'o1' }])
  })

  it('lists newest first, capped at the stated limit', async () => {
    // The cap is shown to the customer on screen ("your last 20 orders"), so the number the
    // query uses and the number the copy quotes must be the same one.
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    __mocks.limit.mockResolvedValueOnce({ data: [], error: null })

    await fetchMyOrdersAtShop('m1')

    expect(__mocks.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(__mocks.limit).toHaveBeenCalledWith(ORDER_HISTORY_LIMIT)
    expect(ORDER_HISTORY_LIMIT).toBe(20)
  })

  it('queries nothing when signed out — a guest has no history to read', async () => {
    __mocks.getUser.mockResolvedValueOnce({ data: { user: null } })
    expect(await fetchMyOrdersAtShop('m1')).toEqual([])
    expect(__mocks.from).not.toHaveBeenCalled()
  })

  it('queries nothing without a shop', async () => {
    expect(await fetchMyOrdersAtShop('')).toEqual([])
    expect(__mocks.from).not.toHaveBeenCalled()
  })

  it('throws on DB error instead of passing an empty list off as "no orders"', async () => {
    // The screen renders an empty list as "You haven't ordered from this shop yet." Swallowing the
    // error here would tell a customer with a year of history that they have none — and they would
    // believe it. An empty history and a broken query must not look alike.
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    __mocks.limit.mockResolvedValueOnce({ data: null, error: { message: 'rls' } })
    await expect(fetchMyOrdersAtShop('m1')).rejects.toMatchObject({ message: 'rls' })
  })
})

// ── setOrderStatus (Task 5.2) ─────────────────────────────────────────────────

describe('setOrderStatus', () => {
  it('throws "Invalid status" for unknown status without calling update', async () => {
    await expect(setOrderStatus('ord-1', 'shipped')).rejects.toThrow('Invalid status')
    expect(__mocks.update).not.toHaveBeenCalled()
  })

  it('updates status on orders table and returns the updated row', async () => {
    const row = { id: 'ord-1', status: 'preparing' }
    __mocks.single.mockResolvedValueOnce({ data: row, error: null })

    const result = await setOrderStatus('ord-1', 'preparing')

    expect(__mocks.from).toHaveBeenCalledWith('orders')
    expect(__mocks.update).toHaveBeenCalledWith({ status: 'preparing' })
    expect(__mocks.eq).toHaveBeenCalledWith('id', 'ord-1')
    expect(result).toEqual(row)
  })

  it('accepts all five valid statuses: new, preparing, ready, completed, cancelled', async () => {
    for (const status of ['new', 'preparing', 'ready', 'completed', 'cancelled']) {
      vi.clearAllMocks()
      __mocks.single.mockResolvedValueOnce({ data: { id: 'ord-1', status }, error: null })
      const result = await setOrderStatus('ord-1', status)
      expect(result.status).toBe(status)
    }
  })

  it('throws on DB error after a valid status', async () => {
    __mocks.single.mockResolvedValueOnce({ data: null, error: new Error('write failed') })
    await expect(setOrderStatus('ord-1', 'ready')).rejects.toThrow('write failed')
  })
})

// ── fetchMerchantCustomers (Task 5.2) ─────────────────────────────────────────

describe('fetchMerchantCustomers', () => {
  it('groups orders by customer_wa with correct orderCount and lastOrder', async () => {
    const orders = [
      { id: 'o1', customer_name: 'Alice', customer_wa: '601', created_at: '2025-01-01' },
      { id: 'o2', customer_name: 'Bob',   customer_wa: '602', created_at: '2025-01-02' },
      { id: 'o3', customer_name: 'Alice', customer_wa: '601', created_at: '2025-01-03' },
    ]
    __mocks.order.mockResolvedValueOnce({ data: orders, error: null })

    const result = await fetchMerchantCustomers('m1')

    expect(result).toHaveLength(2)
    const alice = result.find(c => c.wa === '601')
    const bob   = result.find(c => c.wa === '602')
    expect(alice.orderCount).toBe(2)
    expect(alice.lastOrder).toBe('2025-01-03')
    expect(bob.orderCount).toBe(1)
  })

  it('returns empty array when merchant has no orders', async () => {
    __mocks.order.mockResolvedValueOnce({ data: [], error: null })
    expect(await fetchMerchantCustomers('m1')).toEqual([])
  })

  it('falls back to customer_name as key when customer_wa is missing', async () => {
    const orders = [
      { id: 'o1', customer_name: 'Charlie', customer_wa: null, created_at: '2025-01-01' },
      { id: 'o2', customer_name: 'Charlie', customer_wa: null, created_at: '2025-01-02' },
    ]
    __mocks.order.mockResolvedValueOnce({ data: orders, error: null })

    const result = await fetchMerchantCustomers('m1')

    expect(result).toHaveLength(1)
    expect(result[0].orderCount).toBe(2)
    expect(result[0].name).toBe('Charlie')
  })
})

// ── Multi-tenant vouchers ─────────────────────────────────────────────────────

describe('voucherFromRow', () => {
  it('maps table columns onto the Voucher shape', () => {
    expect(voucherFromRow({
      id: 'v1', code: 'SAVE10', kind: 'percent', amount: '10',
      max_uses: 50, used_by: ['a@x.com'],
    })).toEqual({
      id: 'v1', code: 'SAVE10', type: 'percent', value: 10,
      maxUses: 50, usedBy: ['a@x.com'],
    })
  })
  it('defaults usedBy to an empty array and tolerates null max_uses', () => {
    const v = voucherFromRow({ id: 'v2', code: 'X', kind: 'fixed', amount: 5, max_uses: null, used_by: null })
    expect(v.usedBy).toEqual([])
    expect(v.maxUses).toBeNull()
  })
})

describe('fetchMerchantVouchers', () => {
  it('returns [] for a missing merchantId without hitting the DB', async () => {
    expect(await fetchMerchantVouchers('')).toEqual([])
    expect(__mocks.from).not.toHaveBeenCalled()
  })
  it('maps rows scoped to the merchant', async () => {
    __mocks.eq.mockResolvedValueOnce({ data: [{ id: 'v1', code: 'A', kind: 'fixed', amount: 5, used_by: [] }], error: null })
    const result = await fetchMerchantVouchers('m1')
    expect(result).toEqual([{ id: 'v1', code: 'A', type: 'fixed', value: 5, maxUses: null, usedBy: [] }])
  })
  it('returns [] on error', async () => {
    __mocks.eq.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    expect(await fetchMerchantVouchers('m1')).toEqual([])
  })
})

describe('redeemVoucher', () => {
  it('calls the redeem_voucher RPC with a lowercased entry', async () => {
    __mocks.rpc.mockResolvedValueOnce({ error: null })
    await redeemVoucher('m1', 'SAVE10', 'ME@X.com')
    expect(__mocks.rpc).toHaveBeenCalledWith('redeem_voucher', { p_merchant: 'm1', p_code: 'SAVE10', p_entry: 'me@x.com' })
  })
  it('throws when the RPC errors', async () => {
    __mocks.rpc.mockResolvedValueOnce({ error: { message: 'fully used' } })
    await expect(redeemVoucher('m1', 'X', 'a@x.com')).rejects.toBeTruthy()
  })
})

describe('createMerchantVoucher', () => {
  it('inserts an uppercased code scoped to the merchant and maps the row back', async () => {
    __mocks.single.mockResolvedValueOnce({ data: { id: 'v9', code: 'SAVE10', kind: 'percent', amount: 10, max_uses: 100, used_by: [] }, error: null })
    const result = await createMerchantVoucher({ merchantId: 'm1', code: 'save10', kind: 'percent', amount: 10, maxUses: 100 })
    expect(__mocks.from).toHaveBeenCalledWith('vouchers')
    expect(__mocks.insert).toHaveBeenCalledWith({ merchant_id: 'm1', code: 'SAVE10', kind: 'percent', amount: 10, max_uses: 100 })
    expect(result).toEqual({ id: 'v9', code: 'SAVE10', type: 'percent', value: 10, maxUses: 100, usedBy: [] })
  })
  it('defaults max_uses to null and throws on error', async () => {
    __mocks.single.mockResolvedValueOnce({ data: null, error: { message: 'duplicate' } })
    await expect(createMerchantVoucher({ merchantId: 'm1', code: 'X', kind: 'fixed', amount: 5 })).rejects.toBeTruthy()
    expect(__mocks.insert).toHaveBeenCalledWith({ merchant_id: 'm1', code: 'X', kind: 'fixed', amount: 5, max_uses: null })
  })
})

describe('deleteMerchantVoucher', () => {
  it('deletes by id', async () => {
    __mocks.deleteEq.mockResolvedValueOnce({ error: null })
    await deleteMerchantVoucher('v9')
    expect(__mocks.from).toHaveBeenCalledWith('vouchers')
    expect(__mocks.deleteEq).toHaveBeenCalledWith('id', 'v9')
  })
  it('throws on error', async () => {
    __mocks.deleteEq.mockResolvedValueOnce({ error: { message: 'nope' } })
    await expect(deleteMerchantVoucher('v9')).rejects.toBeTruthy()
  })
})
