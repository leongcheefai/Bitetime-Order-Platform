# Reads-to-Backend-API — Phase B (writes + full grant revoke) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every remaining browser→Postgres **write** behind the Hono backend API, then `REVOKE ALL` browser table grants so the browser holds zero direct table access.

**Architecture:** Each write in `apps/frontend/src/store.ts` becomes a `fetch` to a new authenticated backend route. Backend handlers use the RLS-exempt service-role `admin` client, so tenancy AND column safety are TypeScript invariants enforced in the handler — never the DB. Slug uniqueness resolution moves server-side (the last browser read of `merchants`). A terminal migration revokes all grants; RLS and the guard triggers stay as backstop.

**Tech Stack:** Hono + `@supabase/supabase-js` (service role), Vitest (`app.request()` in-process API tests + DB-backed RLS tests), pinyin-pro (server-side slug transliteration), React 19 frontend.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the codebase.

1. **Column allowlist is mandatory on every write.** The `admin` client is `service_role`, which **bypasses RLS and the `guard_merchant_status` / `guard_profile_privileges` triggers** (both start with `if auth.role() = 'service_role' then return new`). Therefore the handler is the ONLY guard. **Never pass a raw client-supplied object to `.insert()` / `.update()` / `.upsert()`.** Pick fields into a fresh object from an explicit allowlist; drop everything else silently. Forbidden-to-accept columns per table:
   - `merchants`: `status`, `owner_id`, `slug` (except the dedicated slug route), `plan`, `billing_cycle`, `billing_region`, `id`, `created_at`.
   - `profiles`: `app_role`, `merchant_id`, `id`, `created_at`. `user_id` is forced to the caller, never read from the body.
   - `orders`: everything except `status`, `note`, `courier`, `awb`.
   - `products`: `merchant_id` is forced to the route `:id`, never read from the body.
2. **Sub-resource tenancy is verified in the handler.** For any route addressing a child by its own id under `/api/merchants/:id/...` (`orders/:orderId`, `products/:productId`, `vouchers/:voucherId`), after `requireMerchantOwns` passes on `:id` the handler MUST load the child and confirm `child.merchant_id === :id`, returning 404 otherwise. This is what stops an owner of shop A mutating shop B's row by nesting it under `:id = A`. `requireMerchantOwns` alone does NOT check this — it only proves the caller owns `:id`.
3. **Signatures and return contracts are preserved.** Each ported `store.ts` function keeps its exact signature and return shape; only its body changes from `supabase.from(...)` to `fetch`. Callers in `merchant/*`, `store/Storefront.tsx` are untouched. Functions that `throw` on error today keep throwing on non-2xx. `saveCustomerDetails` is best-effort and MUST NOT throw.
4. **Backend imports keep `.js` specifiers** (NodeNext). New backend runtime deps need an esbuild `--external:` flag added to the `build` script in `apps/backend/package.json` (currently: `@hono/node-server`, `hono`, `@supabase/supabase-js`, `stripe`, `postgres`).
5. **RLS and guard triggers stay in place.** The terminal migration only `REVOKE`s grants; it drops no policy and no trigger. They remain the backstop per `CLAUDE.md`.
6. **`admin` and `getUserFromToken` come from `./supabase.js`; middleware from `./mw.js`.** Reuse `requireUser` / `requireMerchantOwns` / `requireSuperadmin` from `apps/backend/src/mw.ts` — do not re-implement auth inline.

---

## File Structure

**Backend (`apps/backend/`):**
- Create `src/slug.ts` — server-side slug resolution (`slugify`, `toSlugBase`, `resolveSlug`, `RESERVED_SLUGS`) + `orderPrefix` + referral helpers, ported from the frontend. pinyin-pro loaded server-side.
- Create `src/writes.ts` — small pure helpers shared by write handlers: the per-table column `pick()` allowlists and `ORDER_STATUSES`. Keeps allowlists in one auditable place.
- Modify `src/app.ts` — add the write routes (create-merchant, config, slug, profile, products, vouchers, orders, secret).
- Modify `package.json` — add `pinyin-pro` dependency + `--external:pinyin-pro` in the `build` script.
- Create `supabase/migrations/20260718130000_revoke_all_browser_grants.sql` — terminal `REVOKE ALL`.
- Create tests: `tests/api/writes-merchants.test.ts`, `writes-profile.test.ts`, `writes-products.test.ts`, `writes-vouchers.test.ts`, `writes-orders.test.ts`, `writes-secret.test.ts`; and `tests/rls/revoke-writes.test.ts`; unit `tests/unit/slug.test.ts`.

**Frontend (`apps/frontend/`):**
- Modify `src/api.ts` — add `apiSend` (throwing mutation helper) reusing the existing `headers()`.
- Modify `src/store.ts` — rewrite the write bodies; `globalProfileId` / `ensureGlobalProfile` collapse into a single fetch; `listTakenSlugs` deleted (resolution now server-side).
- Modify `src/store.test.ts` — migrate the affected write suites to fetch mocks.

---

## Task 1: Backend slug resolution util

**Files:**
- Create: `apps/backend/src/slug.ts`
- Modify: `apps/backend/package.json` (add `pinyin-pro` dep + `--external:pinyin-pro`)
- Test: `apps/backend/tests/unit/slug.test.ts`

**Interfaces:**
- Produces: `resolveSlug(name: string, opts?: { taken?: string[]; id?: string }): Promise<string>`, `orderPrefix(slug: string): string`, `RESERVED_SLUGS: string[]`, `resolveReferredByCode(raw: string|null|undefined, ownerCode: string): string|null`, `referralCodeOf(userId: string): string`. Consumed by Task 2 and Task 3.

**Context:** This ports `apps/frontend/src/slug.ts`, `orderPrefix.ts`, and `referralCode.ts` (plus `referralCodeOf` from `store.ts:507`) to the backend so slug uniqueness can be resolved server-side after the browser loses `SELECT` on `merchants`. Logic must match the frontend exactly (same slugs must be produced). pinyin-pro is imported at module top on the backend (no bundle-size concern server-side, unlike the frontend's dynamic import).

- [ ] **Step 1: Add the dependency + external flag**

Add `"pinyin-pro": "^3.26.0"` to `dependencies` in `apps/backend/package.json`, then add `--external:pinyin-pro` to the `build` script (right after `--external:postgres`). Run `pnpm install` from repo root.

- [ ] **Step 2: Write the failing unit test**

```ts
// apps/backend/tests/unit/slug.test.ts
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
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm --filter @bitetime/backend test slug` — Expected: FAIL (module `../../src/slug.js` not found).

- [ ] **Step 4: Write `src/slug.ts`**

```ts
// apps/backend/src/slug.ts
// Server-side slug resolution. Ported verbatim from apps/frontend/src/slug.ts +
// orderPrefix.ts + referralCode.ts so the backend produces byte-identical slugs.
// pinyin-pro is imported eagerly here (no browser bundle to keep lean).
import { pinyin } from 'pinyin-pro'

function hasCJK(s: string) {
  return /[一-鿿]/.test(s)
}

export function slugify(name: string) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function toSlugBase(name: string) {
  const raw = String(name ?? '')
  if (!hasCJK(raw)) return slugify(raw)
  const latinised = raw.replace(/[一-鿿]+/g, match =>
    pinyin(match, { toneType: 'none', separator: ' ' }),
  )
  return slugify(latinised)
}

export const RESERVED_SLUGS = [
  's', 'admin', 'api', 'merchant', 'app', 'www', 'auth',
  'login', 'signup', 'account', 'static', 'assets',
]

export async function resolveSlug(name: string, { taken = [], id = '' }: { taken?: string[]; id?: string } = {}) {
  const base = toSlugBase(name) || `shop-${id.replace(/-/g, '').slice(0, 6)}`
  const used = new Set(taken)
  const blocked = (s: string) => used.has(s) || RESERVED_SLUGS.includes(s)
  if (!blocked(base)) return base
  let n = 2
  while (blocked(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function orderPrefix(slug: string) {
  const alnum = String(slug ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return alnum.length >= 2 ? alnum.slice(0, 2) : 'SH'
}

export function referralCodeOf(userId: string) {
  return (userId || '').replace(/-/g, '').slice(0, 8).toUpperCase()
}

function normalizeReferralCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase()
  return /^[0-9A-F]{8}$/.test(code) ? code : null
}

export function resolveReferredByCode(raw: string | null | undefined, ownerCode: string): string | null {
  const code = normalizeReferralCode(raw)
  if (!code) return null
  return code === ownerCode ? null : code
}
```

Note: the frontend keeps `toSlugBase` async (dynamic `import('pinyin-pro')` to stay out of the browser bundle). The backend version is sync because pinyin is imported at top; `resolveSlug` stays async to preserve the same call shape and leave room. `resolveSlug` verified against the frontend: `!!!` with a latin fallback id yields `shop-<first6hex>`.

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter @bitetime/backend test slug` — Expected: PASS (all cases). If the CJK case differs, adjust the expected string to whatever pinyin-pro actually returns and note it — the invariant is "backend == frontend", so cross-check by running the frontend `resolveSlug('北京烤鸭')` in a scratch script if in doubt.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/slug.ts apps/backend/tests/unit/slug.test.ts apps/backend/package.json pnpm-lock.yaml
git commit -m "feat(backend): port slug resolution server-side for write endpoints"
```

---

## Task 2: `POST /api/merchants` — create shop (server-side slug)

**Files:**
- Modify: `apps/backend/src/app.ts` (add route)
- Modify: `apps/frontend/src/api.ts` (add `apiSend`)
- Modify: `apps/frontend/src/store.ts` (`createMerchant` → fetch; delete `listTakenSlugs` after Task 3 also drops its other caller — here just stop using it in `createMerchant`)
- Modify: `apps/frontend/src/store.test.ts`
- Test: `apps/backend/tests/api/writes-merchants.test.ts`

**Interfaces:**
- Consumes: `resolveSlug`, `orderPrefix`, `referralCodeOf`, `resolveReferredByCode` (Task 1); `requireUser` (`mw.ts`).
- Produces: `apiSend<T>(path, method, body?, opts?): Promise<T>` in `api.ts`, consumed by every later frontend write task. `POST /api/merchants` returning the created merchant row.

**Context:** `createMerchant` (`store.ts:202`) currently reads all slugs (`listTakenSlugs`), resolves a unique slug in the browser, then inserts. After the revoke the browser can't read `merchants.slug`, so resolution moves into this endpoint. **The insert goes through `admin` (service_role), which bypasses `guard_merchant_status`** — so the handler must force `status: 'pending'` and `owner_id: <caller>` explicitly and accept only `name/plan/billing/region/referredByCode` from the body (Global Constraint 1).

- [ ] **Step 1: Add `apiSend` to `api.ts`**

```ts
// append to apps/frontend/src/api.ts
type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE'

// Throwing mutation helper — mirrors apiGet's contract for writes. Callers that must
// stay best-effort (saveCustomerDetails) wrap this in their own try/catch.
export async function apiSend<T>(path: string, method: Method, body?: unknown, opts?: Opts): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(await headers(opts)) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(b.error || `Request failed: ${res.status}`)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}
```

- [ ] **Step 2: Write the failing API test**

```ts
// apps/backend/tests/api/writes-merchants.test.ts
import { describe, it, expect } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, authHeader, serviceClient, seedMerchant } from './helpers.js' // reuse Phase A helpers; adapt names to the existing file

describe('POST /api/merchants', () => {
  it('creates a pending shop owned by the caller with a resolved slug', async () => {
    const { token, userId } = await makeUser('create-shop@example.com')
    const res = await app.request('/api/merchants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ name: 'Joe Coffee', plan: 'basic', billing: 'monthly', region: 'US' }),
    })
    expect(res.status).toBe(200)
    const m = await res.json()
    expect(m.slug).toBe('joe-coffee')
    expect(m.status).toBe('pending')
    expect(m.owner_id).toBe(userId)
    expect(m.order_prefix).toBe('JO')
  })

  it('ignores a client-supplied status and owner_id (privilege guard)', async () => {
    const { token, userId } = await makeUser('create-evil@example.com')
    const res = await app.request('/api/merchants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ name: 'Evil Shop', status: 'active', owner_id: '00000000-0000-0000-0000-000000000000' }),
    })
    const m = await res.json()
    expect(m.status).toBe('pending')
    expect(m.owner_id).toBe(userId)
  })

  it('suffixes a taken slug', async () => {
    await seedMerchant({ slug: 'taken-name', owner_id: (await makeUser('owner-x@example.com')).userId })
    const { token } = await makeUser('create-dup@example.com')
    const res = await app.request('/api/merchants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ name: 'Taken Name' }),
    })
    expect((await res.json()).slug).toBe('taken-name-2')
  })

  it('401 without a token', async () => {
    const res = await app.request('/api/merchants', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    expect(res.status).toBe(401)
  })
})
```

Note: check the exact helper names/signatures in the existing `apps/backend/tests/api/helpers.ts` from Phase A and match them (`makeUser`, `authHeader`, `seedMerchant`, `serviceClient` may have different names/return shapes — adapt).

- [ ] **Step 3: Run it, verify it fails** — `pnpm --filter @bitetime/backend test:db writes-merchants` → FAIL (404 route).

- [ ] **Step 4: Add the route to `app.ts`** (place beside the other merchant routes; import the Task 1 helpers)

```ts
import { resolveSlug, orderPrefix, referralCodeOf, resolveReferredByCode } from './slug.js'

app.post('/api/merchants', requireUser, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({} as any))
  const name = String(body?.name ?? '').trim()
  if (!name) return c.json({ error: 'Missing name' }, 400)

  const { data: rows } = await admin.from('merchants').select('slug')
  const slug = await resolveSlug(name, { taken: (rows ?? []).map(r => r.slug), id: user.id })

  const { data, error } = await admin.from('merchants').insert({
    name,
    slug,
    order_prefix: orderPrefix(slug),
    owner_id: user.id,
    status: 'pending',
    plan: body?.plan ?? 'basic',
    billing_cycle: body?.billing ?? 'monthly',
    billing_region: body?.region ?? 'US',
    referred_by_code: resolveReferredByCode(body?.referredByCode, referralCodeOf(user.id)),
  }).select().single()
  if (error) return c.json({ error: 'Create failed' }, 500)
  return c.json(data)
})
```

- [ ] **Step 5: Rewrite `createMerchant` in `store.ts`**

```ts
export async function createMerchant({ name, plan = 'basic', billing = 'monthly', region = 'US', referredByCode }: { name: string; plan?: string; billing?: string; region?: string; referredByCode?: string }) {
  return apiSend<any>('/api/merchants', 'POST', { name, plan, billing, region, referredByCode }, { auth: true })
}
```

Remove the now-unused imports in `store.ts` only if nothing else uses them yet — `resolveSlug`/`orderPrefix`/`referralCodeOf` were used only here and in `updateMerchantSlug`; leave the imports until Task 3 removes the last user, or the lint step will flag them. **Do not delete `listTakenSlugs` yet** — `updateMerchantSlug` still calls it until Task 3.

- [ ] **Step 6: Migrate the `createMerchant` suite in `store.test.ts`** to `vi.stubGlobal('fetch', ...)` returning the created row; assert the POST body carries `name/plan/billing/region/referredByCode` and `{ auth: true }` attaches the bearer. Follow the fetch-mock pattern established in Phase A's store.test.ts.

- [ ] **Step 7: Run** `pnpm --filter @bitetime/backend test:db writes-merchants` (PASS) and `pnpm --filter @bitetime/frontend test store` (PASS).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/app.ts apps/frontend/src/api.ts apps/frontend/src/store.ts apps/frontend/src/store.test.ts apps/backend/tests/api/writes-merchants.test.ts
git commit -m "feat: create-merchant endpoint with server-side slug resolution"
```

---

## Task 3: `PATCH /api/merchants/:id` (config) + `PATCH /api/merchants/:id/slug`

**Files:**
- Create: `apps/backend/src/writes.ts` (column allowlists)
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/frontend/src/store.ts` (`updateMerchantConfig`, `updateMerchantSlug`; delete `listTakenSlugs`)
- Modify: `apps/frontend/src/store.test.ts`
- Test: extend `apps/backend/tests/api/writes-merchants.test.ts`

**Interfaces:**
- Consumes: `requireMerchantOwns` (`mw.ts`), `RESERVED_SLUGS`/`resolveSlug` (Task 1).
- Produces: `pickMerchantConfig(body): Record<string, unknown>` in `writes.ts`.

**Context:** `updateMerchantConfig` (`store.ts:863`) patches arbitrary columns via `.update(patch)`. Through `admin` this bypasses `guard_merchant_status`, so a caller could send `{ status: 'active' }` and self-activate a suspended shop — the exact escalation the trigger blocks for the browser. The handler must **allowlist config columns only**. `updateMerchantSlug` (`store.ts:334`) reads all slugs to check uniqueness — that read moves server-side.

- [ ] **Step 1: Create `writes.ts` with the config allowlist**

```ts
// apps/backend/src/writes.ts
// Column allowlists for write endpoints. The service-role `admin` client bypasses RLS and the
// guard_merchant_status / guard_profile_privileges triggers, so these picks are the ONLY thing
// stopping privilege escalation. Never spread a raw client body into a DB write — pick from here.

export const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

// Owner-editable shop config. Deliberately EXCLUDES status, owner_id, slug, plan, billing_*, id.
// Mirrors what the browser could safely write under the old RLS+trigger regime. This is the
// EXACT union of the two updateMerchantConfig call sites (ShopSettings.tsx:141 writes
// { currency?, shipping, pickup_address }; :243 writes { payment_bank, payment_note }) —
// verified 2026-07-18. `shipping` is a jsonb column (shopRates output); `currency` is dropped
// client-side once locked, but allowlist it anyway — the lock is a UI concern, and the currency
// column is not a privilege.
const MERCHANT_CONFIG_FIELDS = [
  'currency', 'shipping', 'pickup_address', 'payment_bank', 'payment_note',
] as const

export function pickMerchantConfig(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of MERCHANT_CONFIG_FIELDS) if (body?.[k] !== undefined) out[k] = body[k]
  return out
}
```

If a later ShopSettings change adds a config column, add it here in the same commit — the allowlist is the union of real call sites, nothing more, nothing less.

- [ ] **Step 2: Write failing tests** (append to `writes-merchants.test.ts`)

```ts
describe('PATCH /api/merchants/:id (config)', () => {
  it('updates allowlisted config for the owner', async () => {
    const { token, userId } = await makeUser('cfg-owner@example.com')
    const id = await seedMerchant({ slug: 'cfg-shop', owner_id: userId })
    const res = await app.request(`/api/merchants/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ payment_note: 'Pay on pickup' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).payment_note).toBe('Pay on pickup')
  })

  it('IGNORES status and owner_id in the body (no self-activation)', async () => {
    const { token, userId } = await makeUser('cfg-evil@example.com')
    const id = await seedMerchant({ slug: 'cfg-evil-shop', owner_id: userId, status: 'suspended' })
    const res = await app.request(`/api/merchants/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ status: 'active', owner_id: '00000000-0000-0000-0000-000000000000', payment_note: 'x' }),
    })
    expect(res.status).toBe(200)
    const { data: row } = await serviceClient().from('merchants').select('status, owner_id').eq('id', id).single()
    expect(row.status).toBe('suspended')   // trigger bypassed by service_role, allowlist saved us
    expect(row.owner_id).toBe(userId)
  })

  it('403 for a non-owner', async () => {
    const owner = await makeUser('cfg-a@example.com')
    const id = await seedMerchant({ slug: 'cfg-a-shop', owner_id: owner.userId })
    const other = await makeUser('cfg-b@example.com')
    const res = await app.request(`/api/merchants/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader(other.token) }, body: JSON.stringify({ payment_note: 'x' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/merchants/:id/slug', () => {
  it('renames when the slug is free', async () => {
    const { token, userId } = await makeUser('slug-owner@example.com')
    const id = await seedMerchant({ slug: 'old-slug', owner_id: userId })
    const res = await app.request(`/api/merchants/${id}/slug`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader(token) }, body: JSON.stringify({ slug: 'new-slug' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).slug).toBe('new-slug')
  })
  it('409 when the slug is taken', async () => {
    const a = await makeUser('slug-a@example.com'); await seedMerchant({ slug: 'busy', owner_id: a.userId })
    const b = await makeUser('slug-b@example.com'); const id = await seedMerchant({ slug: 'mine', owner_id: b.userId })
    const res = await app.request(`/api/merchants/${id}/slug`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader(b.token) }, body: JSON.stringify({ slug: 'busy' }),
    })
    expect(res.status).toBe(409)
  })
  it('400 on a reserved slug', async () => {
    const { token, userId } = await makeUser('slug-res@example.com')
    const id = await seedMerchant({ slug: 'res-shop', owner_id: userId })
    const res = await app.request(`/api/merchants/${id}/slug`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader(token) }, body: JSON.stringify({ slug: 'admin' }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 3: Run, verify fail** — `pnpm --filter @bitetime/backend test:db writes-merchants` → FAIL.

- [ ] **Step 4: Add both routes to `app.ts`**

```ts
import { pickMerchantConfig } from './writes.js'
import { RESERVED_SLUGS } from './slug.js'

app.patch('/api/merchants/:id', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const patch = pickMerchantConfig(await c.req.json().catch(() => ({})))
  if (Object.keys(patch).length === 0) return c.json({ error: 'No updatable fields' }, 400)
  const { data, error } = await admin.from('merchants').update(patch).eq('id', id).select().single()
  if (error) return c.json({ error: 'Update failed' }, 500)
  return c.json(data)
})

app.patch('/api/merchants/:id/slug', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const s = String((await c.req.json().catch(() => ({}))).slug ?? '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) return c.json({ error: 'Reserved or empty slug' }, 400)
  const { data: existing } = await admin.from('merchants').select('id').eq('slug', s).maybeSingle()
  if (existing && existing.id !== id) return c.json({ error: 'Slug already taken' }, 409)
  const { data, error } = await admin.from('merchants').update({ slug: s }).eq('id', id).select().single()
  if (error) return c.json({ error: 'Update failed' }, 500)
  return c.json(data)
})
```

- [ ] **Step 5: Rewrite `store.ts` `updateMerchantConfig` + `updateMerchantSlug`; delete `listTakenSlugs`**

```ts
export async function updateMerchantConfig(id: string, patch: any) {
  return apiSend<any>(`/api/merchants/${id}`, 'PATCH', patch, { auth: true })
}

export async function updateMerchantSlug(id: string, slug: string) {
  const s = (slug || '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) throw new Error('Reserved or empty slug')
  return apiSend<any>(`/api/merchants/${id}/slug`, 'PATCH', { slug: s }, { auth: true })
}
```

Delete `listTakenSlugs` (lines 190-194) — no caller remains. Then remove any now-unused imports (`resolveSlug`, `orderPrefix`, `referralCodeOf` if Task 2 left them) flagged by `pnpm lint`. Keep `RESERVED_SLUGS` (still used here and in `fetchMerchantBySlug`).

- [ ] **Step 6: Migrate the `updateMerchantConfig`/`updateMerchantSlug`/`listTakenSlugs` suites** in `store.test.ts` to fetch mocks (delete the `listTakenSlugs` suite; it's gone).

- [ ] **Step 7: Run** backend `test:db writes-merchants` + frontend `test store` + `pnpm lint` → all green.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/writes.ts apps/backend/src/app.ts apps/frontend/src/store.ts apps/frontend/src/store.test.ts apps/backend/tests/api/writes-merchants.test.ts
git commit -m "feat: merchant config + slug PATCH endpoints with column allowlist"
```

---

## Task 4: `PUT /api/me/profile` — global profile upsert

**Files:**
- Modify: `apps/backend/src/app.ts`, `apps/backend/src/writes.ts`
- Modify: `apps/frontend/src/store.ts` (`ensureGlobalProfile`, `saveCustomerDetails`; delete `globalProfileId`)
- Modify: `apps/frontend/src/store.test.ts`
- Test: `apps/backend/tests/api/writes-profile.test.ts`

**Interfaces:**
- Consumes: `requireUser`.
- Produces: `pickProfileFields(body): Record<string, unknown>` in `writes.ts`.

**Context:** Two writers touch the caller's GLOBAL profile (`merchant_id IS NULL`): `ensureGlobalProfile` (`store.ts:92`, called from merchant `signUp` and `onAuthChange`) and `saveCustomerDetails` (`store.ts:125`, silent best-effort after checkout). Both find the row via `globalProfileId` (`store.ts:82`). All three collapse into one endpoint that upserts the caller's global row. **`guard_profile_privileges` is bypassed by service_role**, so the handler must force `user_id = caller`, force `merchant_id = null`, and reject `app_role`/`merchant_id`/`id` from the body (Global Constraint 1). `email_confirmed` semantics: the caller may set it (it reflects Supabase's confirmation state, passed from `onAuthChange`); it is not a privilege.

- [ ] **Step 1: Add `pickProfileFields` to `writes.ts`**

```ts
// EXACT union of the two writers, verified 2026-07-18:
//   ensureGlobalProfile (store.ts:92, :396) sets: name, email, email_confirmed, referral_code
//   saveCustomerDetails via SavedDetails (savedDetails.ts:18) sets: whatsapp, delivery_address (jsonb)
// user_id is FORCED to the caller server-side; app_role / merchant_id / id / created_at are never accepted.
const PROFILE_FIELDS = [
  'name', 'email', 'email_confirmed', 'referral_code', 'whatsapp', 'delivery_address',
] as const

export function pickProfileFields(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PROFILE_FIELDS) if (body?.[k] !== undefined) out[k] = body[k]
  return out
}
```

- [ ] **Step 2: Write failing test**

```ts
// apps/backend/tests/api/writes-profile.test.ts
import { describe, it, expect } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, authHeader, serviceClient } from './helpers.js'

describe('PUT /api/me/profile', () => {
  it('creates the caller global profile on first call, updates on the second', async () => {
    const { token, userId } = await makeUser('prof@example.com')
    let res = await app.request('/api/me/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeader(token) }, body: JSON.stringify({ name: 'Ada' }),
    })
    expect(res.status).toBe(200)
    res = await app.request('/api/me/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeader(token) }, body: JSON.stringify({ name: 'Ada Lovelace' }),
    })
    expect(res.status).toBe(200)
    const { data: rows } = await serviceClient().from('profiles').select('*').eq('user_id', userId).is('merchant_id', null)
    expect(rows).toHaveLength(1)           // upsert, not a second insert
    expect(rows[0].name).toBe('Ada Lovelace')
  })

  it('refuses to set app_role or merchant_id from the body', async () => {
    const { token, userId } = await makeUser('prof-evil@example.com')
    await app.request('/api/me/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ name: 'x', app_role: 'superadmin', merchant_id: '00000000-0000-0000-0000-000000000000' }),
    })
    const { data } = await serviceClient().from('profiles').select('app_role, merchant_id').eq('user_id', userId).is('merchant_id', null).single()
    expect(data.app_role).not.toBe('superadmin')
    expect(data.merchant_id).toBeNull()
  })

  it('401 without a token', async () => {
    const res = await app.request('/api/me/profile', { method: 'PUT', body: '{}', headers: { 'Content-Type': 'application/json' } })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 3: Run, verify fail.**

- [ ] **Step 4: Add the route** (mirrors the `globalProfileId` select-then-insert/update, since the partial unique index on `user_id WHERE merchant_id IS NULL` can't be an `ON CONFLICT` target)

```ts
import { pickProfileFields } from './writes.js'

app.put('/api/me/profile', requireUser, async (c) => {
  const user = c.get('user')
  const fields = pickProfileFields(await c.req.json().catch(() => ({})))
  const { data: existing } = await admin.from('profiles').select('id').eq('user_id', user.id).is('merchant_id', null).maybeSingle()
  if (existing) {
    const { error } = await admin.from('profiles').update(fields).eq('id', existing.id)
    if (error) return c.json({ error: 'Update failed' }, 500)
  } else {
    const { error } = await admin.from('profiles').insert({ ...fields, user_id: user.id, email: fields.email ?? user.email, created_at: new Date().toISOString() })
    if (error) return c.json({ error: 'Insert failed' }, 500)
  }
  return c.json({ ok: true })
})
```

- [ ] **Step 5: Rewrite the three `store.ts` functions**

```ts
// ensureGlobalProfile: best-effort, returns an Error-or-null like today (callers ignore/retry).
async function ensureGlobalProfile(fields: {
  user_id: string; name: string; email?: string | null; email_confirmed: boolean; referral_code?: string
}): Promise<Error | null> {
  try {
    // user_id is forced server-side to the caller; send the rest.
    const { user_id: _uid, ...rest } = fields
    await apiSend('/api/me/profile', 'PUT', rest, { auth: true })
    return null
  } catch (e) {
    return e as Error   // no session yet during pending confirmation → 401 → retried on onAuthChange
  }
}

export async function saveCustomerDetails(fields: SavedDetails): Promise<void> {
  if (Object.keys(fields).length === 0) return
  const user = await getCurrentUser()
  if (!user) return
  try { await apiSend('/api/me/profile', 'PUT', fields, { auth: true }) } catch { /* best-effort, never surfaces */ }
}
```

Delete `globalProfileId` (`store.ts:82-90`) — its logic is now server-side; confirm no other caller (grep). Keep `ensureGlobalProfile`'s call sites (`store.ts:33`, `store.ts:396`) unchanged.

- [ ] **Step 6: Migrate the profile suites** in `store.test.ts` to fetch mocks. `saveCustomerDetails` test: assert it swallows a rejected fetch (no throw).

- [ ] **Step 7: Run** backend `test:db writes-profile` + frontend `test store` → green.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: global-profile upsert endpoint; collapse ensureGlobalProfile/saveCustomerDetails"
```

---

## Task 5: products write endpoints

**Files:**
- Modify: `apps/backend/src/app.ts`, `apps/backend/src/writes.ts`
- Modify: `apps/frontend/src/store.ts` (`upsertProduct`, `deleteProduct`)
- Modify: `apps/frontend/src/store.test.ts`
- Test: `apps/backend/tests/api/writes-products.test.ts`

**Interfaces:**
- Consumes: `requireMerchantOwns`.
- Produces: `PUT /api/merchants/:id/products/:productId` (upsert), `DELETE /api/merchants/:id/products/:productId`.

**Context:** `upsertProduct(product)` (`store.ts:807`) takes a full product row with `merchant_id` embedded; `deleteProduct(id)` (`store.ts:813`) by product id. The new routes nest under `:id` so `requireMerchantOwns` gates the shop; the handler **forces `merchant_id = :id`** on upsert (ignoring any body value) and **verifies `merchant_id === :id`** before delete (Global Constraint 2). Callers (`ProductsManager.tsx`) build the product object with `merchant_id: merchant!.id` and `id: draftId` already, so the frontend has both ids to build the URL.

- [ ] **Step 1: Write failing test** (`writes-products.test.ts`): owner upserts a product (200, row has `merchant_id === :id`); owner of shop A cannot `PUT`/`DELETE` a product whose row belongs to shop B by nesting under `:id = A` (expect 404 on the cross-tenant delete; expect the upsert to write under A, not touch B); non-owner 403; anon 401. Seed two merchants + a product in each via `serviceClient`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add `pickProductFields` to `writes.ts`** — allowlist the product columns `ProductsManager` writes (read it: `name`, `name_zh`, `description`, `description_zh`, `price`, `unit`, `unit_quantity`, `active`, `sort`, `image_urls`, promo fields, `id`). `merchant_id` is NOT in the allowlist — it's forced. `id` stays (it's the upsert key).

- [ ] **Step 4: Add routes**

```ts
app.put('/api/merchants/:id/products/:productId', requireMerchantOwns, async (c) => {
  const id = c.req.param('id'); const productId = c.req.param('productId')
  const row = { ...pickProductFields(await c.req.json().catch(() => ({}))), id: productId, merchant_id: id }
  const { data, error } = await admin.from('products').upsert(row).select().single()
  if (error) return c.json({ error: 'Upsert failed' }, 500)
  return c.json(data)
})

app.delete('/api/merchants/:id/products/:productId', requireMerchantOwns, async (c) => {
  const id = c.req.param('id'); const productId = c.req.param('productId')
  const { data: existing } = await admin.from('products').select('merchant_id').eq('id', productId).maybeSingle()
  if (!existing || existing.merchant_id !== id) return c.json({ error: 'Not found' }, 404)
  const { error } = await admin.from('products').delete().eq('id', productId)
  if (error) return c.json({ error: 'Delete failed' }, 500)
  return c.json({ ok: true })
})
```

- [ ] **Step 5: Rewrite `store.ts`**

```ts
export async function upsertProduct(product: any) {
  return apiSend<any>(`/api/merchants/${product.merchant_id}/products/${product.id}`, 'PUT', product, { auth: true })
}
export async function deleteProduct(id: string, merchantId: string) {
  await apiSend(`/api/merchants/${merchantId}/products/${id}`, 'DELETE', undefined, { auth: true })
}
```

`deleteProduct` gains a `merchantId` param — **this is a signature change**, so update its two call sites in `ProductsManager.tsx:271` (`deleteProduct(p.id, merchant!.id)`) and confirm `p` carries no merchant id but `merchant` is in scope there (it is). Also confirm `upsertProduct` callers always set `merchant_id` and `id` — `ProductsManager.tsx:230,237,268` all do (`draftId`/`editingProduct.id` and `merchant!.id`); the `id: draftId` branch and the `...editingProduct` branch both carry an id. If any path could reach `upsertProduct` without an `id`, generate it client-side first (the code already uses `draftId` for new rows).

- [ ] **Step 6: Migrate the product suites** in `store.test.ts`; add a case asserting the URL includes both ids.

- [ ] **Step 7: Run** backend `test:db writes-products` + frontend `test` + `pnpm typecheck` (catches the `deleteProduct` signature change) → green.

- [ ] **Step 8: Commit** `feat: product upsert/delete endpoints with forced tenancy`

---

## Task 6: vouchers write endpoints

**Files:**
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/frontend/src/store.ts` (`createMerchantVoucher`, `deleteMerchantVoucher`)
- Modify: `apps/frontend/src/store.test.ts`
- Test: `apps/backend/tests/api/writes-vouchers.test.ts`

**Interfaces:**
- Consumes: `requireMerchantOwns`, `voucherFromRow` (existing in `store.ts`).
- Produces: `POST /api/merchants/:id/vouchers`, `DELETE /api/merchants/:id/vouchers/:voucherId`.

**Context:** `createMerchantVoucher` (`store.ts:484`) inserts `{ merchant_id, code, kind, amount, max_uses }` and returns `voucherFromRow(data)`; `deleteMerchantVoucher(id)` (`store.ts:498`) by voucher id. Nest under `:id`; force `merchant_id = :id` on create; verify tenancy on delete (Global Constraint 2). `code` is uppercased/trimmed server-side (matches current `input.code.trim().toUpperCase()`).

- [ ] **Step 1: Write failing test** (`writes-vouchers.test.ts`): owner creates a voucher (200; row `merchant_id === :id`, `code` uppercased); owner A cannot delete shop B's voucher nested under A (404); non-owner 403; anon 401.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add routes**

```ts
app.post('/api/merchants/:id/vouchers', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json().catch(() => ({} as any))
  const code = String(b?.code ?? '').trim().toUpperCase()
  if (!code) return c.json({ error: 'Missing code' }, 400)
  const { data, error } = await admin.from('vouchers').insert({
    merchant_id: id, code, kind: b?.kind, amount: b?.amount, max_uses: b?.maxUses ?? null,
  }).select().single()
  if (error) return c.json({ error: 'Create failed' }, 500)
  return c.json(data)
})

app.delete('/api/merchants/:id/vouchers/:voucherId', requireMerchantOwns, async (c) => {
  const id = c.req.param('id'); const voucherId = c.req.param('voucherId')
  const { data: existing } = await admin.from('vouchers').select('merchant_id').eq('id', voucherId).maybeSingle()
  if (!existing || existing.merchant_id !== id) return c.json({ error: 'Not found' }, 404)
  const { error } = await admin.from('vouchers').delete().eq('id', voucherId)
  if (error) return c.json({ error: 'Delete failed' }, 500)
  return c.json({ ok: true })
})
```

- [ ] **Step 4: Rewrite `store.ts`** (return contract preserved: `createMerchantVoucher` still returns `voucherFromRow`)

```ts
export async function createMerchantVoucher(input: { merchantId: string; code: string; kind: string; amount: number; maxUses?: number | null }): Promise<Voucher> {
  const data = await apiSend<any>(`/api/merchants/${input.merchantId}/vouchers`, 'POST', { code: input.code, kind: input.kind, amount: input.amount, maxUses: input.maxUses ?? null }, { auth: true })
  return voucherFromRow(data)
}

export async function deleteMerchantVoucher(id: string, merchantId: string) {
  await apiSend(`/api/merchants/${merchantId}/vouchers/${id}`, 'DELETE', undefined, { auth: true })
}
```

`deleteMerchantVoucher` gains `merchantId` — **signature change**; update `VouchersManager.tsx:70` to `deleteMerchantVoucher(id, merchant!.id)` (confirm `merchant` is in scope there — it is, same component holds the vouchers list for a merchant).

- [ ] **Step 5: Migrate the voucher write suites** in `store.test.ts`.

- [ ] **Step 6: Run** backend `test:db writes-vouchers` + frontend `test` + `typecheck` → green.

- [ ] **Step 7: Commit** `feat: voucher create/delete endpoints with forced tenancy`

---

## Task 7: orders write endpoint

**Files:**
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/frontend/src/store.ts` (`setOrderStatus`, `setOrderNote`, `setOrderTracking`)
- Modify: `apps/frontend/src/store.test.ts`
- Test: `apps/backend/tests/api/writes-orders.test.ts`

**Interfaces:**
- Consumes: `requireMerchantOwns`, `ORDER_STATUSES` (`writes.ts`).
- Produces: `PATCH /api/merchants/:id/orders/:orderId` returning the updated order row.

**Context:** Three functions patch an order by id: `setOrderStatus` (`store.ts:705`, validates against `ORDER_STATUSES`), `setOrderNote` (`store.ts:713`, `note` trimmed→null), `setOrderTracking` (`store.ts:721`, `courier`/`awb`). All three return the updated row. Combine into one `PATCH` accepting the allowlisted subset `{ status?, note?, courier?, awb? }`. Verify `order.merchant_id === :id` (Global Constraint 2). Callers in `OrdersView.tsx` have `order.id`; the component holds `merchant` for the shop — thread `merchant.id` into the URL.

- [ ] **Step 1: Add `pickOrderFields` to `writes.ts`** — allowlist `status` (must be in `ORDER_STATUSES` or 400), `note` (empty→null), `courier` (empty→null), `awb` (empty→null). Reject everything else.

- [ ] **Step 2: Write failing test** (`writes-orders.test.ts`): owner sets status→200, row updated; invalid status→400; owner A cannot patch shop B's order nested under `:id = A`→404; owner patches note/courier/awb; non-owner 403; anon 401. Seed two merchants each with an order.

- [ ] **Step 3: Run, verify fail.**

- [ ] **Step 4: Add the route**

```ts
import { pickOrderFields } from './writes.js'

app.patch('/api/merchants/:id/orders/:orderId', requireMerchantOwns, async (c) => {
  const id = c.req.param('id'); const orderId = c.req.param('orderId')
  const patch = pickOrderFields(await c.req.json().catch(() => ({})))
  if ('status' in patch && !ORDER_STATUSES.includes(patch.status as string)) return c.json({ error: 'Invalid status' }, 400)
  if (Object.keys(patch).length === 0) return c.json({ error: 'No updatable fields' }, 400)
  const { data: existing } = await admin.from('orders').select('merchant_id').eq('id', orderId).maybeSingle()
  if (!existing || existing.merchant_id !== id) return c.json({ error: 'Not found' }, 404)
  const { data, error } = await admin.from('orders').update(patch).eq('id', orderId).select().single()
  if (error) return c.json({ error: 'Update failed' }, 500)
  return c.json(data)
})
```

(Import `ORDER_STATUSES` from `writes.js` alongside `pickOrderFields`; `pickOrderFields` already applies the empty→null coercions so the handler body stays thin.)

- [ ] **Step 5: Rewrite `store.ts`** (each keeps its signature + returns the row; all three gain a `merchantId` param OR read it from the order — decide by call site)

Check `OrdersView.tsx`: the handlers have `order`/`selected` (an `Order`) and `merchant` in scope. If `Order` carries `merchant_id`, thread it from the object and keep the `(orderId, ...)` signatures by passing the whole order — but the current signatures take `orderId: string`. Cleanest, preserving Global Constraint 3's "callers untouched" as far as possible: add a trailing `merchantId` param to each.

```ts
export async function setOrderStatus(orderId: string, status: string, merchantId: string) {
  if (!ORDER_STATUSES.includes(status)) throw new Error('Invalid status')
  return apiSend<any>(`/api/merchants/${merchantId}/orders/${orderId}`, 'PATCH', { status }, { auth: true })
}
export async function setOrderNote(orderId: string, note: string, merchantId: string) {
  return apiSend<any>(`/api/merchants/${merchantId}/orders/${orderId}`, 'PATCH', { note }, { auth: true })
}
export async function setOrderTracking(orderId: string, courier: string | null, awb: string, merchantId: string) {
  return apiSend<any>(`/api/merchants/${merchantId}/orders/${orderId}`, 'PATCH', { courier, awb }, { auth: true })
}
```

Update the three call sites in `OrdersView.tsx:174,182,193` to pass `merchant.id` (or `order.merchant_id` if `Order` carries it and `merchant` is not in scope — read the component to confirm which is available). `ORDER_STATUSES` stays exported/available in `store.ts` for the client-side guard.

- [ ] **Step 6: Migrate the order-write suites** in `store.test.ts`.

- [ ] **Step 7: Run** backend `test:db writes-orders` + frontend `test` + `typecheck` (catches the new param) → green.

- [ ] **Step 8: Commit** `feat: order PATCH endpoint (status/note/tracking) with tenancy check`

---

## Task 8: merchant secret write endpoint

**Files:**
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/frontend/src/store.ts` (`upsertMerchantSecret`)
- Modify: `apps/frontend/src/store.test.ts`
- Test: `apps/backend/tests/api/writes-secret.test.ts`

**Interfaces:**
- Consumes: `requireMerchantOwns`.
- Produces: `PUT /api/merchants/:id/secret`.

**Context:** `upsertMerchantSecret(merchantId, secret)` (`store.ts:876`) upserts `{ merchant_id, ...secret }` where `secret` is `{ tg_token, tg_chat_id }` (from `ShopSettings.tsx:294`). `merchant_secrets` has restricted grants already; this route forces `merchant_id = :id` and allowlists `tg_token`/`tg_chat_id`. The GET side (`/api/merchants/:id/secret`) already exists from Phase A — mirror its guard.

- [ ] **Step 1: Write failing test** (`writes-secret.test.ts`): owner upserts a secret (200, round-trips via the Phase A GET); non-owner 403; anon 401; a second upsert updates rather than duplicates.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add the route**

```ts
app.put('/api/merchants/:id/secret', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json().catch(() => ({} as any))
  const row: Record<string, unknown> = { merchant_id: id }
  if (b?.tg_token !== undefined) row.tg_token = b.tg_token
  if (b?.tg_chat_id !== undefined) row.tg_chat_id = b.tg_chat_id
  const { error } = await admin.from('merchant_secrets').upsert(row)
  if (error) return c.json({ error: 'Upsert failed' }, 500)
  return c.json({ ok: true })
})
```

(Confirm `merchant_secrets` upsert conflict target is `merchant_id` — check the table's PK/unique in the migration; if the conflict column differs, pass `{ onConflict: '<col>' }`.)

- [ ] **Step 4: Rewrite `store.ts`**

```ts
export async function upsertMerchantSecret(merchantId: string, secret: any) {
  await apiSend(`/api/merchants/${merchantId}/secret`, 'PUT', secret, { auth: true })
}
```

- [ ] **Step 5: Migrate the secret write suite** in `store.test.ts`.

- [ ] **Step 6: Run** backend `test:db writes-secret` + frontend `test` → green.

- [ ] **Step 7: Commit** `feat: merchant secret upsert endpoint`

---

## Task 9: terminal `REVOKE ALL` migration + RLS backstop test + cleanup

**Files:**
- Create: `apps/backend/supabase/migrations/20260718130000_revoke_all_browser_grants.sql`
- Create: `apps/backend/tests/rls/revoke-writes.test.ts`
- Modify: `apps/frontend/package.json` (drop `pinyin-pro` if no client code imports it anymore — verify first)
- Modify: possibly delete `apps/frontend/src/slug.ts`'s now-dead `resolveSlug`/`toSlugBase` (keep `RESERVED_SLUGS`, `slugify` if still used)

**Context:** All writes now go through the backend; the browser needs zero table grants. This migration revokes everything from `anon` and `authenticated`. **This MUST run only after Tasks 2-8 are merged** — revoking earlier breaks any not-yet-migrated write. RLS policies and guard triggers are NOT dropped (backstop per Global Constraint 5). `merchant_billing` SELECT was already revoked in Phase A; `REVOKE ALL` on it again is a harmless no-op.

- [ ] **Step 1: Write the migration**

```sql
-- 20260718130000_revoke_all_browser_grants.sql
-- Phase B terminal step: the browser now reaches every table only through the backend API.
-- Revoke all direct grants from the anon/authenticated roles. RLS policies and the guard
-- triggers stay in place as defense-in-depth (see CLAUDE.md → Backend). supabase.auth (GoTrue)
-- and storage grants are untouched — those are not table grants.
revoke all on public.orders, public.products, public.vouchers, public.merchants,
  public.profiles, public.merchant_secrets, public.merchant_billing, public.settings,
  public.order_counters
  from anon, authenticated;
```

**Before finalizing the table list:** run `\dp public.*` (or read the init migration's GRANTs) to enumerate every table `anon`/`authenticated` currently hold a grant on, and revoke each. Include `settings`, `order_counters` and any other tenant table that had a browser grant. Do NOT revoke on `auth.*` or `storage.*` schemas.

- [ ] **Step 2: Apply it** — `pnpm --filter @bitetime/backend db:migrate`.

- [ ] **Step 3: Write the backstop test**

```ts
// apps/backend/tests/rls/revoke-writes.test.ts
// After the revoke, an authenticated browser client cannot write ANY table directly.
// Uses the merchant owner as the fixture (RLS would otherwise allow their own rows) so the
// denial can only come from the table-level REVOKE — grants are checked before RLS.
import { describe, it, expect } from 'vitest'
import { makeUser, seedMerchant, serviceClient } from './helpers.js'

const PERMISSION_DENIED = '42501'

describe('browser roles hold no table grants after Phase B', () => {
  it('denies an authenticated owner a direct UPDATE on their own merchant', async () => {
    const owner = await makeUser('revoke-owner@example.com', 'password123')
    const { data: s } = await owner.auth.getSession()
    const id = await seedMerchant({ slug: 'revoke-shop', owner_id: s.session!.user.id })
    const { error } = await owner.from('merchants').update({ name: 'hacked' }).eq('id', id)
    expect(error).not.toBeNull()
    expect(error?.code === PERMISSION_DENIED || error?.message.toLowerCase().includes('permission denied')).toBe(true)
  })

  it('denies an authenticated INSERT on products', async () => {
    const owner = await makeUser('revoke-prod@example.com', 'password123')
    const { data: s } = await owner.auth.getSession()
    const id = await seedMerchant({ slug: 'revoke-prod-shop', owner_id: s.session!.user.id })
    const { error } = await owner.from('products').insert({ merchant_id: id, name: 'x', price: 1, unit: 'pcs' })
    expect(error).not.toBeNull()
    expect(error?.code === PERMISSION_DENIED || error?.message.toLowerCase().includes('permission denied')).toBe(true)
  })
})
```

Add one case per revoked table if cheap; at minimum cover `merchants` (UPDATE) and `products` (INSERT), which are the highest-value escalation targets. Use the owner fixture pattern (grants are checked before RLS, so the owner — whom RLS would permit — is the discriminating fixture, exactly as `billing-grant.test.ts` established in Phase A).

- [ ] **Step 4: Frontend cleanup** — grep the frontend for `pinyin-pro`, `resolveSlug`, `toSlugBase`, `listTakenSlugs`, `globalProfileId`. Delete whatever is now unreferenced. If nothing imports `pinyin-pro` in the frontend anymore, remove it from `apps/frontend/package.json` and re-run `pnpm install`. Keep `RESERVED_SLUGS`/`slugify` if `fetchMerchantBySlug`/`updateMerchantSlug` still use them. Run `pnpm lint` — it will flag any dead import left behind.

- [ ] **Step 5: Run the full DB suite** — `pnpm --filter @bitetime/backend test:db` (all green, including the Phase A `billing-grant` test still passing and the new `revoke-writes`).

- [ ] **Step 6: Run every gate** — `pnpm test` (frontend + backend unit + shared), `pnpm --filter @bitetime/backend test:db`, `pnpm lint`, `pnpm typecheck`. All green.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(db): revoke all browser table grants; RLS/triggers remain backstop"
```

---

## Task 10: run-and-verify (browser) — full dashboard write path

**Files:** none (verification only). Follow the `verify` skill.

**Context:** `CLAUDE.md`: UI is verified by running the app. Prove the whole merchant dashboard writes through the API with zero direct `supabase.from` writes, and that tenancy holds.

- [ ] **Step 1: Bring up the stack** — local Supabase (already running), `pnpm --filter @bitetime/backend dev` (:8787, confirm it serves the new routes — `curl -i localhost:8787/api/merchants -X POST` → 401), `pnpm --filter @bitetime/frontend dev` (**must land on :5173** — the backend CORS allow-list is `:5173`; kill any stale server holding the port first, per the Phase A env gotcha).

- [ ] **Step 2: Drive the dashboard** (browser MCP) as a signed-in merchant owner: create a shop (signup → `createMerchant`), edit shop config (`ShopSettings`), add/edit/delete a product (`ProductsManager`), create/delete a voucher (`VouchersManager`), change an order's status + set tracking (`OrdersView`), save a Telegram secret. Each should succeed.

- [ ] **Step 3: Confirm via the network panel** every mutation hit `localhost:8787/api/...` and there were **zero** `…/rest/v1/…` writes. Confirm CORS is clean.

- [ ] **Step 4: Confirm tenancy in SQL** — the created rows carry the right `merchant_id`; a second owner's dashboard shows none of the first's data. Assert order/product attribution in `psql`, never in the UI.

- [ ] **Step 5: Record the result** in the SDD ledger — servers, seed, findings — and stop the dev servers (leave local Supabase running).

---

## Notes for the executor

- **Test helpers:** Phase A created `apps/backend/tests/api/helpers.ts` and `apps/backend/tests/rls/helpers.js`. Read them first and reuse their exact exports (`makeUser`, `authHeader`, `seedMerchant`, `serviceClient`, `anonClient`) — the snippets above assume plausible names; reconcile before writing tests.
- **Route ordering in `app.ts`:** Hono matches in registration order. `POST /api/merchants` must not be shadowed by any `:slug`/`:id` GET (different method, so safe) — but keep the new write routes grouped with their read siblings for readability.
- **`app.ts` stays side-effect-free at import** (the `app.request()` test seam depends on it) — add routes only, no top-level I/O.
- Allowlist column names in `writes.ts` are drafts — **every one must be reconciled against the real call sites and table migrations** before the task's tests are trusted. The tests that assert forbidden columns are ignored are the ones that make the allowlist safe; keep them.
