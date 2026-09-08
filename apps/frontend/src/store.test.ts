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

  // storage mock — unused by any test today (no product-image/payment-QR test coverage yet),
  // kept minimal so the module still shapes correctly for anything that imports it.
  const storage = { from: vi.fn() }

  return {
    auth,
    storage,
    __mocks: {
      from, select, eq, is, single, maybeSingle, insert, update,
      insertSelect, updateEqSelect, upsertSelect, getUser, getSession, signUp: auth.signUp, order, limit,
      upsert, del, deleteEq, rpc, resetPasswordForEmail,
    },
  }
})

import {
  lookupMerchantBySlug,
  fetchProfileByUserId,
  signUp,
  lookupMyMerchant,
  createMerchant,
  updateMerchantSlug,
  fetchAllMerchants,
  setMerchantStatus,
  lookupProducts,
  lookupMerchantVoucher,
  upsertProduct,
  deleteProduct,
  updateMerchantConfig,
  fetchMerchantSecret,
  upsertMerchantSecret,
  placeOrder,
  uploadPaymentProof,
  fetchPaymentProof,
  fetchMyPaymentProof,
  uploadMerchantPaymentProof,
  fetchMerchantPaymentProof,
  fetchMyMerchantPaymentProof,
  MAX_PAYMENT_PROOF_BYTES,
  fetchMerchantOrders,
  fetchOrderCount,
  fetchMyOrdersAtShop,
  saveCustomerDetails,
  requestPasswordReset,
  ORDER_HISTORY_LIMIT,
  setOrderStatus,
  setOrderNote,
  setOrderTracking,
  fetchShopCustomers,
  voucherFromRow,
  voucherFullyUsed,
  fetchMerchantVouchers,
  createMerchantVoucher,
  updateMerchantVoucher,
  setMerchantVoucherActive,
  quoteDelivery,
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
    expect(result).toMatchObject({ ok: true, data: { id: 'p1', name: 'Fai' } })
  })

  it('returns { ok:false } when the request fails', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }))
    expect((await fetchProfileByUserId('u1')).ok).toBe(false)
  })
})

describe('signUp', () => {
  afterEach(() => vi.unstubAllGlobals())

  const shop = {
    name: 'Sunny Bakes',
    businessNature: 'bakery',
    currency: 'MYR' as const,
    billing: 'yearly' as const,
  }

  it('POSTs the merchant signup door with the account AND the shop, and no bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    await signUp('Fai', 'f@x.co', 'hunter2hunter2', shop)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchant\/signup$/)
    expect(init.method).toBe('POST')
    // Unauthenticated by design: there is no account yet to hold a token.
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual({
      email: 'f@x.co', password: 'hunter2hunter2', name: 'Fai', shop,
    })
  })

  it('never calls auth.signUp — the client-side door is what left merchants in their inbox', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }))
    await signUp('Fai', 'f@x.co', 'hunter2hunter2', shop)
    expect(__mocks.signUp).not.toHaveBeenCalled()
  })

  it('throws the endpoint refusal as a SignupError carrying its code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 409, json: async () => ({ error: 'duplicate_email' }),
    }))
    await expect(signUp('Fai', 'f@x.co', 'hunter2hunter2', shop))
      .rejects.toMatchObject({ name: 'SignupError', code: 'duplicate_email' })
  })

  it('reports an unreachable backend as network, not as a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')))
    await expect(signUp('Fai', 'f@x.co', 'hunter2hunter2', shop))
      .rejects.toMatchObject({ code: 'network' })
  })
})

// ── lookupMerchantBySlug (Task 1.2) ───────────────────────────────────────────

describe('lookupMerchantBySlug', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns { ok:true, data:null } for a reserved slug without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupMerchantBySlug('admin')).toEqual({ ok: true, data: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('GETs /api/merchants/:slug with no auth header and returns the merchant row when found', async () => {
    const row = { id: 'm1', slug: 'shop-a' }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row })
    vi.stubGlobal('fetch', fetchMock)

    const result = await lookupMerchantBySlug('shop-a')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/shop-a$/)
    expect(init.headers).toEqual({})
    expect(result).toEqual({ ok: true, data: row })
  })
  it('returns { ok:true, data:null } when the backend answers 200 with a null body (no such shop)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => null }))
    expect(await lookupMerchantBySlug('missing')).toEqual({ ok: true, data: null })
  })
  it('returns { ok:false } on a could-not-ask (non-2xx) — never collapsed to "no shop"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }))
    expect((await lookupMerchantBySlug('shop-a')).ok).toBe(false)
  })
})

// ── lookupMyMerchant (Task 2.2, #98) ──────────────────────────────────────────

describe('lookupMyMerchant', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs /api/me/merchant with a bearer token and returns the row', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'm1', owner_id: 'u1', slug: 'shop-a' }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row })
    vi.stubGlobal('fetch', fetchMock)

    const result = await lookupMyMerchant('u1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/me\/merchant$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(result).toEqual({ ok: true, data: row })
  })

  it('answers "you own no shop" when the API says so', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => null }))
    expect(await lookupMyMerchant('u1')).toEqual({ ok: true, data: null })
  })

  // The distinction #98 turned on: a request that never landed is NOT the answer
  // "you own no shop". Collapsing the two demoted a merchant to a customer and
  // bounced them off their own dashboard.
  it('reports "could not ask" on a non-2xx', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }))
    expect((await lookupMyMerchant('u1')).ok).toBe(false)
  })

  it('reports "could not ask" when the request is blocked outright (CORS/offline)', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')))
    expect((await lookupMyMerchant('u1')).ok).toBe(false)
  })

  it('answers "no shop" immediately for null userId without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupMyMerchant(null as any)).toEqual({ ok: true, data: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── createMerchant (Task 2.2) ─────────────────────────────────────────────────

describe('createMerchant', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs /api/merchants with name/billing/referredByCode and a bearer token', async () => {
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
      name: 'My Shop', billing: 'monthly',
    })
    expect(result).toEqual({ ok: true, data: merchantRow })
  })

  it('returns { ok:false, error } on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'Missing name' }) }))
    const r = await createMerchant({ name: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('Missing name')
  })
})

// ── updateMerchantSlug (Task 3.3) ─────────────────────────────────────────────

describe('updateMerchantSlug', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns { ok:false, code:reserved_slug } for a reserved slug without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await updateMerchantSlug('m1', 'admin')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('reserved_slug')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns { ok:false } for an empty slug without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await updateMerchantSlug('m1', '')).ok).toBe(false)
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
    expect(result).toEqual({ ok: true, data: updated })
  })

  it('returns { ok:false } when the backend reports the slug is taken', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 409, json: async () => ({ error: 'Slug already taken' }),
    }))
    const r = await updateMerchantSlug('m1', 'taken-slug')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('Slug already taken')
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
    expect(result).toEqual({ ok: true, data: rows })
  })

  it('returns { ok:true, data:[] } when the backend has none — a 200 returning []', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] }))
    expect(await fetchAllMerchants()).toEqual({ ok: true, data: [] })
  })

  it('returns { ok:false } on a non-ok response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'DB fail' }) }))
    expect((await fetchAllMerchants()).ok).toBe(false)
  })
})

// ── setMerchantStatus (Task 3.2) ──────────────────────────────────────────────

describe('setMerchantStatus', () => {
  const okSession = { data: { session: { access_token: 'tok' } } }

  it('returns { ok:false, code:invalid_status } for an unknown status without calling the backend', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await setMerchantStatus('m1', 'banned')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_status')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('returns { ok:false, code:not_signed_in } when there is no session (auth:required, no fetch)', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await setMerchantStatus('m1', 'active')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('not_signed_in')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('POSTs merchantId + status to the admin endpoint with a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce(okSession)
    const row = { ok: true, status: 'suspended' }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => row, text: async () => JSON.stringify(row),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await setMerchantStatus('m1', 'suspended')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/admin\/set-merchant-status$/)
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(opts.body)).toEqual({ merchantId: 'm1', status: 'suspended' })
    expect(result).toEqual({ ok: true, data: row })
    vi.unstubAllGlobals()
  })

  it('returns { ok:false } with the backend error message on a non-ok response', async () => {
    __mocks.getSession.mockResolvedValueOnce(okSession)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 403, json: async () => ({ error: 'Forbidden' }),
    }))
    const r = await setMerchantStatus('m1', 'active')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('Forbidden')
    vi.unstubAllGlobals()
  })
})

// ── lookupProducts (Task 4.1) ──────────────────────────────────────────────────

// `lookupProducts` is the one menu read, on the Result convention. A 200 with `[]` is a real
// answer (`{ ok:true, data:[] }` — the shop sells nothing); a failed request is not an answer at
// all and must come back as `{ ok:false }`, never an empty menu.
describe('lookupProducts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns { ok:true, data:[] } immediately when merchantId is falsy, without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupProducts(null as any)).toEqual({ ok: true, data: [] })
    expect(await lookupProducts('')).toEqual({ ok: true, data: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('GETs /api/merchants/:id/products with no auth header and returns the rows', async () => {
    const rows = [{ id: 'p1', sort: 0 }, { id: 'p2', sort: 1 }]
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => rows })
    vi.stubGlobal('fetch', fetchMock)

    const result = await lookupProducts('m1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/products$/)
    expect(init.headers).toEqual({})
    expect(result).toEqual({ ok: true, data: rows })
  })

  it('returns { ok:true, data:[] } on a 200 with an empty menu (the real answer: the shop sells nothing)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] }))
    expect(await lookupProducts('m1')).toEqual({ ok: true, data: [] })
  })

  it('returns { ok:false } when the request fails to resolve (network/CORS rejection) — could not ask', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')))
    expect((await lookupProducts('m1')).ok).toBe(false)
  })

  it('returns { ok:false } on a non-ok response — could not ask', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }))
    expect((await lookupProducts('m1')).ok).toBe(false)
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
    expect(result).toEqual({ ok: true, data: saved })
  })

  it('returns { ok:false, error } on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'Upsert failed' }),
    }))
    const r = await upsertProduct({ id: 'p1', name: 'x', merchant_id: 'm1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('Upsert failed')
  })
})

// ── deleteProduct (Task 5) ────────────────────────────────────────────────────

describe('deleteProduct', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('DELETEs /api/merchants/:merchantId/products/:id with a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    expect(await deleteProduct('p1', 'm1')).toEqual({ ok: true, data: undefined })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/products\/p1$/)
    expect(init.method).toBe('DELETE')
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('returns { ok:false, error } on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'Delete failed' }),
    }))
    const r = await deleteProduct('p1', 'm1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('Delete failed')
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
    expect(result).toEqual({ ok: true, data: row })
  })

  it('returns { ok:false, error } on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'update failed' }),
    }))
    const r = await updateMerchantConfig('m1', { payment_note: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('update failed')
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
    expect(result).toEqual({ ok: true, data: secret })
  })

  it('returns { ok:false } when the request fails (could not ask)', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }))
    expect((await fetchMerchantSecret('m1')).ok).toBe(false)
  })

  it('returns { ok:true, data:null } immediately for a missing merchantId without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMerchantSecret('')).toEqual({ ok: true, data: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── upsertMerchantSecret (Task 4.1) ───────────────────────────────────────────

describe('upsertMerchantSecret', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs /api/merchants/:id/secret with the secret fields and a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const secret = { tg_token: 'tok', tg_chat_id: '123' }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await upsertMerchantSecret('m1', secret)
    expect(r).toEqual({ ok: true, data: undefined })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/secret$/)
    expect(init.method).toBe('PUT')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual(secret)
  })

  it('returns { ok:false, error } on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'upsert failed' }),
    }))
    const r = await upsertMerchantSecret('m1', { tg_token: 'x', tg_chat_id: 'y' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('upsert failed')
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
    const fetchMock = fetchOk({ orderNumber: 'BT-260714-0050', id: 'order-uuid-1' })

    const result = await placeOrder({
      merchantId: 'm1',
      customerName: 'Alice',
      customerWa: '60123456789',
      mode: 'delivery',
      address: '123 Jalan ABC',
      cart: [{ productId: 'p1', qty: 2, selections: [] }],
      quotedTotal: 24,
      fulfilDate: '2026-07-21',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/orders$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({
      merchantId: 'm1',
      customerName: 'Alice',
      cart: [{ productId: 'p1', qty: 2, selections: [] }],
      quotedTotal: 24,
      fulfilDate: '2026-07-21',
    })
    expect(result).toEqual({ ok: true, data: { orderNumber: 'BT-260714-0050', id: 'order-uuid-1' } })
  })

  it('surfaces the order id from the response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    fetchOk({ orderNumber: 'BT-1', id: 'abc-123' })

    const r = await placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any)

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.id).toBe('abc-123')
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
  // customer to retry without it. A generic "failed" would strand them. The refusal survives as
  // the Result's error — a full OrderError carrying `code` (and `now` on price_changed).
  it('returns the backend’s refusal code in error, not a generic failure', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    fetchRefused('voucher_already_used')

    const r = await placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('voucher_already_used')
  })

  // fetch REJECTS on a network failure rather than returning !ok, so without the catch the
  // customer would see a raw "Failed to fetch" — the storefront gets { code: 'network' } instead.
  it('reports a network failure as a refusal the storefront can phrase', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const r = await placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('network')
  })

  it('falls back to order_failed when the backend gives no code', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => { throw new Error('no body') } }))

    const r = await placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('order_failed')
  })

  it('carries the server clock (now) on a price_changed refusal — the #69 offset fix', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: 'price_changed', now: '2026-07-25T00:00:00Z' }),
    }))

    const r = await placeOrder({ merchantId: 'm1', cart: { p1: 1 }, quotedTotal: 0 } as any)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('price_changed')
      expect(r.error.now).toBe('2026-07-25T00:00:00Z')
    }
  })
})

describe('uploadPaymentProof', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects an unsupported type without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['x'], 'proof.gif', { type: 'image/gif' })

    const r = await uploadPaymentProof('order-1', file)

    expect(r.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized file without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const big = new Uint8Array(MAX_PAYMENT_PROOF_BYTES + 1)
    const file = new File([big], 'proof.png', { type: 'image/png' })

    const r = await uploadPaymentProof('order-1', file)

    expect(r.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts a valid file to /api/orders/:orderId/payment-proof', async () => {
    // No auth: unlike fetchPaymentProof, this is the guest checkout path — it never calls
    // getSession at all (apiSendFile is called with no `auth` option).
    const saved = { payment_proof: 'm1/order-1.png', status: 'new' }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ...saved }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['x'], 'proof.png', { type: 'image/png' })

    const r = await uploadPaymentProof('order-1', file)

    expect(r.ok).toBe(true)
    // The row the write moved — order history patches its own list from this.
    expect(r.ok && r.data).toMatchObject(saved)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/orders\/order-1\/payment-proof$/)
    expect(init.body).toBe(file)
  })
})

describe('fetchPaymentProof', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs /api/merchants/:merchantId/orders/:orderId/payment-proof and unwraps to the blob', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const blob = new Blob(['x'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, headers: new Headers(), blob: async () => blob,
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await fetchPaymentProof('m1', 'order-1')

    expect(r).toEqual({ ok: true, data: blob })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/orders\/order-1\/payment-proof$/)
  })
})

describe('uploadMerchantPaymentProof', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs the file to the merchant slot with a bearer token and returns the saved row', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const saved = { payment_proof_merchant: 'm1/order-1-merchant.png', status: 'new' }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ...saved }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['x'], 'slip.png', { type: 'image/png' })

    const r = await uploadMerchantPaymentProof('m1', 'order-1', file)

    expect(r.ok).toBe(true)
    expect(r.ok && r.data).toMatchObject(saved)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/orders\/order-1\/merchant-payment-proof$/)
    expect(init.body).toBe(file)
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('rejects an oversized file without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const big = new Uint8Array(MAX_PAYMENT_PROOF_BYTES + 1)
    const file = new File([big], 'slip.png', { type: 'image/png' })

    const r = await uploadMerchantPaymentProof('m1', 'order-1', file)

    expect(r.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('fetchMyMerchantPaymentProof', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs the customer-scoped merchant slot and unwraps to the blob', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const blob = new Blob(['x'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, headers: new Headers(), blob: async () => blob,
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await fetchMyMerchantPaymentProof('order-1')

    expect(r).toEqual({ ok: true, data: blob })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/orders\/order-1\/merchant-payment-proof$/)
  })
})

describe('fetchMerchantPaymentProof', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs the merchant slot and unwraps to the blob', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const blob = new Blob(['x'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, headers: new Headers(), blob: async () => blob,
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await fetchMerchantPaymentProof('m1', 'order-1')

    expect(r).toEqual({ ok: true, data: blob })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/orders\/order-1\/merchant-payment-proof$/)
  })
})

describe('fetchMyPaymentProof', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs /api/orders/:orderId/payment-proof and unwraps to the blob', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const blob = new Blob(['x'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, headers: new Headers(), blob: async () => blob,
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await fetchMyPaymentProof('order-1')

    expect(r).toEqual({ ok: true, data: blob })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/orders\/order-1\/payment-proof$/)
  })
})

// ── fetchMerchantOrders (Task 5.2; paged since #144) ──────────────────────────

describe('fetchMerchantOrders', () => {
  const page = { orders: [{ id: 'o2' }, { id: 'o1' }], total: 1200, page: 1, pageSize: 15 }

  afterEach(() => vi.unstubAllGlobals())

  it('returns an empty page immediately for falsy merchantId', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const empty = { ok: true, data: { orders: [], total: 0, page: 1, pageSize: 0 } }
    expect(await fetchMerchantOrders(null as any)).toEqual(empty)
    expect(await fetchMerchantOrders('')).toEqual(empty)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('GETs /api/merchants/:id/orders with a bearer token and returns the page', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => page })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMerchantOrders('m1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/orders$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    // `total` is the shop's whole matched count, not the page's length — it is what tells the
    // merchant they are looking at a slice, which the old unbounded list never did (#144).
    expect(result).toEqual({ ok: true, data: page })
  })

  it('sends the page, size, sort, direction and search it was given', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => page })
    vi.stubGlobal('fetch', fetchMock)

    await fetchMerchantOrders('m1', { page: 3, pageSize: 15, sort: 'total', dir: 'asc', search: ' ah meng ' })

    const url = new URL(fetchMock.mock.calls[0][0], 'http://x')
    expect(url.searchParams.get('page')).toBe('3')
    expect(url.searchParams.get('pageSize')).toBe('15')
    expect(url.searchParams.get('sort')).toBe('total')
    expect(url.searchParams.get('dir')).toBe('asc')
    expect(url.searchParams.get('search')).toBe('ah meng')
  })

  it('omits a blank search rather than asking for the empty string', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => page })
    vi.stubGlobal('fetch', fetchMock)

    await fetchMerchantOrders('m1', { search: '   ' })
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/orders$/)
  })

  it('returns { ok:false } on a failed request', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }))
    expect((await fetchMerchantOrders('m1')).ok).toBe(false)
  })
})

// ── fetchOrderCount (#144: the badge stops measuring a list it was handed) ─────

describe('fetchOrderCount', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs the count endpoint and unwraps the number', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ count: 1234 }) })
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchOrderCount('m1')).toEqual({ ok: true, data: 1234 })
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/merchants\/m1\/orders\/count$/)
  })

  it('passes a status through so Postgres does the filtering', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ count: 3 }) })
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchOrderCount('m1', 'new')).toEqual({ ok: true, data: 3 })
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/orders\/count\?status=new$/)
  })

  it('returns 0 without asking for a falsy merchantId', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchOrderCount('')).toEqual({ ok: true, data: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
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
    expect(result).toEqual({ ok: true, data: rows })
  })

  it('states the history cap shown on screen ("your last 20 orders")', () => {
    expect(ORDER_HISTORY_LIMIT).toBe(20)
  })

  it('queries nothing when signed out — a guest has no history to read', async () => {
    __mocks.getUser.mockResolvedValueOnce({ data: { user: null } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMyOrdersAtShop('m1')).toEqual({ ok: true, data: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('queries nothing without a shop', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMyOrdersAtShop('')).toEqual({ ok: true, data: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns { ok:false } on a non-ok response instead of passing an empty list off as "no orders"', async () => {
    // The screen renders an empty list as "You haven't ordered from this shop yet." Collapsing the
    // failure to [] here would tell a customer with a year of history that they have none — and they
    // would believe it. An empty history and a broken query must not look alike: { ok:false } is the
    // could-not-ask the screen turns into its 'failed' state.
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'rls' }) }))
    expect((await fetchMyOrdersAtShop('m1')).ok).toBe(false)
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

  it('never throws on a rejected fetch — returns { ok:false } for the caller to ignore', async () => {
    __mocks.getUser.mockResolvedValueOnce({ data: { user } })
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')))

    const r = await saveCustomerDetails({ whatsapp: '60123456789' })
    expect(r.ok).toBe(false)
  })

  it('resolves { ok:true } for a guest and an empty patch without reaching the network', async () => {
    __mocks.getUser.mockResolvedValueOnce({ data: { user: null } })
    vi.stubGlobal('fetch', vi.fn())
    expect(await saveCustomerDetails({ whatsapp: '6012' })).toEqual({ ok: true, data: undefined })
    expect(await saveCustomerDetails({})).toEqual({ ok: true, data: undefined })
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

// ── setOrderStatus / setOrderNote / setOrderTracking (Task 7) ──────────────────
// All three now PATCH /api/merchants/:merchantId/orders/:orderId instead of writing to
// `orders` directly — the browser has no UPDATE grant on the table anymore. The client-side
// ORDER_STATUSES guard in setOrderStatus stays (fails fast without a round trip), but is not a
// security boundary — the backend re-validates (writes-orders.test.ts).

describe('setOrderStatus', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns { ok:false, code:invalid_status } for unknown status without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await setOrderStatus('ord-1', 'shipped', 'm1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_status')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('PATCHes /api/merchants/:merchantId/orders/:orderId with { status } and a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'ord-1', status: 'preparing' }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => row, text: async () => JSON.stringify(row),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await setOrderStatus('ord-1', 'preparing', 'm1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/orders\/ord-1$/)
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ status: 'preparing' })
    expect(result).toEqual({ ok: true, data: row })
  })

  it('accepts all six valid statuses: pending_payment, new, preparing, ready, completed, cancelled', async () => {
    for (const status of ['pending_payment', 'new', 'preparing', 'ready', 'completed', 'cancelled']) {
      __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
      const row = { id: 'ord-1', status }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        ok: true, json: async () => row, text: async () => JSON.stringify(row),
      }))
      const result = await setOrderStatus('ord-1', status, 'm1')
      expect(result.ok && result.data.status).toBe(status)
      vi.unstubAllGlobals()
    }
  })

  it('returns { ok:false } on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'Update failed' }),
    }))
    expect((await setOrderStatus('ord-1', 'ready', 'm1')).ok).toBe(false)
  })
})

describe('setOrderNote', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PATCHes /api/merchants/:merchantId/orders/:orderId with { note } and a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'ord-1', note: 'leave at the door' }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => row, text: async () => JSON.stringify(row),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await setOrderNote('ord-1', 'leave at the door', 'm1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/orders\/ord-1$/)
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ note: 'leave at the door' })
    expect(result).toEqual({ ok: true, data: row })
  })

  it('returns { ok:false } on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'Update failed' }),
    }))
    expect((await setOrderNote('ord-1', 'x', 'm1')).ok).toBe(false)
  })
})

describe('setOrderTracking', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PATCHes /api/merchants/:merchantId/orders/:orderId with { courier, awb } and a bearer token', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'ord-1', courier: 'jnt', awb: 'AWB123' }
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => row, text: async () => JSON.stringify(row),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await setOrderTracking('ord-1', 'jnt', 'AWB123', 'm1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/orders\/ord-1$/)
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ courier: 'jnt', awb: 'AWB123' })
    expect(result).toEqual({ ok: true, data: row })
  })

  it('returns { ok:false } on a non-2xx response', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'Update failed' }),
    }))
    expect((await setOrderTracking('ord-1', null, 'x', 'm1')).ok).toBe(false)
  })
})

// ── fetchShopCustomers ────────────────────────────────────────────────────────
//
// The grouping this used to do in the browser is gone (#143): it keyed on the raw
// customer_wa string, fell back to the customer NAME, and counted cancelled orders — the
// tests that lived here asserted all three. The rules now live in the backend's pure
// shopCustomers module and are tested there, exhaustively, without a database.
//
// What is left for this seam is the only thing it still decides: which request to send.

describe('fetchShopCustomers', () => {
  afterEach(() => vi.unstubAllGlobals())

  const page = {
    customers: [], shopTags: [], stats: { customers: 0, bookedOrders: 0, spend: 0 }, total: 0, unattributedOrders: 0,
  }

  function stubFetch() {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => page })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('asks for the plain list when given no options', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = stubFetch()

    await fetchShopCustomers('m1')

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/merchants\/m1\/customers$/)
  })

  it('carries sort, segment, tag, search and paging as query params', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = stubFetch()

    await fetchShopCustomers('m1', { sort: 'spend', segment: 'members', tag: 'vip', search: 'ali', page: 2, pageSize: 25 })

    const url = new URL(fetchMock.mock.calls[0][0] as string, 'http://x')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sort: 'spend', segment: 'members', tag: 'vip', search: 'ali', page: '2', pageSize: '25',
    })
  })

  it('drops a blank search rather than asking the server to match nothing', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = stubFetch()

    await fetchShopCustomers('m1', { search: '   ' })

    expect(fetchMock.mock.calls[0][0]).not.toContain('search=')
  })

  it('answers an empty page without asking, when there is no shop to ask about', async () => {
    const fetchMock = stubFetch()

    expect(await fetchShopCustomers('')).toEqual({ ok: true, data: page })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a failed request rather than an empty shop', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'Lookup failed' }),
    }))

    expect((await fetchShopCustomers('m1')).ok).toBe(false)
  })
})

// ── Multi-tenant vouchers ─────────────────────────────────────────────────────

describe('voucherFromRow', () => {
  it('maps table columns onto the Voucher shape', () => {
    expect(voucherFromRow({
      id: 'v1', code: 'SAVE10', kind: 'percent', amount: '10',
      max_uses: 50, used_by: ['a@x.com'],
      per_customer_limit: 3, expires_at: '2026-08-31T15:59:59.999Z', expires_on: '2026-08-31', min_order: '50',
    })).toEqual({
      id: 'v1', code: 'SAVE10', type: 'percent', value: 10,
      maxUses: 50, usedBy: ['a@x.com'], active: true,
      perCustomerLimit: 3, expiresAt: '2026-08-31T15:59:59.999Z',
      // The date the merchant typed, derived by the server. Never a slice of the instant above:
      // east of UTC that instant lands on the previous calendar day.
      expiresOn: '2026-08-31',
      // COERCED. postgres.js hands a numeric column back as a string and PostgREST as a number;
      // `'50' < 40` is false, so an uncoerced minimum silently stops refusing.
      minOrder: 50,
    })
  })
  it('defaults usedBy to an empty array and tolerates null max_uses', () => {
    const v = voucherFromRow({ id: 'v2', code: 'X', kind: 'fixed', amount: 5, max_uses: null, used_by: null })
    expect(v.usedBy).toEqual([])
    expect(v.maxUses).toBeNull()
  })

  // Only an explicit `false` means deactivated. A row selected without the column — an older
  // query, a cached payload — must not be rendered as a dead voucher the merchant never killed.
  it('treats a missing active column as active', () => {
    expect(voucherFromRow({ code: 'A', kind: 'fixed', amount: 5 }).active).toBe(true)
    expect(voucherFromRow({ code: 'A', kind: 'fixed', amount: 5, active: false }).active).toBe(false)
  })
})

describe('fetchMerchantVouchers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns { ok:true, data:[] } for a missing merchantId without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMerchantVouchers('')).toEqual({ ok: true, data: [] })
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
    expect(result).toEqual({ ok: true, data: [{
      id: 'v1', code: 'A', type: 'fixed', value: 5, maxUses: null, usedBy: [], active: true,
      perCustomerLimit: null, expiresAt: null, expiresOn: null, minOrder: null,
    }] })
  })
  it('returns { ok:false } on a failed request', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }))
    expect((await fetchMerchantVouchers('m1')).ok).toBe(false)
  })
})

// `lookupMerchantVoucher` carries the same "could not ask" vs "the answer is empty" contract as
// `lookupProducts`, now as the shared Result: a 200 with a null body is a real answer
// (`{ ok:true, data:null }` — the shop has no such voucher), while a failed request comes back
// as `{ ok:false }`, never collapsed onto "no voucher".
describe('lookupMerchantVoucher', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns { ok:true, data:null } immediately when merchantId or code is falsy, without hitting the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupMerchantVoucher('', 'CODE')).toEqual({ ok: true, data: null })
    expect(await lookupMerchantVoucher('m1', '')).toEqual({ ok: true, data: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The route is auth-OPTIONAL, and both halves matter. Signed in, it needs the token to answer
  // `already_used` from the caller's own verified email; signed out, it must still answer at all,
  // because a customer has to see what a code is worth before being asked to sign in for it.
  it('attaches a bearer token when there is a session, and maps a found row', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'v1', code: 'A', kind: 'fixed', amount: 5, fully_used: false, customer_limit_reached: true, used_count: 1 }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row })
    vi.stubGlobal('fetch', fetchMock)

    const result = await lookupMerchantVoucher('m1', 'A')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/vouchers\/A$/)
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(result).toEqual({ ok: true, data: {
      id: 'v1', code: 'A', type: 'fixed', value: 5, maxUses: null, usedBy: [], active: true,
      fullyUsed: false, customerLimitReached: true, usedCount: 1,
      perCustomerLimit: null, expiresAt: null, expiresOn: null, minOrder: null,
    } })
  })

  it('still asks, unauthenticated, when there is no session', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    const row = { id: 'v1', code: 'A', kind: 'fixed', amount: 5, fully_used: false }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row })
    vi.stubGlobal('fetch', fetchMock)

    const result = await lookupMerchantVoucher('m1', 'A')

    expect(fetchMock.mock.calls[0][1].headers).toEqual({})
    // `customerLimitReached` is ABSENT, not false: the server was not asked, and the customer has not
    // been told "no".
    expect(result.ok && result.data?.customerLimitReached).toBeUndefined()
  })

  // The redeemer list is a list of ACCOUNT EMAIL ADDRESSES and the route is public — a voucher
  // code is printed on flyers. The server strips it (apps/backend/src/voucherView.ts); this pins
  // that the browser reads the derived flags and does not depend on getting the keys back.
  it('does not need used_by to know the voucher is spent', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    const row = { id: 'v1', code: 'A', kind: 'fixed', amount: 5, max_uses: 2, fully_used: true, used_count: 2 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row }))

    const result = await lookupMerchantVoucher('m1', 'A')

    expect(result.ok && result.data?.usedBy).toEqual([])
    expect(result.ok && voucherFullyUsed(result.data!)).toBe(true)
  })

  it('returns { ok:true, data:null } on a 200 with a null body (the real answer: no such voucher)', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => null }))
    expect(await lookupMerchantVoucher('m1', 'MISSING')).toEqual({ ok: true, data: null })
  })

  it('returns { ok:false } on a failed request — could not ask', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: null } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }))
    expect((await lookupMerchantVoucher('m1', 'A')).ok).toBe(false)
  })
})

// `redeemVoucher` is gone on purpose and has no tests to replace it. It was a second call
// made AFTER the order was already committed, which is what let a failed redemption leave the
// customer with a discount on a voucher that was never marked used. The claim now happens
// inside placeOrder's transaction, and is proven against a real Postgres — including under
// concurrent redemption — in apps/backend/tests/api/orders.test.ts.

// ── createMerchantVoucher / updateMerchantVoucher / setMerchantVoucherActive ─────

describe('createMerchantVoucher', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs /api/merchants/:merchantId/vouchers with a bearer token and maps the row back', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'v9', code: 'SAVE10', kind: 'percent', amount: 10, max_uses: 100, used_by: [] }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row, text: async () => JSON.stringify(row) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createMerchantVoucher({ merchantId: 'm1', code: 'save10', kind: 'percent', amount: 10, maxUses: 100 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/vouchers$/)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok')
    // code is sent as-typed — uppercasing/trimming happens server-side now.
    expect(JSON.parse(init.body)).toEqual({
      code: 'save10', kind: 'percent', amount: 10, maxUses: 100,
      perCustomerLimit: 1, expiresOn: null, minOrder: null,
    })
    expect(result).toEqual({ ok: true, data: {
      id: 'v9', code: 'SAVE10', type: 'percent', value: 10, maxUses: 100, usedBy: [], active: true,
      perCustomerLimit: null, expiresAt: null, expiresOn: null, minOrder: null,
    } })
  })

  it('defaults maxUses to null, and per-customer to ONE each', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'v10', code: 'X', kind: 'fixed', amount: 5, max_uses: null, used_by: [] }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row, text: async () => JSON.stringify(row) })
    vi.stubGlobal('fetch', fetchMock)

    await createMerchantVoucher({ merchantId: 'm1', code: 'X', kind: 'fixed', amount: 5 })

    const [, init] = fetchMock.mock.calls[0]
    // An OMITTED per-customer limit is one each, never null. Null means unlimited, which is the
    // value that costs the merchant money, so it has to be said out loud rather than defaulted to.
    expect(JSON.parse(init.body)).toEqual({
      code: 'X', kind: 'fixed', amount: 5, maxUses: null,
      perCustomerLimit: 1, expiresOn: null, minOrder: null,
    })
  })

  it('sends the restrictions the form collected, and a DATE for the expiry', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'v11', code: 'X', kind: 'percent', amount: 10, max_uses: 100, used_by: [] }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row, text: async () => JSON.stringify(row) })
    vi.stubGlobal('fetch', fetchMock)

    await createMerchantVoucher({
      merchantId: 'm1', code: 'X', kind: 'percent', amount: 10, maxUses: 100,
      perCustomerLimit: null, expiresOn: '2026-08-31', minOrder: 50,
    })

    // A DATE, not an instant. Which moment the merchant's chosen day ENDS depends on the shop's
    // timezone, and the browser must not be the one to decide that.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      code: 'X', kind: 'percent', amount: 10, maxUses: 100,
      perCustomerLimit: null, expiresOn: '2026-08-31', minOrder: 50,
    })
  })

  it('returns { ok:false, error } on a non-2xx response, carrying the backend message', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'duplicate' }) }))
    const r = await createMerchantVoucher({ merchantId: 'm1', code: 'X', kind: 'fixed', amount: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('duplicate')
  })
})

describe('updateMerchantVoucher', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PATCHes the rules and the switch, never a code, and maps the row back', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'v9', code: 'SAVE10', kind: 'fixed', amount: 5, max_uses: null, active: false }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row, text: async () => JSON.stringify(row) })
    vi.stubGlobal('fetch', fetchMock)

    const r = await updateMerchantVoucher('v9', 'm1', { kind: 'fixed', amount: 5, perCustomerLimit: null, maxUses: 40, active: false })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/vouchers\/v9$/)
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({
      kind: 'fixed', amount: 5, maxUses: 40, perCustomerLimit: null, expiresOn: null, minOrder: null, active: false,
    })
    expect(r.ok && r.data.active).toBe(false)
  })

  it('omits the switch when the caller did not say', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'v9', code: 'X' }), text: async () => '{}' })
    vi.stubGlobal('fetch', fetchMock)
    await updateMerchantVoucher('v9', 'm1', { kind: 'percent', amount: 10 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('active')
  })
})

describe('setMerchantVoucherActive', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PATCHes { active } alone — the list must not have to know the rules to flip a switch', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    const row = { id: 'v9', code: 'SAVE10', kind: 'percent', amount: 10, active: true }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => row, text: async () => JSON.stringify(row) })
    vi.stubGlobal('fetch', fetchMock)

    const r = await setMerchantVoucherActive('v9', 'm1', true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/merchants\/m1\/vouchers\/v9$/)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ active: true })
    expect(r.ok && r.data.active).toBe(true)
  })

  it('surfaces the reactivation collision as its code', async () => {
    __mocks.getSession.mockResolvedValueOnce({ data: { session: { access_token: 'tok' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'duplicate_code' }) }))
    const r = await setMerchantVoucherActive('v9', 'm1', true)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('duplicate_code')
  })
})

describe('quoteDelivery', () => {
  afterEach(() => vi.unstubAllGlobals())

  const refuses = (error: string) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error }) }))

  const quoteCode = async () => {
    const r = await quoteDelivery('m1', 'place-1')
    return r.ok ? null : r.error.code
  }

  it('returns { ok:true, data } with the km + fee on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ km: 3.2, fee: 6 }) }))
    expect(await quoteDelivery('m1', 'place-1')).toEqual({ ok: true, data: { km: 3.2, fee: 6 } })
  })

  it('passes a quota refusal through instead of calling it a lookup failure', async () => {
    // The narrowing this replaces mapped `quota_exceeded` onto `lookup_failed`, and the customer
    // was told to try again for a ceiling that does not clear for up to 24 hours.
    refuses('quota_exceeded')
    expect(await quoteCode()).toBe('quota_exceeded')
  })

  it('passes a closed shop through as a closed shop', async () => {
    refuses('merchant_inactive')
    expect(await quoteCode()).toBe('merchant_inactive')
  })

  it('still reports an unrecognised body as a lookup failure', async () => {
    refuses('something_new')
    expect(await quoteCode()).toBe('lookup_failed')
  })
})
