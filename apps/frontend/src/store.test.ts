import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

  // is() → { maybeSingle, single, is } — for .eq().is('merchant_id', null) chains.
  // Profile reads/writes moved behind the backend API (apiTry/apiSend); kept for any
  // remaining direct-supabase chain that still filters on a nullable column. Terminal via
  // maybeSingle.
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
  // resetPasswordForEmail() → supabase.auth.resetPasswordForEmail() for requestPasswordReset()
  const resetPasswordForEmail = vi.fn()
  const auth = { getUser, getSession, signUp, resetPasswordForEmail }

  // rpc mock — top-level supabase.rpc(name, params) → awaited directly.
  const rpc = vi.fn()

  return {
    supabase: { from, auth, rpc },
    __mocks: {
      from, select, eq, is, single, maybeSingle, insert, update,
      insertSelect, updateEqSelect, upsertSelect, getUser, getSession, signUp: auth.signUp, order, limit,
      upsert, del, deleteEq, rpc, resetPasswordForEmail,
    },
  }
})

import {
  fetchMerchantBySlug,
  fetchProfileByUserId,
  signUp,
  fetchMyMerchant,
  createMerchant,
  updateMerchantSlug,
  fetchAllMerchants,
  setMerchantStatus,
  fetchProducts,
  lookupProducts,
  lookupMerchantVoucher,
  upsertProduct,
  deleteProduct,
  updateMerchantConfig,
  fetchMerchantSecret,
  upsertMerchantSecret,
  placeOrder,
  fetchMerchantOrders,
  fetchMyOrdersAtShop,
  saveCustomerDetails,
  requestPasswordReset,
  ORDER_HISTORY_LIMIT,
  setOrderStatus,
  fetchMerchantCustomers,
  voucherFromRow,
  fetchMerchantVouchers,
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
  afterEach(() => vi.unstubAllGlobals())

  it('GETs /api/me/profile with a bearer token and returns the profile', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const profile = { id: 'p1', name: 'Fai', email: 'f@x.co', app_role: null, merchant_id: null }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => profile })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchProfileByUserId('u1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/me\/profile$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(result).toMatchObject({ id: 'p1', name: 'Fai' })
  })

  it('returns null when the request fails', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect(await fetchProfileByUserId('u1')).toBeNull()
  })
})

describe('signUp profile write', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs /api/me/profile with name/email/email_confirmed, a bearer token, and no user_id', async () => {
    __mocks.signUp.mockResolvedValueOnce({
      data: { user: { id: 'u1', email_confirmed_at: null } }, error: null,
    })
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await signUp('Fai', 'f@x.co', 'pw')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/me\/profile$/)
    expect(init.method).toBe('PUT')
    expect(init.headers.Authorization).toBe('Bearer tok')
    const body = JSON.parse(init.body)
    expect(body).toEqual({ name: 'Fai', email: 'f@x.co', email_confirmed: false })
    expect(body).not.toHaveProperty('user_id')
  })

  it('sends email_confirmed: true when the auth user is already confirmed', async () => {
    __mocks.signUp.mockResolvedValueOnce({
      data: { user: { id: 'u1', email_confirmed_at: '2026-07-02T00:00:00Z' } }, error: null,
    })
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await signUp('Fai', 'f@x.co', 'pw')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ email_confirmed: true })
  })

  it('does not throw when there is no session yet (pending email confirmation)', async () => {
    // No session at signup time (email confirmation is on project-wide) → the PUT 401s, same
    // shape as RLS blocking the old browser write; ensureGlobalProfile swallows it and signUp
    // still resolves with the new user. It's retried from onAuthChange once a session exists.
    __mocks.signUp.mockResolvedValueOnce({
      data: { user: { id: 'u1', email_confirmed_at: null } }, error: null,
    })
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Unauthorized' }) }))

    await expect(signUp('Fai', 'f@x.co', 'pw')).resolves.toMatchObject({ id: 'u1' })
  })
})

// ── fetchMerchantBySlug (Task 1.2) ────────────────────────────────────────────

describe('fetchMerchantBySlug', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns null for a reserved slug without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMerchantBySlug('admin')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('GETs /api/merchants/:slug with no auth header and returns the merchant row when found', async () => {
    const row = { id: 'm1', slug: 'shop-a' }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMerchantBySlug('shop-a')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/shop-a$/)
    expect(init.headers).toEqual({})
    expect(result).toEqual(row)
  })
  it('returns null when not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect(await fetchMerchantBySlug('missing')).toBeNull()
  })
})

// ── fetchMyMerchant (Task 2.2) ────────────────────────────────────────────────

describe('fetchMyMerchant', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs /api/me/merchant with a bearer token and returns the row', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'm1', owner_id: 'u1', slug: 'shop-a' }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMyMerchant('u1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/me\/merchant$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(result).toEqual(row)
  })

  it('returns null on a failed request', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect(await fetchMyMerchant('u1')).toBeNull()
  })

  it('returns null immediately for null userId without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMyMerchant(null as any)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── createMerchant (Task 2.2) ─────────────────────────────────────────────────

describe('createMerchant', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs /api/merchants with name/plan/billing/region/referredByCode and a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const merchantRow = {
      id: 'm1', name: 'My Shop', slug: 'my-shop',
      order_prefix: 'MY', owner_id: 'user-abc', status: 'pending',
    }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => merchantRow, text: async () => JSON.stringify(merchantRow),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createMerchant({ name: 'My Shop' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants$/)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({
      name: 'My Shop', plan: 'basic', billing: 'monthly', region: 'US',
    })
    expect(result).toEqual(merchantRow)
  })

  it('throws on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Missing name' }) }))
    await expect(createMerchant({ name: '' })).rejects.toThrow('Missing name')
  })
})

// ── updateMerchantSlug (Task 3.3) ─────────────────────────────────────────────

describe('updateMerchantSlug', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('throws for a reserved slug without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(updateMerchantSlug('m1', 'admin')).rejects.toThrow('Reserved or empty slug')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws for an empty slug without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(updateMerchantSlug('m1', '')).rejects.toThrow('Reserved or empty slug')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('PATCHes /api/merchants/:id/slug with a bearer token and returns the updated row', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const updated = { id: 'm1', slug: 'new-shop' }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => updated, text: async () => JSON.stringify(updated),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await updateMerchantSlug('m1', 'New-Shop')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/slug$/)
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ slug: 'new-shop' })
    expect(result).toEqual(updated)
  })

  it('throws when the backend reports the slug is taken', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, json: async () => ({ error: 'Slug already taken' }),
    }))
    await expect(updateMerchantSlug('m1', 'taken-slug')).rejects.toThrow('Slug already taken')
  })
})

// ── fetchAllMerchants (Task 3.2) ──────────────────────────────────────────────

describe('fetchAllMerchants', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs /api/merchants with a bearer token and returns the list', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const rows = [{ id: 'm2', created_at: '2025-02-01' }, { id: 'm1', created_at: '2025-01-01' }]
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => rows })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchAllMerchants()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(result).toEqual(rows)
  })

  it('returns an empty array when the backend has none — a 200 returning []', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] }))
    expect(await fetchAllMerchants()).toEqual([])
  })

  it('throws on a non-ok response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'DB fail' }) }))
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
  afterEach(() => vi.unstubAllGlobals())

  it('returns empty array immediately when merchantId is falsy', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchProducts(null as any)).toEqual([])
    expect(await fetchProducts('')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('GETs /api/merchants/:id/products with no auth header and returns the rows', async () => {
    const rows = [{ id: 'p1', sort: 0 }, { id: 'p2', sort: 1 }]
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => rows })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchProducts('m1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/products$/)
    expect(init.headers).toEqual({})
    expect(result).toEqual(rows)
  })

  it('returns empty array on a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect(await fetchProducts('m1')).toEqual([])
  })
})

// `lookupProducts` carries the null-vs-"could not ask" contract that `fetchProducts` (above)
// collapses with `?? []`. A 200 with `[]` is a real answer (the shop sells nothing); a failed
// request is not an answer at all and must come back as `null`, never `[]`.
describe('lookupProducts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns [] immediately when merchantId is falsy, without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupProducts(null as any)).toEqual([])
    expect(await lookupProducts('')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns [] on a 200 with an empty menu (the real answer: the shop sells nothing)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] }))
    expect(await lookupProducts('m1')).toEqual([])
  })

  it('returns null when the request fails to resolve (network/CORS rejection) — could not ask', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')))
    expect(await lookupProducts('m1')).toBeNull()
  })

  it('returns null on a non-ok response — could not ask', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect(await lookupProducts('m1')).toBeNull()
  })
})

// ── upsertProduct (Task 5) ────────────────────────────────────────────────────

describe('upsertProduct', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs /api/merchants/:merchant_id/products/:id with a bearer token, returns the saved row', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const product = { id: 'p1', name: 'Cookie', merchant_id: 'm1', price: 5 }
    const saved = { ...product }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => saved, text: async () => JSON.stringify(saved),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await upsertProduct(product)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/products\/p1$/)
    expect(init.method).toBe('PUT')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual(product)
    expect(result).toEqual(saved)
  })

  it('throws on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, json: async () => ({ error: 'Upsert failed' }),
    }))
    await expect(upsertProduct({ id: 'p1', name: 'x', merchant_id: 'm1' })).rejects.toThrow('Upsert failed')
  })
})

// ── deleteProduct (Task 5) ────────────────────────────────────────────────────

describe('deleteProduct', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('DELETEs /api/merchants/:merchantId/products/:id with a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await deleteProduct('p1', 'm1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/products\/p1$/)
    expect(init.method).toBe('DELETE')
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('throws on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, json: async () => ({ error: 'Delete failed' }),
    }))
    await expect(deleteProduct('p1', 'm1')).rejects.toThrow('Delete failed')
  })
})

// ── updateMerchantConfig (Task 3.3) ───────────────────────────────────────────

describe('updateMerchantConfig', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PATCHes /api/merchants/:id with the patch and a bearer token, returns the updated row', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const patch = { payment_note: 'Pay on pickup', shipping: { WM: 10 } }
    const row = { id: 'm1', ...patch }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => row, text: async () => JSON.stringify(row),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await updateMerchantConfig('m1', patch)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1$/)
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual(patch)
    expect(result).toEqual(row)
  })

  it('throws on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, json: async () => ({ error: 'update failed' }),
    }))
    await expect(updateMerchantConfig('m1', { payment_note: 'x' })).rejects.toThrow('update failed')
  })
})

// ── fetchMerchantSecret (Task 4.1) ────────────────────────────────────────────

describe('fetchMerchantSecret', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs /api/merchants/:id/secret with a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const secret = { tg_token: 'tok123', tg_chat_id: '456' }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => secret })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMerchantSecret('m1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/secret$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(result).toEqual(secret)
  })

  it('returns null when no row exists (backend responds not-ok)', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect(await fetchMerchantSecret('m1')).toBeNull()
  })

  it('returns null immediately for a missing merchantId without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMerchantSecret('')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
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

// Intake is ONE backend call now: the order number, the order row and the voucher claim
// commit together in a transaction server-side. The browser holds no INSERT on `orders` at
// all, so what this file can still usefully assert is the request it sends — above all that
// it never sends a user_id (the JWT decides attribution) and that it surfaces the server's
// refusal code rather than a generic failure.
describe('placeOrder', () => {
  function fetchOk(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function fetchRefused(code: string) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: code }) })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => vi.unstubAllGlobals())

  it('POSTs the order to the backend and returns the number it assigns', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    const fetchMock = fetchOk({ orderNumber: 'BT-260714-0050' })

    const result = await placeOrder({
      merchantId: 'm1',
      customerName: 'Alice',
      customerWa: '60123456789',
      mode: 'delivery',
      address: '123 Jalan ABC',
      cart: { p1: 2 },
      quotedTotal: 24,
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/orders$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({
      merchantId: 'm1',
      customerName: 'Alice',
      cart: { p1: 2 },
      quotedTotal: 24,
    })
    expect(result).toEqual({ orderNumber: 'BT-260714-0050' })
  })

  it('sends a signed-in customer’s bearer token, so the backend can attribute the order', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = fetchOk({ orderNumber: 'BT-1' })

    await placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any)

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')
  })

  it('sends no Authorization header for a guest — guest checkout is a first-class path', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    const fetchMock = fetchOk({ orderNumber: 'BT-1' })

    await placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any)

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  // The spoofing hole. The orders_set_user_id trigger no longer discards a supplied user_id —
  // it keeps it — so the browser must never send one, and this is the test that says so.
  it('never sends a user_id: the JWT decides who the order belongs to', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = fetchOk({ orderNumber: 'BT-1' })

    await placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0, user_id: 'someone-else' } as any)

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('user_id')
  })

  // The storefront needs to know WHICH refusal it was, so it can drop the voucher and tell the
  // customer to retry without it. A generic "failed" would strand them.
  it('throws the backend’s refusal code, not a generic failure', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    fetchRefused('voucher_already_used')

    await expect(placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any))
      .rejects.toMatchObject({ code: 'voucher_already_used' })
  })

  // fetch REJECTS on a network failure rather than returning !ok, so without a catch the
  // customer sees a raw "Failed to fetch" on the checkout screen.
  it('reports a network failure as a refusal the storefront can phrase', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any))
      .rejects.toMatchObject({ code: 'network' })
  })

  it('falls back to order_failed when the backend gives no code', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => { throw new Error('no body') } }))

    await expect(placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any))
      .rejects.toMatchObject({ code: 'order_failed' })
  })
})

// ── fetchMerchantOrders (Task 5.2) ────────────────────────────────────────────

describe('fetchMerchantOrders', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns empty array immediately for falsy merchantId', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMerchantOrders(null as any)).toEqual([])
    expect(await fetchMerchantOrders('')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('GETs /api/merchants/:id/orders with a bearer token and returns the list', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const rows = [{ id: 'o2', merchant_id: 'm1' }, { id: 'o1', merchant_id: 'm1' }]
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => rows })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMerchantOrders('m1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/orders$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(result).toEqual(rows)
  })

  it('returns empty array on a failed request', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect(await fetchMerchantOrders('m1')).toEqual([])
  })
})

// ── fetchMyOrdersAtShop (#55: per-shop order history) ─────────────────────────

describe('fetchMyOrdersAtShop', () => {
  const user = { id: 'u1' }

  afterEach(() => vi.unstubAllGlobals())

  it('GETs /api/merchants/:id/my-orders with a bearer token for a signed-in customer', async () => {
    // The backend derives the signed-in user from the bearer token and scopes the history to
    // BOTH that user and the shop — the browser no longer states the filter itself, it just
    // proves it is signed in.
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const rows = [{ id: 'o1' }]
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => rows })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMyOrdersAtShop('m1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/my-orders$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(result).toEqual(rows)
  })

  it('states the history cap shown on screen ("your last 20 orders")', () => {
    expect(ORDER_HISTORY_LIMIT).toBe(20)
  })

  it('queries nothing when signed out — a guest has no history to read', async () => {
    __mocks.getUser.mockResolvedValueOnce({ data: { user: null } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMyOrdersAtShop('m1')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('queries nothing without a shop', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMyOrdersAtShop('')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on a non-ok response instead of passing an empty list off as "no orders"', async () => {
    // The screen renders an empty list as "You haven't ordered from this shop yet." Swallowing the
    // error here would tell a customer with a year of history that they have none — and they would
    // believe it. An empty history and a broken query must not look alike.
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'rls' }) }))
    await expect(fetchMyOrdersAtShop('m1')).rejects.toThrow('rls')
  })
})

// ── saveCustomerDetails (#56: type it once, ever) ─────────────────────────────

describe('saveCustomerDetails', () => {
  const user = { id: 'u1', email: 'ah.meng@example.com' }
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs /api/me/profile — the same GLOBAL row ensureGlobalProfile maintains', async () => {
    // An address is an address: it belongs to the customer, not to a shop. Saving it per-shop
    // would make them retype it at the next storefront — the exact tax this removes.
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await saveCustomerDetails({ whatsapp: '60123456789' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/me\/profile$/)
    expect(init.method).toBe('PUT')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ whatsapp: '60123456789' })
  })

  it('saves nothing for a guest — not even a stray write attempt', async () => {
    // A guest order is orphaned permanently. Writing their number to a profile they don't have
    // is not merely useless; it is the retroactive claim the guest warning promises never happens.
    __mocks.getUser.mockResolvedValueOnce({ data: { user: null } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await saveCustomerDetails({ whatsapp: '60123456789' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not touch the profile when there is nothing to save', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await saveCustomerDetails({})
    expect(__mocks.getUser).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('swallows a rejected fetch — best-effort, never throws', async () => {
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')))

    await expect(saveCustomerDetails({ whatsapp: '60123456789' })).resolves.toBeUndefined()
  })
})

// ── requestPasswordReset (#57: non-enumeration is the whole point) ────────────

describe('requestPasswordReset', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'https://bitetime.co' } })
  })

  it('reports nothing when Supabase errors — an error here is an enumeration oracle', async () => {
    // Supabase's per-email cooldown fires only when a mail is actually SENT, i.e. only for an
    // address that HAS an account. If this function surfaced that, two requests a minute apart
    // would tell an attacker which addresses are registered. It must be silent either way, so the
    // caller has nothing to render but the neutral message.
    __mocks.resetPasswordForEmail.mockResolvedValueOnce({ error: { message: 'over_email_send_rate_limit' } })
    await expect(requestPasswordReset('taken@example.com', 'cookie-lab')).resolves.toBeUndefined()

    __mocks.resetPasswordForEmail.mockRejectedValueOnce(new Error('network down'))
    await expect(requestPasswordReset('taken@example.com', 'cookie-lab')).resolves.toBeUndefined()
  })

  it('sends the customer back to the shop they were ordering from', async () => {
    __mocks.resetPasswordForEmail.mockResolvedValueOnce({ error: null })
    await requestPasswordReset('  ah.meng@example.com ', 'cookie-lab')
    expect(__mocks.resetPasswordForEmail).toHaveBeenCalledWith('ah.meng@example.com', {
      redirectTo: 'https://bitetime.co/reset-password?shop=cookie-lab',
    })
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
  // fetchMerchantCustomers derives its grouping entirely from fetchMerchantOrders, so the mock
  // here feeds the /api/merchants/:id/orders response — not a supabase order chain.
  afterEach(() => vi.unstubAllGlobals())

  it('groups orders by customer_wa with correct orderCount and lastOrder', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const orders = [
      { id: 'o1', customer_name: 'Alice', customer_wa: '601', created_at: '2025-01-01' },
      { id: 'o2', customer_name: 'Bob',   customer_wa: '602', created_at: '2025-01-02' },
      { id: 'o3', customer_name: 'Alice', customer_wa: '601', created_at: '2025-01-03' },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => orders }))

    const result = await fetchMerchantCustomers('m1')

    expect(result).toHaveLength(2)
    const alice = result.find(c => c.wa === '601')
    const bob   = result.find(c => c.wa === '602')
    expect(alice.orderCount).toBe(2)
    expect(alice.lastOrder).toBe('2025-01-03')
    expect(bob.orderCount).toBe(1)
  })

  it('returns empty array when merchant has no orders', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] }))
    expect(await fetchMerchantCustomers('m1')).toEqual([])
  })

  it('falls back to customer_name as key when customer_wa is missing', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const orders = [
      { id: 'o1', customer_name: 'Charlie', customer_wa: null, created_at: '2025-01-01' },
      { id: 'o2', customer_name: 'Charlie', customer_wa: null, created_at: '2025-01-02' },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => orders }))

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
  afterEach(() => vi.unstubAllGlobals())

  it('returns [] for a missing merchantId without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMerchantVouchers('')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('GETs /api/merchants/:id/vouchers with a bearer token and maps rows scoped to the merchant', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const rows = [{ id: 'v1', code: 'A', kind: 'fixed', amount: 5, used_by: [] }]
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => rows })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMerchantVouchers('m1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/vouchers$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(result).toEqual([{ id: 'v1', code: 'A', type: 'fixed', value: 5, maxUses: null, usedBy: [] }])
  })
  it('returns [] on a failed request', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect(await fetchMerchantVouchers('m1')).toEqual([])
  })
})

// `lookupMerchantVoucher` carries the same null-vs-"could not ask" contract as `lookupProducts`:
// a 200 with a null body is a real answer (the shop has no such voucher), while a failed
// request must come back as `{ ok:false }`, never collapsed onto "no voucher".
describe('lookupMerchantVoucher', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns { ok:true, voucher:null } immediately when merchantId or code is falsy, without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupMerchantVoucher('', 'CODE')).toEqual({ ok: true, voucher: null })
    expect(await lookupMerchantVoucher('m1', '')).toEqual({ ok: true, voucher: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('GETs /api/merchants/:id/vouchers/:code with no auth header and maps a found row', async () => {
    const row = { id: 'v1', code: 'A', kind: 'fixed', amount: 5, used_by: [] }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row })
    vi.stubGlobal('fetch', fetchMock)

    const result = await lookupMerchantVoucher('m1', 'A')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/vouchers\/A$/)
    expect(init.headers).toEqual({})
    expect(result).toEqual({ ok: true, voucher: { id: 'v1', code: 'A', type: 'fixed', value: 5, maxUses: null, usedBy: [] } })
  })

  it('returns { ok:true, voucher:null } on a 200 with a null body (the real answer: no such voucher)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => null }))
    expect(await lookupMerchantVoucher('m1', 'MISSING')).toEqual({ ok: true, voucher: null })
  })

  it('returns { ok:false } on a failed request — could not ask', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect(await lookupMerchantVoucher('m1', 'A')).toEqual({ ok: false })
  })
})

// `redeemVoucher` is gone on purpose and has no tests to replace it. It was a second call
// made AFTER the order was already committed, which is what let a failed redemption leave the
// customer with a discount on a voucher that was never marked used. The claim now happens
// inside placeOrder's transaction, and is proven against a real Postgres — including under
// concurrent redemption — in apps/backend/tests/api/orders.test.ts.

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
