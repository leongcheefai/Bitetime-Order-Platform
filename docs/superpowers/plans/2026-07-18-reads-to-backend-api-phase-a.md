# Move Reads to Backend API — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every browser→Postgres *read* behind the Hono backend API, gated by shared auth middleware, with the frontend `store.ts` seam preserved.

**Architecture:** New Hono middleware (`requireUser` / `requireSuperadmin` / `requireMerchantOwns`) resolves caller identity and tenancy once against the service-role `admin` client. Thirteen `GET` endpoints replace the direct `supabase.from(...)` reads. On the frontend, a new `src/api.ts` centralizes the fetch contract and each `store.ts` read function swaps its body — signature and return contract unchanged. One migration revokes `SELECT` on `merchant_billing` (the sole read-only table). RLS stays as the backstop.

**Tech Stack:** Hono, `@supabase/supabase-js` (service-role `admin` client), Vitest in-process API tests (`app.request()`), local Supabase, React/Vite frontend.

## Global Constraints

- Backend uses `NodeNext` module resolution: **relative imports keep `.js` specifiers** that resolve to the `.ts` source (e.g. `import { admin } from './supabase.js'`).
- All backend Postgres access in this phase goes through the service-role `admin` client (`apps/backend/src/supabase.ts`) — **RLS-exempt; tenancy is a TypeScript invariant enforced by middleware.**
- Keep `app.ts` free of import-time I/O (no connections, no timers, no reads at import) — the `tests/api` in-process seam depends on it.
- The transitional superadmin check is `profile.app_role === 'superadmin' || user.email === 'bitetime@praxor.dev'` — copy it verbatim; do not "fix" it.
- DB-backed tests are run with `pnpm --filter @bitetime/backend test:db` and require a running local Supabase (`supabase start` in `apps/backend`).
- Pure backend unit tests run with `pnpm --filter @bitetime/backend test`.
- Preserve each `store.ts` function's **exact return contract** — especially the null-vs-"could-not-ask" distinction (see Task 8).
- `ORDER_HISTORY_LIMIT = 20`.

---

## File Structure

**Backend (create):**
- `apps/backend/src/mw.ts` — the three middleware functions + the `AppEnv` type.

**Backend (modify):**
- `apps/backend/src/app.ts` — type the app as `Hono<AppEnv>`; add 13 GET routes.

**Backend (create — tests):**
- `apps/backend/tests/api/reads-admin.test.ts` — superadmin endpoints + `requireSuperadmin`/`requireUser` gates.
- `apps/backend/tests/api/reads-owner.test.ts` — owner endpoints + `requireMerchantOwns` tenant isolation.
- `apps/backend/tests/api/reads-user.test.ts` — user endpoints + `my-orders` uid filter.
- `apps/backend/tests/api/reads-public.test.ts` — public endpoints + by-slug shaping + null contracts.

**Backend (create — migration + test):**
- `apps/backend/supabase/migrations/20260718120000_revoke_billing_select.sql`
- add a case to `apps/backend/tests/rls/` asserting anon/authenticated `SELECT` on `merchant_billing` is denied.

**Frontend (create):**
- `apps/frontend/src/api.ts` — `API_URL`, `apiGet`, `apiTry`.

**Frontend (modify):**
- `apps/frontend/src/store.ts` — rewrite the 13 read functions to call the API; delete the local `API_URL` const (line 236) and re-export from `api.ts`.

---

## Task 1: Middleware foundation + superadmin read endpoints

**Files:**
- Create: `apps/backend/src/mw.ts`
- Modify: `apps/backend/src/app.ts:33` (app generic), and add routes
- Test: `apps/backend/tests/api/reads-admin.test.ts`

**Interfaces:**
- Produces: `AppEnv` type; `requireUser`, `requireSuperadmin`, `requireMerchantOwns` middleware (all consumed by later tasks). `GET /api/merchants` → `MerchantRow[]`; `GET /api/billing` → `MerchantBilling[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/api/reads-admin.test.ts`:

```ts
// tests/api/reads-admin.test.ts
// Superadmin read endpoints, driven in-process. Proves the requireUser + requireSuperadmin
// gate: no token → 401, ordinary user → 403, superadmin → 200 with rows. admin uses the
// service-role client, so these gates are the ONLY thing standing between a merchant and
// every shop's billing — load-bearing, not decoration.
import { describe, it, expect, beforeAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return data.session!.access_token
}

function get(path: string, token?: string) {
  return app.request(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

describe('superadmin reads', () => {
  let superToken: string
  let plainToken: string

  beforeAll(async () => {
    const superClient = await makeUser('super-reads@example.com', 'password123')
    const { data: sess } = await superClient.auth.getSession()
    const superUserId = sess.session!.user.id
    // Grant superadmin via a global profile row.
    const svc = serviceClient()
    await svc.from('profiles').delete().eq('user_id', superUserId)
    await svc.from('profiles').insert({ user_id: superUserId, name: 'Super', app_role: 'superadmin' })
    superToken = await tokenOf(superClient)

    const plainClient = await makeUser('plain-reads@example.com', 'password123')
    const { data: psess } = await plainClient.auth.getSession()
    await seedMerchant({ slug: 'admin-read-shop', owner_id: psess.session!.user.id })
    plainToken = await tokenOf(plainClient)
  })

  it('rejects an anonymous caller with 401', async () => {
    expect((await get('/api/merchants')).status).toBe(401)
    expect((await get('/api/billing')).status).toBe(401)
  })

  it('rejects a non-superadmin with 403', async () => {
    expect((await get('/api/merchants', plainToken)).status).toBe(403)
    expect((await get('/api/billing', plainToken)).status).toBe(403)
  })

  it('returns all merchants to a superadmin', async () => {
    const res = await get('/api/merchants', superToken)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ slug: string }>
    expect(rows.some(m => m.slug === 'admin-read-shop')).toBe(true)
  })

  it('returns billing rows to a superadmin', async () => {
    const res = await get('/api/billing', superToken)
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bitetime/backend test:db reads-admin`
Expected: FAIL — routes return 404 (not yet defined).

- [ ] **Step 3: Create the middleware**

Create `apps/backend/src/mw.ts`:

```ts
// Shared auth/tenant middleware. Resolves caller identity (and, for owner routes, the
// owned merchant) once against the service-role `admin` client, then stashes it on the
// context. admin is RLS-EXEMPT, so these functions ARE the tenant boundary on the backend
// path — nothing downstream re-checks. See CLAUDE.md → Backend.
import type { MiddlewareHandler } from 'hono'
import { admin, getUserFromToken } from './supabase.js'

type AuthedUser = NonNullable<Awaited<ReturnType<typeof getUserFromToken>>>

export type AppEnv = {
  Variables: {
    user: AuthedUser
    merchant: Record<string, any>
  }
}

function bearer(c: Parameters<MiddlewareHandler>[0]): string {
  return (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
}

// TODO(P3): drop the email fallback once the superadmin role is seeded everywhere.
async function isSuperadmin(user: AuthedUser): Promise<boolean> {
  const { data } = await admin.from('profiles').select('app_role').eq('user_id', user.id).maybeSingle()
  return data?.app_role === 'superadmin' || user.email === 'bitetime@praxor.dev'
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getUserFromToken(bearer(c))
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  c.set('user', user)
  await next()
}

export const requireSuperadmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getUserFromToken(bearer(c))
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  if (!(await isSuperadmin(user))) return c.json({ error: 'Forbidden' }, 403)
  c.set('user', user)
  await next()
}

// For routes carrying `:id`. Loads the merchant, then requires the caller to own it —
// unless they are a superadmin, who passes any tenant guard (mirrors RequireRole in the app).
export const requireMerchantOwns: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getUserFromToken(bearer(c))
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'Missing merchant id' }, 400)
  const { data: merchant } = await admin.from('merchants').select('*').eq('id', id).maybeSingle()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)
  if (merchant.owner_id !== user.id && !(await isSuperadmin(user))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  c.set('user', user)
  c.set('merchant', merchant)
  await next()
}
```

- [ ] **Step 4: Type the app and add the superadmin routes**

In `apps/backend/src/app.ts`, change line 33:

```ts
export const app = new Hono()
```
to:
```ts
export const app = new Hono<AppEnv>()
```

Add to the imports block (after the `supabase.js` import on line 16):

```ts
import { requireUser, requireSuperadmin, requireMerchantOwns, type AppEnv } from './mw.js'
```

Add these routes (place after the existing `/api/pricing` route, before `/api/checkout`):

```ts
// ── Superadmin reads ──────────────────────────────────────────────────────────
app.get('/api/merchants', requireSuperadmin, async (c) => {
  const { data, error } = await admin
    .from('merchants').select('*').order('created_at', { ascending: false })
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

app.get('/api/billing', requireSuperadmin, async (c) => {
  const { data, error } = await admin.from('merchant_billing').select('*')
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @bitetime/backend test:db reads-admin`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @bitetime/backend typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/mw.ts apps/backend/src/app.ts apps/backend/tests/api/reads-admin.test.ts
git commit -m "feat(backend): auth middleware + superadmin read endpoints"
```

---

## Task 2: Owner-scoped read endpoints

**Files:**
- Modify: `apps/backend/src/app.ts` (add routes)
- Test: `apps/backend/tests/api/reads-owner.test.ts`

**Interfaces:**
- Consumes: `requireMerchantOwns`, `admin` from Task 1.
- Produces: `GET /api/merchants/:id/orders` → `Order[]`; `GET /api/merchants/:id/orders/count` → `{ count: number }`; `GET /api/merchants/:id/vouchers` → `VoucherRow[]`; `GET /api/merchants/:id/billing` → `MerchantBilling | null`; `GET /api/merchants/:id/secret` → `{ tg_token, tg_chat_id } | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/api/reads-owner.test.ts`:

```ts
// tests/api/reads-owner.test.ts
// Owner-scoped reads. The load-bearing assertion is TENANT ISOLATION: merchant A, with a
// perfectly valid token, gets 403 on merchant B's orders/vouchers/billing/secret. admin is
// RLS-exempt, so requireMerchantOwns is the only thing enforcing this.
import { describe, it, expect, beforeAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, seedProduct, serviceClient } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return data.session!.access_token
}
function get(path: string, token?: string) {
  return app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

describe('owner reads', () => {
  let aToken: string, bToken: string, aId: string

  beforeAll(async () => {
    const a = await makeUser('owner-a@example.com', 'password123')
    const b = await makeUser('owner-b@example.com', 'password123')
    const { data: as } = await a.auth.getSession()
    const { data: bs } = await b.auth.getSession()
    aId = await seedMerchant({ slug: 'owner-a-shop', owner_id: as.session!.user.id })
    await seedMerchant({ slug: 'owner-b-shop', owner_id: bs.session!.user.id })
    aToken = await tokenOf(a)
    bToken = await tokenOf(b)
    // Give shop A one voucher so its list is non-empty.
    await serviceClient().from('vouchers').insert({ merchant_id: aId, code: 'OWNERTEST', kind: 'flat', amount: 5 })
  })

  it('lets the owner read their orders, count, vouchers, billing, secret', async () => {
    for (const path of [
      `/api/merchants/${aId}/orders`,
      `/api/merchants/${aId}/orders/count`,
      `/api/merchants/${aId}/vouchers`,
      `/api/merchants/${aId}/billing`,
      `/api/merchants/${aId}/secret`,
    ]) {
      expect((await get(path, aToken)).status).toBe(200)
    }
  })

  it('returns the count as { count }', async () => {
    const res = await get(`/api/merchants/${aId}/orders/count`, aToken)
    expect(await res.json()).toEqual({ count: 0 })
  })

  it("forbids a different merchant from reading shop A's rows", async () => {
    for (const path of [
      `/api/merchants/${aId}/orders`,
      `/api/merchants/${aId}/vouchers`,
      `/api/merchants/${aId}/billing`,
      `/api/merchants/${aId}/secret`,
    ]) {
      expect((await get(path, bToken)).status).toBe(403)
    }
  })

  it('rejects an anonymous caller with 401', async () => {
    expect((await get(`/api/merchants/${aId}/orders`)).status).toBe(401)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bitetime/backend test:db reads-owner`
Expected: FAIL — routes 404.

- [ ] **Step 3: Add the owner routes**

Add to `apps/backend/src/app.ts` (after the superadmin routes from Task 1):

```ts
// ── Owner-scoped reads (tenant enforced by requireMerchantOwns) ────────────────
app.get('/api/merchants/:id/orders', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin
    .from('orders').select('*').eq('merchant_id', m.id).order('created_at', { ascending: false })
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

app.get('/api/merchants/:id/orders/count', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { count, error } = await admin
    .from('orders').select('id', { count: 'exact', head: true }).eq('merchant_id', m.id)
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json({ count: count ?? 0 })
})

app.get('/api/merchants/:id/vouchers', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin.from('vouchers').select('*').eq('merchant_id', m.id)
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

app.get('/api/merchants/:id/billing', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin
    .from('merchant_billing').select('*').eq('merchant_id', m.id).maybeSingle()
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? null)
})

app.get('/api/merchants/:id/secret', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin
    .from('merchant_secrets').select('tg_token, tg_chat_id').eq('merchant_id', m.id).maybeSingle()
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? null)
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bitetime/backend test:db reads-owner`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/app.ts apps/backend/tests/api/reads-owner.test.ts
git commit -m "feat(backend): owner-scoped read endpoints"
```

---

## Task 3: User-scoped read endpoints

**Files:**
- Modify: `apps/backend/src/app.ts` (add routes + `ORDER_HISTORY_LIMIT` const)
- Test: `apps/backend/tests/api/reads-user.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `admin` from Task 1.
- Produces: `GET /api/me/profile` → profile row or `null`; `GET /api/me/merchant` → merchant row or `null`; `GET /api/merchants/:id/my-orders` → `Order[]` (filtered to the caller's uid).

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/api/reads-user.test.ts`:

```ts
// tests/api/reads-user.test.ts
// User-scoped reads. The load-bearing assertion is the uid filter on my-orders: the merchant's
// own select policy would hand a shop owner EVERY customer's order, so "your orders" only means
// yours because the endpoint filters by the caller's uid — proven here with two customers.
import { describe, it, expect, beforeAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return data.session!.access_token
}
function get(path: string, token?: string) {
  return app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

describe('user reads', () => {
  let custAToken: string, custBToken: string, custAId: string, shopId: string

  beforeAll(async () => {
    const owner = await makeUser('user-owner@example.com', 'password123')
    const { data: os } = await owner.auth.getSession()
    shopId = await seedMerchant({ slug: 'user-shop', owner_id: os.session!.user.id, order_prefix: 'US' })

    const a = await makeUser('cust-a@example.com', 'password123')
    const b = await makeUser('cust-b@example.com', 'password123')
    const { data: as } = await a.auth.getSession()
    const { data: bs } = await b.auth.getSession()
    custAId = as.session!.user.id
    custAToken = await tokenOf(a)
    custBToken = await tokenOf(b)

    // Two orders at the shop: one for A, one for B.
    const svc = serviceClient()
    await svc.from('orders').insert([
      { merchant_id: shopId, user_id: custAId, order_number: 'US-260718-0050', status: 'new', customer_name: 'A' },
      { merchant_id: shopId, user_id: bs.session!.user.id, order_number: 'US-260718-0051', status: 'new', customer_name: 'B' },
    ])
  })

  it('rejects an anonymous caller with 401 on me/profile', async () => {
    expect((await get('/api/me/profile')).status).toBe(401)
  })

  it('returns only the caller\'s own orders at the shop', async () => {
    const res = await get(`/api/merchants/${shopId}/my-orders`, custAToken)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ user_id: string }>
    expect(rows.length).toBe(1)
    expect(rows[0].user_id).toBe(custAId)
  })

  it('returns a different set for a different customer', async () => {
    const res = await get(`/api/merchants/${shopId}/my-orders`, custBToken)
    const rows = (await res.json()) as Array<{ customer_name: string }>
    expect(rows.length).toBe(1)
    expect(rows[0].customer_name).toBe('B')
  })

  it('returns the owner\'s merchant from me/merchant', async () => {
    const owner = await makeUser('user-owner2@example.com', 'password123')
    const { data: os } = await owner.auth.getSession()
    await seedMerchant({ slug: 'user-shop2', owner_id: os.session!.user.id })
    const res = await get('/api/me/merchant', await tokenOf(owner))
    expect(res.status).toBe(200)
    expect((await res.json() as { slug: string }).slug).toBe('user-shop2')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bitetime/backend test:db reads-user`
Expected: FAIL — routes 404.

- [ ] **Step 3: Add the user routes**

In `apps/backend/src/app.ts`, add a const near the top of the routes (after line 35's `app.use`):

```ts
const ORDER_HISTORY_LIMIT = 20
```

Add the routes (after the owner routes from Task 2):

```ts
// ── User-scoped reads ─────────────────────────────────────────────────────────
app.get('/api/me/profile', requireUser, async (c) => {
  const user = c.get('user')
  const { data } = await admin
    .from('profiles')
    .select('id, name, email, app_role, merchant_id, whatsapp, delivery_address')
    .eq('user_id', user.id).is('merchant_id', null).maybeSingle()
  return c.json(data ?? null)
})

app.get('/api/me/merchant', requireUser, async (c) => {
  const user = c.get('user')
  const { data } = await admin.from('merchants').select('*').eq('owner_id', user.id).maybeSingle()
  return c.json(data ?? null)
})

// Any signed-in customer's own history at a shop. NOT requireMerchantOwns — the uid filter,
// not merchant ownership, is what scopes it. A guest (no token) is 401 and has no history.
app.get('/api/merchants/:id/my-orders', requireUser, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const { data, error } = await admin
    .from('orders').select('*')
    .eq('merchant_id', id).eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(ORDER_HISTORY_LIMIT)
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bitetime/backend test:db reads-user`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/app.ts apps/backend/tests/api/reads-user.test.ts
git commit -m "feat(backend): user-scoped read endpoints"
```

---

## Task 4: Public read endpoints

**Files:**
- Modify: `apps/backend/src/app.ts` (add routes)
- Test: `apps/backend/tests/api/reads-public.test.ts`

**Interfaces:**
- Consumes: `admin` from Task 1.
- Produces: `GET /api/merchants/:slug` → public merchant shape (no `owner_id`/`referred_by_code`) or `null`; `GET /api/merchants/:id/products` → `Product[]`; `GET /api/merchants/:id/vouchers/:code` → voucher row or `null`.

**Note on routing:** `/api/merchants/:slug` (one segment) never collides with `/api/merchants/:id/orders` (two segments) or `/api/merchants` (exact). `/api/merchants/:id/vouchers/:code` (public, three segments) is distinct from `/api/merchants/:id/vouchers` (owner, two segments).

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/api/reads-public.test.ts`:

```ts
// tests/api/reads-public.test.ts
// Public (tokenless) reads for the storefront. Two things are load-bearing: the by-slug shape
// must NOT leak owner_id/referred_by_code, and the endpoints must return a clean 200 (so the
// client can tell "shop has none" from "could not ask" — the 5xx path is the client's null).
import { describe, it, expect, beforeAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, seedProduct, serviceClient } from '../rls/helpers.js'

function get(path: string) {
  return app.request(path)
}

describe('public reads', () => {
  let shopId: string

  beforeAll(async () => {
    const owner = await makeUser('pub-owner@example.com', 'password123')
    const { data: os } = await owner.auth.getSession()
    shopId = await seedMerchant({ slug: 'pub-shop', owner_id: os.session!.user.id })
    await seedProduct({ merchant_id: shopId, name: 'Latte', price: 12 })
    await serviceClient().from('vouchers').insert({ merchant_id: shopId, code: 'PUBTEN', kind: 'flat', amount: 10 })
  })

  it('returns a merchant by slug without owner_id or referred_by_code', async () => {
    const res = await get('/api/merchants/pub-shop')
    expect(res.status).toBe(200)
    const m = (await res.json()) as Record<string, unknown>
    expect(m.slug).toBe('pub-shop')
    expect(m).not.toHaveProperty('owner_id')
    expect(m).not.toHaveProperty('referred_by_code')
  })

  it('returns null (200) for an unknown slug', async () => {
    const res = await get('/api/merchants/no-such-shop')
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  it('returns the shop products', async () => {
    const res = await get(`/api/merchants/${shopId}/products`)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ name: string }>
    expect(rows.some(p => p.name === 'Latte')).toBe(true)
  })

  it('returns a voucher by code, and null for an unknown code', async () => {
    const hit = await get(`/api/merchants/${shopId}/vouchers/PUBTEN`)
    expect(hit.status).toBe(200)
    expect((await hit.json() as { code: string }).code).toBe('PUBTEN')

    const miss = await get(`/api/merchants/${shopId}/vouchers/NOPE`)
    expect(miss.status).toBe(200)
    expect(await miss.json()).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bitetime/backend test:db reads-public`
Expected: FAIL — routes 404.

- [ ] **Step 3: Add the public routes**

Add to `apps/backend/src/app.ts` (after the user routes from Task 3):

```ts
// ── Public reads (no auth — storefront) ───────────────────────────────────────
// Shaped: strip internal columns before returning to an unauthenticated caller.
app.get('/api/merchants/:slug', async (c) => {
  const s = (c.req.param('slug') || '').trim().toLowerCase()
  if (!s) return c.json(null)
  const { data, error } = await admin.from('merchants').select('*').eq('slug', s).maybeSingle()
  if (error || !data) return c.json(null)
  const { owner_id, referred_by_code, ...pub } = data
  return c.json(pub)
})

app.get('/api/merchants/:id/products', async (c) => {
  const id = c.req.param('id')
  const { data, error } = await admin
    .from('products').select('*').eq('merchant_id', id)
    .order('sort', { ascending: true }).order('created_at', { ascending: true })
  // A 5xx here is the client's "could not ask" signal — do NOT return [] on error.
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

app.get('/api/merchants/:id/vouchers/:code', async (c) => {
  const id = c.req.param('id')
  const code = c.req.param('code')
  const { data, error } = await admin
    .from('vouchers').select('*').eq('merchant_id', id).eq('code', code).maybeSingle()
  // Same contract: 5xx = could-not-ask; 200 null = shop has no such voucher.
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? null)
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bitetime/backend test:db reads-public`
Expected: PASS (4 tests).

- [ ] **Step 5: Full backend suite + typecheck**

Run: `pnpm --filter @bitetime/backend test:db && pnpm --filter @bitetime/backend typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/app.ts apps/backend/tests/api/reads-public.test.ts
git commit -m "feat(backend): public storefront read endpoints"
```

---

## Task 5: Frontend API helper

**Files:**
- Create: `apps/frontend/src/api.ts`

**Interfaces:**
- Consumes: `supabase` from `./supabase`.
- Produces: `API_URL: string`; `apiGet<T>(path, opts?): Promise<T>` (throws on any failure); `apiTry<T>(path, opts?): Promise<{ ok: true; data: T } | { ok: false }>` (never throws). `opts` is `{ auth?: boolean }`.

- [ ] **Step 1: Create the helper**

Create `apps/frontend/src/api.ts`:

```ts
// The single seam between the browser and the backend read API. Two shapes, because the
// callers need two different failure contracts:
//
//   apiGet  — throws on any non-2xx or network failure. For reads whose caller treats an
//             error as a hard failure (order history, admin lists).
//   apiTry  — NEVER throws. Returns { ok:false } on any failure, { ok:true, data } on 200.
//             This is the "could not ask" vs "the answer is empty" distinction that
//             lookupProducts / lookupMerchantVoucher depend on. `fetch` REJECTS on a network
//             or CORS failure (unlike supabase-js, which resolved { data:null, error }), so the
//             try/catch here is what turns a rejection back into a sentinel the caller expects.
import { supabase } from './supabase'

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

interface Opts { auth?: boolean }

async function headers(opts?: Opts): Promise<Record<string, string>> {
  if (!opts?.auth) return {}
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

export async function apiGet<T>(path: string, opts?: Opts): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: await headers(opts) })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `Request failed: ${res.status}`)
  }
  return (await res.json()) as T
}

export async function apiTry<T>(
  path: string,
  opts?: Opts,
): Promise<{ ok: true; data: T } | { ok: false }> {
  try {
    const res = await fetch(`${API_URL}${path}`, { headers: await headers(opts) })
    if (!res.ok) return { ok: false }
    return { ok: true, data: (await res.json()) as T }
  } catch {
    return { ok: false }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: no errors (the module is unused so far — that is fine).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/api.ts
git commit -m "feat(frontend): backend read API helper (apiGet/apiTry)"
```

---

## Task 6: Wire simple frontend reads to the API

**Files:**
- Modify: `apps/frontend/src/store.ts` (the reads whose contract is throw-or-simple-fallback, plus the `API_URL` relocation)

**Interfaces:**
- Consumes: `API_URL`, `apiGet`, `apiTry` from `./api`.

This task covers every read EXCEPT the two null-contract-sensitive ones (`lookupProducts`, `lookupMerchantVoucher`) — those are Task 7.

- [ ] **Step 1: Relocate `API_URL`**

In `apps/frontend/src/store.ts`, delete the local declaration at line 236:

```ts
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
```

Add to the import block at the top of the file:

```ts
import { API_URL, apiGet, apiTry } from './api'
```

(The existing `fetch(`${API_URL}/api/...`)` calls for the already-migrated POST endpoints keep working via the imported `API_URL`.)

- [ ] **Step 2: Rewrite the merchant/profile/billing reads**

Replace each function body as follows.

`fetchAllMerchants` (throws on error):
```ts
export async function fetchAllMerchants() {
  return apiGet<any[]>('/api/merchants', { auth: true })
}
```

`fetchMerchantBySlug` (null on error):
```ts
export async function fetchMerchantBySlug(slug: string | undefined) {
  const s = (slug || '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) return null
  const r = await apiTry<any>(`/api/merchants/${encodeURIComponent(s)}`)
  return r.ok ? r.data : null
}
```

`fetchMyMerchant` (null on error). The `userId` argument is kept for call-site compatibility but the endpoint derives identity from the token:
```ts
export async function fetchMyMerchant(userId: string) {
  if (!userId) return null
  const r = await apiTry<any>('/api/me/merchant', { auth: true })
  return r.ok ? r.data : null
}
```

`fetchProfileByUserId` (null on error; `userId` kept for compatibility, identity from token):
```ts
export async function fetchProfileByUserId(userId: string) {
  const r = await apiTry<any>('/api/me/profile', { auth: true })
  return r.ok ? r.data : null
}
```

`fetchAllBilling` (throws on error):
```ts
export async function fetchAllBilling(): Promise<MerchantBilling[]> {
  return apiGet<MerchantBilling[]>('/api/billing', { auth: true })
}
```

`fetchMyBilling` (null on error):
```ts
export async function fetchMyBilling(merchantId: string) {
  if (!merchantId) return null
  const r = await apiTry<any>(`/api/merchants/${merchantId}/billing`, { auth: true })
  return r.ok ? r.data : null
}
```

- [ ] **Step 3: Rewrite the orders reads**

`fetchMyOrdersAtShop` (throws on error — keep that):
```ts
export async function fetchMyOrdersAtShop(merchantId: string): Promise<Order[]> {
  if (!merchantId) return []
  const user = await getCurrentUser()
  if (!user) return [] // a guest has no history — by design, and permanently
  return apiGet<Order[]>(`/api/merchants/${merchantId}/my-orders`, { auth: true })
}
```

`fetchMerchantOrders` ([] on error):
```ts
export async function fetchMerchantOrders(merchantId: string) {
  if (!merchantId) return []
  const r = await apiTry<any[]>(`/api/merchants/${merchantId}/orders`, { auth: true })
  return r.ok ? r.data : []
}
```

`merchantHasOrders` (false on error):
```ts
export async function merchantHasOrders(merchantId: string) {
  if (!merchantId) return false
  const r = await apiTry<{ count: number }>(`/api/merchants/${merchantId}/orders/count`, { auth: true })
  return r.ok ? r.data.count > 0 : false
}
```

- [ ] **Step 4: Rewrite the vouchers-list and secret reads**

`fetchMerchantVouchers` ([] on error):
```ts
export async function fetchMerchantVouchers(merchantId: string): Promise<Voucher[]> {
  if (!merchantId) return []
  const r = await apiTry<any[]>(`/api/merchants/${merchantId}/vouchers`, { auth: true })
  return r.ok ? r.data.map(voucherFromRow) : []
}
```

`fetchMerchantSecret` (null on error):
```ts
export async function fetchMerchantSecret(merchantId: string) {
  if (!merchantId) return null
  const r = await apiTry<{ tg_token: string | null; tg_chat_id: string | null }>(
    `/api/merchants/${merchantId}/secret`, { auth: true })
  return r.ok ? r.data : null
}
```

- [ ] **Step 5: Migrate the affected unit tests in `store.test.ts`**

CORRECTION to this plan's earlier premise: `apps/frontend/src/store.test.ts` DOES have unit tests for these functions — they mock `./supabase`'s `from(...)` chain. Rewriting the functions to `fetch` breaks those `describe` blocks (and, via the shared mock harness, causes collateral failures in unrelated tests). This step migrates them.

The test file mocks global `fetch` already for the POST-endpoint tests (`placeOrder`, `setMerchantStatus`) — follow that same pattern for the migrated reads. For each migrated function's `describe` block, rewrite the DB-mock cases to drive a mocked `fetch` (or a mocked `./api`) and assert BOTH: (a) the correct endpoint path + whether a bearer is sent (`auth: true`), and (b) the preserved return contract — `apiGet`-backed functions throw on a non-ok response; `apiTry`-backed functions fall back to `null`/`[]`/`false`. KEEP the pure-guard cases unchanged (reserved slug, null `userId`, missing `merchantId`, guest/no-shop early returns — these never hit the network).

Blocks to migrate in this task: `fetchProfileByUserId`, `fetchMerchantBySlug`, `fetchMyMerchant`, `fetchAllMerchants`, `fetchMerchantSecret`, `fetchMerchantOrders`, `fetchMyOrdersAtShop`, `fetchMerchantVouchers`, and `fetchMerchantCustomers` (it calls `fetchMerchantOrders` internally, so its mock must now feed the orders endpoint response, not the `supabase` order chain). Do NOT touch `fetchProducts`/`listTakenSlugs`/write-function blocks — those stay on `supabase` until Task 7 / Phase B.

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend test`
Expected: no type errors; full `store.test.ts` green (migrated blocks assert the new contract, pure-guard cases unchanged, no collateral failures).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/store.ts apps/frontend/src/store.test.ts
git commit -m "refactor(frontend): route simple reads through backend API"
```

---

## Task 7: Wire the null-contract reads (products, voucher-by-code)

**Files:**
- Modify: `apps/frontend/src/store.ts` (`lookupProducts`, `lookupMerchantVoucher`)

**Interfaces:**
- Consumes: `apiTry` from `./api`.

These two carry the load-bearing distinction between "the shop has none" (a real answer) and "I could not ask" (change nothing). Their extensive comments MUST be preserved.

- [ ] **Step 1: Rewrite `lookupProducts`**

Keep the existing doc comment above it. Replace the body:

```ts
export async function lookupProducts(merchantId: string) {
  if (!merchantId) return []
  const r = await apiTry<any[]>(`/api/merchants/${merchantId}/products`)
  // r.ok === false is the "could not ask" case → null, exactly as the comment above demands.
  // A 200 with [] is the real answer (the shop sells nothing) and must NOT become null.
  return r.ok ? r.data : null
}
```

(`fetchProducts` is unchanged — it already wraps `lookupProducts` with `?? []`.)

- [ ] **Step 2: Rewrite `lookupMerchantVoucher`**

Keep the `VoucherLookup` type and the doc comment. Replace the body:

```ts
export async function lookupMerchantVoucher(merchantId: string, code: string): Promise<VoucherLookup> {
  if (!merchantId || !code) return { ok: true, voucher: null };
  const r = await apiTry<any>(`/api/merchants/${merchantId}/vouchers/${encodeURIComponent(code)}`);
  if (!r.ok) return { ok: false };            // could not ask → caller changes nothing
  return { ok: true, voucher: r.data ? voucherFromRow(r.data) : null };
}
```

(`fetchMerchantVoucher` is unchanged — it already maps a `{ ok:false }` to `null`.)

- [ ] **Step 3: Migrate the affected unit tests + typecheck**

`store.test.ts`'s `fetchProducts` block mocks `./supabase`'s products query — but `fetchProducts` now wraps the rewritten `lookupProducts`, so that block breaks. Migrate the `fetchProducts` `describe` to the fetch-mock pattern used in Task 6, and ADD cases for the null-vs-"could-not-ask" contract: a 200 with `[]` → `lookupProducts` returns `[]` (real "shop has none"); a failed request (`apiTry` → `{ok:false}`) → `lookupProducts` returns `null`; and for `lookupMerchantVoucher`, a 200 voucher → `{ok:true,voucher}`, a 200 `null` → `{ok:true,voucher:null}`, a failed request → `{ok:false}`. Keep `fetchProducts`'s falsy-`merchantId` guard case unchanged. (`lookupMerchantVoucher` had no prior block — add one.)

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend test`
Expected: no type errors; full `store.test.ts` green.

- [ ] **Step 4: Verify no direct `supabase.from` reads remain**

Run: `grep -nE "supabase\.from\('(merchants|products|vouchers|orders|profiles|merchant_billing|merchant_secrets)'\)\.select" apps/frontend/src/store.ts`
Expected: only write-path `.select()` chained onto `.insert/.update/.upsert` remain (those are Phase B). No standalone `.select()` reads. Confirm each remaining hit is part of a write.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/store.ts
git commit -m "refactor(frontend): route null-contract reads through backend API"
```

---

## Task 8: Revoke SELECT on merchant_billing

**Files:**
- Create: `apps/backend/supabase/migrations/20260718120000_revoke_billing_select.sql`
- Test: add a case to `apps/backend/tests/rls/` (new file `apps/backend/tests/rls/billing-grant.test.ts`)

**Interfaces:** none (DB migration).

`merchant_billing` is the only table with no browser write, so its SELECT can be revoked now; every other table's revoke waits for Phase B (writes need SELECT for RETURNING).

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260718120000_revoke_billing_select.sql`:

```sql
-- Reads of merchant_billing now go through the backend (GET /api/billing and
-- /api/merchants/:id/billing, on the service-role client). The browser no longer needs
-- direct SELECT, and it never had INSERT/UPDATE/DELETE here. Revoke it so a direct
-- PostgREST read cannot reach billing at all. RLS policies stay in place as the backstop.
REVOKE SELECT ON public.merchant_billing FROM anon, authenticated;
```

- [ ] **Step 2: Apply the migration locally**

Run: `pnpm --filter @bitetime/backend db:migrate`
Expected: migration applies without error.

- [ ] **Step 3: Write the guard test**

Create `apps/backend/tests/rls/billing-grant.test.ts`:

```ts
// tests/rls/billing-grant.test.ts
// Belt on top of the code path: after the revoke, a browser (anon or authenticated) client
// cannot SELECT merchant_billing directly at all. If this ever passes with rows, the grant
// crept back and the API is no longer the only door.
import { describe, it, expect } from 'vitest'
import { anonClient, makeUser } from './helpers.js'

describe('merchant_billing is not directly readable by the browser', () => {
  it('denies an anonymous SELECT', async () => {
    const { data, error } = await anonClient().from('merchant_billing').select('*')
    // A revoked grant surfaces as a permission error (or, at minimum, zero rows).
    expect(error !== null || (data ?? []).length === 0).toBe(true)
    if (error) expect(error.message.toLowerCase()).toContain('permission denied')
  })

  it('denies an authenticated SELECT', async () => {
    const client = await makeUser('billing-grant@example.com', 'password123')
    const { data, error } = await client.from('merchant_billing').select('*')
    expect(error !== null || (data ?? []).length === 0).toBe(true)
  })
})
```

- [ ] **Step 4: Run the guard test**

Run: `pnpm --filter @bitetime/backend test:db billing-grant`
Expected: PASS (2 tests).

- [ ] **Step 5: Full DB suite (nothing else regressed by the revoke)**

Run: `pnpm --filter @bitetime/backend test:db`
Expected: all green — in particular the superadmin/owner billing endpoints (Tasks 1–2) still read billing via the service role, which the revoke does not touch.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/supabase/migrations/20260718120000_revoke_billing_select.sql apps/backend/tests/rls/billing-grant.test.ts
git commit -m "feat(db): revoke browser SELECT on merchant_billing"
```

---

## Task 9: Refactor existing admin routes onto requireSuperadmin

**Files:**
- Modify: `apps/backend/src/app.ts` (`/api/admin/approve-merchant`, `/api/admin/set-merchant-status`, `/api/admin/comp-merchant`)
- Test: `apps/backend/tests/api/reads-admin.test.ts` (extend)

The three admin routes currently repeat `getUserFromToken` + profile lookup + role check inline. Move them onto `requireSuperadmin` to delete the duplication. **Behavior must not change** — same 401/403/200 responses.

- [ ] **Step 1: Add a gate test for an existing admin route**

Append to `apps/backend/tests/api/reads-admin.test.ts` inside the `describe`:

```ts
  it('gates set-merchant-status: 401 anon, 403 non-super', async () => {
    const anon = await app.request('/api/admin/set-merchant-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantId: 'x', status: 'active' }),
    })
    expect(anon.status).toBe(401)

    const plain = await app.request('/api/admin/set-merchant-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
      body: JSON.stringify({ merchantId: 'x', status: 'active' }),
    })
    expect(plain.status).toBe(403)
  })
```

- [ ] **Step 2: Run it to confirm it passes against the current inline code**

Run: `pnpm --filter @bitetime/backend test:db reads-admin`
Expected: PASS — this pins the current behavior before refactoring.

- [ ] **Step 3: Refactor `set-merchant-status`**

In `apps/backend/src/app.ts`, change the route signature and delete its inline auth block. Current head (lines ~272–281):

```ts
app.post('/api/admin/set-merchant-status', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const { data: callerProfile } = await admin
    .from('profiles').select('app_role').eq('user_id', user.id).maybeSingle()
  const isSuper = callerProfile?.app_role === 'superadmin' || user.email === 'bitetime@praxor.dev'
  if (!isSuper) return c.json({ error: 'Forbidden' }, 403)

  const { merchantId, status } = await c.req.json().catch(() => ({}))
```

becomes:

```ts
app.post('/api/admin/set-merchant-status', requireSuperadmin, async (c) => {
  const { merchantId, status } = await c.req.json().catch(() => ({}))
```

- [ ] **Step 4: Refactor `approve-merchant` and `comp-merchant`**

Apply the same transformation to both: add `requireSuperadmin` as the second argument to `app.post(...)`, and delete their inline `token`/`getUserFromToken`/profile/`isSuper` blocks. For `approve-merchant`, the inline block is folded into a `Promise.all` (lines ~158–178) — replace the `authPromise` + the `if (!user)` / `if (!isSuper)` checks with reliance on `requireSuperadmin` having already run; keep the two data reads (`merchantRes`, `billingRes`) but drop `authPromise` from the `Promise.all`. Read `comp-merchant`'s current auth block and remove it the same way.

- [ ] **Step 5: Run the full admin + reads suites**

Run: `pnpm --filter @bitetime/backend test:db reads-admin && pnpm --filter @bitetime/backend test:db`
Expected: all green — the gate test still passes (now enforced by middleware), and the approve/status/comp behavior is unchanged.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @bitetime/backend typecheck`
Expected: no errors — confirm `getUserFromToken` is still imported only if some other route uses it (remove the import if now unused).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/app.ts apps/backend/tests/api/reads-admin.test.ts
git commit -m "refactor(backend): move admin routes onto requireSuperadmin middleware"
```

---

## Task 10: End-to-end run-and-verify

**Files:** none (verification only). Per `CLAUDE.md`, UI is verified by running the app.

- [ ] **Step 1: Start the stack**

Ensure local Supabase is running (`supabase start` in `apps/backend`), then `pnpm dev`.

- [ ] **Step 2: Verify the storefront (public + customer reads)**

Use the `verify` skill (or drive manually). Confirm:
- A shop loads by slug (`/s/<slug>`) — exercises `GET /api/merchants/:slug` and `/products`.
- Applying a voucher at checkout resolves — exercises `GET /api/merchants/:id/vouchers/:code`.
- A signed-in customer sees their order history — exercises `GET /api/merchants/:id/my-orders`.
- Place an order end-to-end (intake path unchanged) still works.

- [ ] **Step 3: Verify the dashboard (owner reads)**

Sign in as a merchant. Confirm the dashboard orders list, customers view, vouchers list, billing panel, and Telegram secret/config all load — exercising `GET /api/merchants/:id/{orders,orders/count,vouchers,billing,secret}` and `/api/me/merchant`, `/api/me/profile`.

- [ ] **Step 4: Verify the admin console (superadmin reads)**

Sign in as superadmin. Confirm the merchants list and billing load — `GET /api/merchants`, `GET /api/billing`. Approve/suspend still work (Task 9 refactor).

- [ ] **Step 5: Confirm no direct browser reads remain in the network tab**

With DevTools open, reload the storefront and dashboard. Confirm data reads hit `localhost:8787/api/...`, not the Supabase REST URL (`.../rest/v1/...`) — except `auth/v1` and `storage/v1`, which are out of scope.

---

## Self-Review notes

- **Spec coverage:** All 13 read functions from the spec table map to Tasks 1–4 (backend) + 6–7 (frontend). Middleware = Task 1. `merchant_billing` revoke = Task 8. Admin-route refactor = Task 9. Null contract = Task 7 + public tests in Task 4. Run-and-verify = Task 10. `listTakenSlugs`/`globalProfileId` correctly deferred to Phase B (not in this plan).
- **Deferred correctly:** No write endpoint appears here; `REVOKE ALL` is Phase B.
- **Type consistency:** `apiGet`/`apiTry`/`API_URL` defined in Task 5, consumed in Tasks 6–7. `AppEnv`/`requireUser`/`requireSuperadmin`/`requireMerchantOwns` defined in Task 1, consumed in Tasks 2–4, 9. `{ count }` shape produced in Task 2, consumed by `merchantHasOrders` in Task 6.
