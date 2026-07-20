# Merchant Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant send platform feedback from a floating button in their dashboard, and let a superadmin read and triage it in `/admin`.

**Architecture:** One new table (`merchant_feedback`) with no browser grants; three backend routes on the service-role client (submit, list, toggle status); a FAB + dialog rendered by `Dashboard.tsx`; a list section in `AdminHome`. The category list and message-length cap live in `@bitetime/shared` because the browser form and the server check must agree on them.

**Tech Stack:** Postgres (Supabase migrations), Hono + `supabase-js` service-role client, React 19 + shadcn/ui (`dialog`, `select`, `textarea`, `button`, `card`, `badge`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-20-merchant-feedback-design.md`

## Global Constraints

- Every user-visible string is passed as `t(english, chinese)` — no i18n library, no bare English in JSX.
- Backend writes go through the **service-role `admin` client, which is RLS-exempt**. The middleware (`requireMerchantOwns` / `requireSuperadmin`) **is** the tenant boundary; nothing downstream re-checks. Never trust `merchant_id`, `user_id`, or `status` from a request body.
- The browser holds **zero table grants**. All access is via the backend API — never `supabase.from('merchant_feedback')` in frontend code.
- Adding a migration file does not apply it. Run `pnpm --filter @bitetime/backend db:migrate` or PostgREST's schema cache will not see the table.
- Backend relative imports keep `.js` specifiers that resolve to `.ts` source — leave them as `.js`. Frontend uses extensionless relative imports.
- Never mock the database in `tests/api` or `tests/rls`.
- Category values: exactly `bug`, `feature`, `billing`, `other`. Status values: exactly `open`, `resolved`. Message cap: **2000** characters after trimming.

## Two deliberate deviations from the spec

1. **No `pickFeedback()` in `writes.ts`.** `validateFeedback()` builds its result object field by field from scratch, so it is already a stronger allowlist than a pick helper — an unknown key cannot survive it. Adding a second helper would be duplicate machinery.
2. **`validateFeedback()` lives in `@bitetime/shared`, not `apps/backend/tests/unit/`.** The browser form and the server enforce the same two rules (known category, 1–2000 chars). That is exactly the `MIN_PASSWORD_LENGTH` precedent in `packages/shared`. Its unit tests live beside it and run under the root `pnpm test`.

---

### Task 1: The `merchant_feedback` table

**Files:**
- Create: `apps/backend/supabase/migrations/20260720120000_merchant_feedback.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `public.merchant_feedback` with columns `id uuid`, `merchant_id uuid`, `user_id uuid`, `category text`, `message text`, `status text`, `created_at timestamptz`, `resolved_at timestamptz`. Tasks 3 and 4 read and write it.

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260720120000_merchant_feedback.sql`:

```sql
-- Merchant feedback about the PLATFORM (#89) — not customer reviews of a shop.
--
-- Written by a shop owner through POST /api/merchants/:id/feedback and read/triaged by a
-- superadmin. Like merchant_billing and referral_rewards, the browser never touches this
-- table: it holds no grants (20260718130000_revoke_all_browser_grants.sql closed every
-- browser grant in this schema, and nothing here reopens one), so RLS is enabled with NO
-- policies. Postgres checks table privileges before RLS, so the withheld grant is what
-- actually shuts the door; policy-less RLS is the belt for anything that reopens a grant
-- by accident.
--
-- The message bounds are duplicated in @bitetime/shared (validateFeedback) so the browser
-- can show a counter and the server can refuse. This CHECK is the authority; the shared
-- rule exists so a merchant is told before they submit, not after.

create table if not exists public.merchant_feedback (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid not null references public.merchants (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  category     text not null check (category in ('bug', 'feature', 'billing', 'other')),
  message      text not null check (char_length(btrim(message)) between 1 and 2000),
  status       text not null default 'open' check (status in ('open', 'resolved')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

-- The admin list's only sort: newest-first, optionally filtered to open.
create index if not exists merchant_feedback_triage_idx
  on public.merchant_feedback (status, created_at desc);

create index if not exists merchant_feedback_merchant_idx
  on public.merchant_feedback (merchant_id);

alter table public.merchant_feedback enable row level security;

revoke all on table public.merchant_feedback from anon, authenticated;
grant select, insert, update on table public.merchant_feedback to service_role;
```

- [ ] **Step 2: Apply it**

Run from the repo root (a local Supabase must be running — `cd apps/backend && supabase start`):

```bash
pnpm --filter @bitetime/backend db:migrate
```

Expected: the migration is listed as applied, no error.

- [ ] **Step 3: Verify the table and its constraints exist**

```bash
cd apps/backend && psql "$(supabase status -o env | grep '^DB_URL=' | cut -d= -f2- | tr -d '"')" \
  -c "\d public.merchant_feedback"
```

Expected output contains: the eight columns above, `merchant_feedback_triage_idx`, `merchant_feedback_merchant_idx`, both foreign keys, and three CHECK constraints. `Row Security Policies` shows RLS enabled with no policies.

- [ ] **Step 4: Verify the browser role cannot touch it**

```bash
cd apps/backend && psql "$(supabase status -o env | grep '^DB_URL=' | cut -d= -f2- | tr -d '"')" \
  -c "select grantee, privilege_type from information_schema.role_table_grants
      where table_name = 'merchant_feedback' and grantee in ('anon','authenticated');"
```

Expected: `(0 rows)`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/supabase/migrations/20260720120000_merchant_feedback.sql
git commit -m "feat(feedback): add merchant_feedback table (#89)"
```

---

### Task 2: Shared validation rules

**Files:**
- Create: `packages/shared/src/feedback.ts`
- Create: `packages/shared/src/feedback.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `@bitetime/shared`:
  - `FEEDBACK_CATEGORIES: readonly ['bug', 'feature', 'billing', 'other']`
  - `FEEDBACK_STATUSES: readonly ['open', 'resolved']`
  - `FEEDBACK_MAX_LENGTH: 2000`
  - `type FeedbackCategory = 'bug' | 'feature' | 'billing' | 'other'`
  - `type FeedbackStatus = 'open' | 'resolved'`
  - `interface FeedbackDraft { category: FeedbackCategory; message: string }`
  - `validateFeedback(body: unknown): { ok: true; value: FeedbackDraft } | { ok: false; error: string }`
  - `isFeedbackStatus(value: unknown): value is FeedbackStatus`

  Task 3 uses `validateFeedback` and `isFeedbackStatus`; Tasks 6 and 7 use the constants and types.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/feedback.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateFeedback, isFeedbackStatus, FEEDBACK_MAX_LENGTH } from './feedback.js'

describe('validateFeedback', () => {
  it('accepts a known category and a trimmed message', () => {
    const result = validateFeedback({ category: 'bug', message: '  the order list is empty  ' })
    expect(result).toEqual({ ok: true, value: { category: 'bug', message: 'the order list is empty' } })
  })

  it('rejects an unknown category', () => {
    const result = validateFeedback({ category: 'complaint', message: 'hello' })
    expect(result.ok).toBe(false)
  })

  it('rejects a missing category', () => {
    expect(validateFeedback({ message: 'hello' }).ok).toBe(false)
  })

  it('rejects a non-string message', () => {
    expect(validateFeedback({ category: 'other', message: 42 }).ok).toBe(false)
  })

  it('rejects a whitespace-only message', () => {
    expect(validateFeedback({ category: 'other', message: '   \n  ' }).ok).toBe(false)
  })

  it(`rejects a message longer than ${FEEDBACK_MAX_LENGTH} characters`, () => {
    const tooLong = 'x'.repeat(FEEDBACK_MAX_LENGTH + 1)
    expect(validateFeedback({ category: 'other', message: tooLong }).ok).toBe(false)
  })

  it('accepts a message of exactly the maximum length', () => {
    const atLimit = 'x'.repeat(FEEDBACK_MAX_LENGTH)
    expect(validateFeedback({ category: 'other', message: atLimit }).ok).toBe(true)
  })

  it('drops any extra keys — it builds its result rather than spreading the body', () => {
    const result = validateFeedback({
      category: 'billing', message: 'charged twice',
      status: 'resolved', merchant_id: 'someone-elses-shop', user_id: 'someone-else',
    })
    expect(result).toEqual({ ok: true, value: { category: 'billing', message: 'charged twice' } })
  })

  it('rejects a null or non-object body without throwing', () => {
    expect(validateFeedback(null).ok).toBe(false)
    expect(validateFeedback('nope').ok).toBe(false)
    expect(validateFeedback(undefined).ok).toBe(false)
  })
})

describe('isFeedbackStatus', () => {
  it('accepts the two real statuses', () => {
    expect(isFeedbackStatus('open')).toBe(true)
    expect(isFeedbackStatus('resolved')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isFeedbackStatus('closed')).toBe(false)
    expect(isFeedbackStatus(undefined)).toBe(false)
    expect(isFeedbackStatus(1)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @bitetime/shared test
```

Expected: FAIL — `Failed to resolve import "./feedback.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/feedback.ts`:

```ts
// Merchant platform-feedback rules (#89). Shared because both sides enforce them: the
// dashboard form disables submit and shows a counter, the backend refuses. A merchant
// should be told their message is too long before they lose it to a 400.
//
// The database CHECK constraints in 20260720120000_merchant_feedback.sql are the final
// authority. These rules exist to keep the browser and the server from disagreeing about
// what the database will accept.

export const FEEDBACK_CATEGORIES = ['bug', 'feature', 'billing', 'other'] as const
export const FEEDBACK_STATUSES = ['open', 'resolved'] as const
export const FEEDBACK_MAX_LENGTH = 2000

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export interface FeedbackDraft {
  category: FeedbackCategory
  message: string
}

export type FeedbackValidation =
  | { ok: true; value: FeedbackDraft }
  | { ok: false; error: string }

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return typeof value === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(value)
}

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value)
}

/**
 * Validates a feedback submission and returns a clean draft.
 *
 * This is also the write allowlist. It BUILDS its result field by field rather than
 * spreading the body, so a caller cannot smuggle `status`, `merchant_id` or `user_id`
 * through it — the backend forces all three itself. Never bypass this and insert a raw body.
 */
export function validateFeedback(body: unknown): FeedbackValidation {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as {
    category?: unknown
    message?: unknown
  }

  if (!isFeedbackCategory(raw.category)) {
    return { ok: false, error: 'Pick a feedback category' }
  }
  if (typeof raw.message !== 'string') {
    return { ok: false, error: 'Feedback message is required' }
  }

  const message = raw.message.trim()
  if (message.length === 0) {
    return { ok: false, error: 'Feedback message is required' }
  }
  if (message.length > FEEDBACK_MAX_LENGTH) {
    return { ok: false, error: `Feedback message must be ${FEEDBACK_MAX_LENGTH} characters or fewer` }
  }

  return { ok: true, value: { category: raw.category, message } }
}
```

- [ ] **Step 4: Export it from the package entry**

In `packages/shared/src/index.ts`, add after the `cart.js` export line:

```ts
export {
  validateFeedback, isFeedbackCategory, isFeedbackStatus,
  FEEDBACK_CATEGORIES, FEEDBACK_STATUSES, FEEDBACK_MAX_LENGTH,
} from './feedback.js'
export type {
  FeedbackCategory, FeedbackStatus, FeedbackDraft, FeedbackValidation,
} from './feedback.js'
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @bitetime/shared test
```

Expected: PASS — 11 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/feedback.ts packages/shared/src/feedback.test.ts packages/shared/src/index.ts
git commit -m "feat(feedback): share category and length rules across the wire (#89)"
```

---

### Task 3: Backend data access + the three routes

**Files:**
- Create: `apps/backend/src/feedback.ts`
- Modify: `apps/backend/src/app.ts` (imports near line 24–37; new routes after the referral routes, ~line 700)
- Test: `apps/backend/tests/api/feedback.test.ts`

**Interfaces:**
- Consumes: `validateFeedback`, `isFeedbackStatus`, `FeedbackCategory`, `FeedbackStatus`, `FeedbackDraft` from `@bitetime/shared` (Task 2); the `merchant_feedback` table (Task 1); `requireMerchantOwns`, `requireSuperadmin`, `AppEnv` from `./mw.js`; `createSlidingWindow` from `./rateLimit.js`; `admin` from `./supabase.js`.
- Produces:
  - `insertFeedback(input: { merchantId: string; userId: string; draft: FeedbackDraft }): Promise<FeedbackRow>`
  - `listFeedback(status?: FeedbackStatus): Promise<FeedbackWithShop[]>`
  - `updateFeedbackStatus(id: string, status: FeedbackStatus): Promise<FeedbackRow | null>`
  - `interface FeedbackRow { id, merchant_id, user_id, category, message, status, created_at, resolved_at }`
  - `interface FeedbackWithShop extends FeedbackRow { shop_name: string | null; shop_slug: string | null }`
  - Routes `POST /api/merchants/:id/feedback`, `GET /api/admin/feedback`, `PATCH /api/admin/feedback/:feedbackId`. Tasks 5–7 call these.

- [ ] **Step 1: Write the failing API tests**

Create `apps/backend/tests/api/feedback.test.ts`:

```ts
// tests/api/feedback.test.ts
// Merchant platform feedback (#89), driven in-process.
//
// The load-bearing assertions are the two the service-role client makes possible to get
// wrong: a merchant must not be able to file feedback against a shop they do not own, and
// a body carrying merchant_id / user_id / status must not be believed. admin is RLS-exempt,
// so requireMerchantOwns and the field-by-field build in validateFeedback are the ONLY
// things standing between a merchant and another shop's record. See CLAUDE.md → Backend.
import { describe, it, expect, beforeAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

function post(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

function get(path: string, token?: string) {
  return app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

function patch(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

type FeedbackRow = {
  id: string; merchant_id: string; user_id: string
  category: string; message: string; status: string; resolved_at: string | null
}

describe('merchant feedback', () => {
  let ownerToken: string
  let ownerId: string
  let ownShopId: string
  let strangerShopId: string
  let superToken: string

  beforeAll(async () => {
    await resetMerchant('feedback-own-shop')
    await resetMerchant('feedback-stranger-shop')

    const owner = await makeUser('feedback-owner@example.com', 'password123')
    const owned = await tokenOf(owner)
    ownerToken = owned.token
    ownerId = owned.userId
    ownShopId = await seedMerchant({ slug: 'feedback-own-shop', owner_id: ownerId })

    const stranger = await makeUser('feedback-stranger@example.com', 'password123')
    const strangerIds = await tokenOf(stranger)
    strangerShopId = await seedMerchant({ slug: 'feedback-stranger-shop', owner_id: strangerIds.userId })

    const superClient = await makeUser('feedback-super@example.com', 'password123')
    const superIds = await tokenOf(superClient)
    const svc = serviceClient()
    await svc.from('profiles').delete().eq('user_id', superIds.userId)
    await svc.from('profiles').insert({ user_id: superIds.userId, name: 'Super', app_role: 'superadmin' })
    superToken = superIds.token
  })

  it('stores feedback for the shop the caller owns', async () => {
    const res = await post(`/api/merchants/${ownShopId}/feedback`, {
      category: 'bug', message: '  the orders tab is blank on mobile  ',
    }, ownerToken)

    expect(res.status).toBe(201)
    const row = (await res.json()) as FeedbackRow
    expect(row.merchant_id).toBe(ownShopId)
    expect(row.user_id).toBe(ownerId)
    expect(row.category).toBe('bug')
    expect(row.message).toBe('the orders tab is blank on mobile')
    expect(row.status).toBe('open')
    expect(row.resolved_at).toBeNull()
  })

  it('refuses feedback filed against a shop the caller does not own', async () => {
    const res = await post(`/api/merchants/${strangerShopId}/feedback`, {
      category: 'other', message: 'not my shop',
    }, ownerToken)
    expect(res.status).toBe(403)
  })

  it('rejects an anonymous submission with 401', async () => {
    const res = await post(`/api/merchants/${ownShopId}/feedback`, { category: 'other', message: 'hi' })
    expect(res.status).toBe(401)
  })

  it('ignores merchant_id, user_id and status supplied in the body', async () => {
    const res = await post(`/api/merchants/${ownShopId}/feedback`, {
      category: 'billing', message: 'charged twice',
      merchant_id: strangerShopId, user_id: '00000000-0000-0000-0000-000000000000',
      status: 'resolved',
    }, ownerToken)

    expect(res.status).toBe(201)
    const row = (await res.json()) as FeedbackRow
    expect(row.merchant_id).toBe(ownShopId)
    expect(row.user_id).toBe(ownerId)
    expect(row.status).toBe('open')
  })

  it('400s on an unknown category and on an empty message', async () => {
    expect((await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'complaint', message: 'hello' }, ownerToken)).status).toBe(400)
    expect((await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'other', message: '   ' }, ownerToken)).status).toBe(400)
  })

  it('lists feedback newest-first to a superadmin, with the shop attached', async () => {
    const res = await get('/api/admin/feedback', superToken)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<FeedbackRow & { shop_slug: string | null }>
    const mine = rows.filter(r => r.merchant_id === ownShopId)
    expect(mine.length).toBeGreaterThanOrEqual(2)
    expect(mine[0]!.shop_slug).toBe('feedback-own-shop')
  })

  it('refuses the admin list to a merchant and to an anonymous caller', async () => {
    expect((await get('/api/admin/feedback', ownerToken)).status).toBe(403)
    expect((await get('/api/admin/feedback')).status).toBe(401)
  })

  it('resolves and reopens, stamping and clearing resolved_at', async () => {
    const created = await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'feature', message: 'export orders to csv' }, ownerToken)
    const { id } = (await created.json()) as FeedbackRow

    const resolved = await patch(`/api/admin/feedback/${id}`, { status: 'resolved' }, superToken)
    expect(resolved.status).toBe(200)
    const resolvedRow = (await resolved.json()) as FeedbackRow
    expect(resolvedRow.status).toBe('resolved')
    expect(resolvedRow.resolved_at).not.toBeNull()

    const reopened = await patch(`/api/admin/feedback/${id}`, { status: 'open' }, superToken)
    const reopenedRow = (await reopened.json()) as FeedbackRow
    expect(reopenedRow.status).toBe('open')
    expect(reopenedRow.resolved_at).toBeNull()
  })

  it('filters the list to open only', async () => {
    const res = await get('/api/admin/feedback?status=open', superToken)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as FeedbackRow[]
    expect(rows.every(r => r.status === 'open')).toBe(true)
  })

  it('400s on an unknown status, both as a filter and as an update', async () => {
    expect((await get('/api/admin/feedback?status=closed', superToken)).status).toBe(400)
    const created = await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'other', message: 'status check' }, ownerToken)
    const { id } = (await created.json()) as FeedbackRow
    expect((await patch(`/api/admin/feedback/${id}`, { status: 'closed' }, superToken)).status).toBe(400)
  })

  it('404s when resolving feedback that does not exist', async () => {
    const res = await patch('/api/admin/feedback/00000000-0000-0000-0000-000000000000',
      { status: 'resolved' }, superToken)
    expect(res.status).toBe(404)
  })

  it('refuses a status change from a merchant', async () => {
    const created = await post(`/api/merchants/${ownShopId}/feedback`,
      { category: 'other', message: 'merchant cannot resolve this' }, ownerToken)
    const { id } = (await created.json()) as FeedbackRow
    expect((await patch(`/api/admin/feedback/${id}`, { status: 'resolved' }, ownerToken)).status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

A local Supabase must be running (`cd apps/backend && supabase start`).

```bash
pnpm --filter @bitetime/backend test:db -- feedback
```

Expected: FAIL — every request returns 404 because the routes do not exist yet.

- [ ] **Step 3: Write the data-access module**

Create `apps/backend/src/feedback.ts`:

```ts
// Merchant platform feedback (#89) — data access.
//
// Every statement here is a single write or read, so this uses the REST `admin` client
// rather than db.ts; no transaction is needed. `admin` is the service-role client and is
// RLS-EXEMPT: the route middleware is the tenant boundary, and insertFeedback takes the
// merchant and user as explicit arguments precisely so a caller cannot supply them.
import { admin } from './supabase.js'
import type { FeedbackCategory, FeedbackStatus, FeedbackDraft } from '@bitetime/shared'

export interface FeedbackRow {
  id: string
  merchant_id: string
  user_id: string
  category: FeedbackCategory
  message: string
  status: FeedbackStatus
  created_at: string
  resolved_at: string | null
}

export interface FeedbackWithShop extends FeedbackRow {
  shop_name: string | null
  shop_slug: string | null
}

export async function insertFeedback(input: {
  merchantId: string
  userId: string
  draft: FeedbackDraft
}): Promise<FeedbackRow> {
  const { data, error } = await admin
    .from('merchant_feedback')
    .insert({
      merchant_id: input.merchantId,
      user_id: input.userId,
      category: input.draft.category,
      message: input.draft.message,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data as FeedbackRow
}

export async function listFeedback(status?: FeedbackStatus): Promise<FeedbackWithShop[]> {
  let query = admin
    .from('merchant_feedback')
    .select('*, merchants(name, slug)')
    .order('created_at', { ascending: false })
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  return (data ?? []).map((row: any) => {
    const { merchants, ...rest } = row
    return { ...rest, shop_name: merchants?.name ?? null, shop_slug: merchants?.slug ?? null }
  })
}

// Reopening clears resolved_at so the column never claims a resolution that was undone.
export async function updateFeedbackStatus(
  id: string,
  status: FeedbackStatus,
): Promise<FeedbackRow | null> {
  const { data, error } = await admin
    .from('merchant_feedback')
    .update({ status, resolved_at: status === 'resolved' ? new Date().toISOString() : null })
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as FeedbackRow) ?? null
}
```

- [ ] **Step 4: Wire the routes into `app.ts`**

In `apps/backend/src/app.ts`, add to the imports (beside the other local imports, ~line 24–37):

```ts
import { insertFeedback, listFeedback, updateFeedbackStatus } from './feedback.js'
```

and extend the existing `@bitetime/shared` import on line 33 from `import { isCart } from '@bitetime/shared'` to:

```ts
import { isCart, validateFeedback, isFeedbackStatus } from '@bitetime/shared'
```

Then add the routes after the referral routes (`app.get('/api/referrals/rewards', …)`, ~line 700):

```ts
// ── Merchant platform feedback (#89) ────────────────────────────────────────────
// Per-user, not per-IP: the route is authenticated, so the user id is the real actor and
// is not spoofable behind a shared NAT the way an IP is. The check runs BEFORE validation
// so a script cannot hammer the write path with malformed bodies for free; a merchant
// cannot realistically hit twenty submissions an hour by accident, and the form enforces
// both rules client-side, so a 400 arriving here is already the abnormal case.
const feedbackWindow = createSlidingWindow({ limit: 20, windowMs: 60 * 60_000, now: () => Date.now() })

app.post('/api/merchants/:id/feedback', requireMerchantOwns, async (c) => {
  const user = c.get('user')
  const merchant = c.get('merchant')

  if (!feedbackWindow.allow(user.id)) {
    return c.json({ error: 'Too many feedback submissions. Please try again later.' }, 429)
  }

  const parsed = validateFeedback(await c.req.json().catch(() => ({})))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  // merchant.id comes from the route the middleware already verified; user.id from the
  // JWT. Neither is ever read from the body — see tests/api/feedback.test.ts.
  const row = await insertFeedback({ merchantId: merchant.id, userId: user.id, draft: parsed.value })
  return c.json(row, 201)
})

app.get('/api/admin/feedback', requireSuperadmin, async (c) => {
  const status = c.req.query('status')
  if (status !== undefined && !isFeedbackStatus(status)) {
    return c.json({ error: 'Unknown feedback status' }, 400)
  }
  return c.json(await listFeedback(status))
})

app.patch('/api/admin/feedback/:feedbackId', requireSuperadmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown }
  if (!isFeedbackStatus(body.status)) return c.json({ error: 'Unknown feedback status' }, 400)

  const row = await updateFeedbackStatus(c.req.param('feedbackId'), body.status)
  if (!row) return c.json({ error: 'Feedback not found' }, 404)
  return c.json(row)
})
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @bitetime/backend test:db -- feedback
```

Expected: PASS — 12 tests.

Note: the suite files seven submissions as the same owner, which is why the window is 20/hour and not 5 — at 5 the sixth submission would 429 and two later tests would fail for a reason that has nothing to do with what they assert. If the limit ever trips this suite again, raise it or split the owner across users; never delete the assertion.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add apps/backend/src/feedback.ts apps/backend/src/app.ts apps/backend/tests/api/feedback.test.ts
git commit -m "feat(feedback): submit, list and triage endpoints (#89)"
```

---

### Task 4: Frontend types and store functions

**Files:**
- Modify: `apps/frontend/src/types.ts` (append)
- Modify: `apps/frontend/src/store.ts` (append)

**Interfaces:**
- Consumes: the routes from Task 3; `apiGet` / `apiSend` from `./api`; `FeedbackCategory`, `FeedbackStatus`, `FeedbackDraft` from `@bitetime/shared`.
- Produces:
  - `interface FeedbackItem` in `types.ts`
  - `submitFeedback(merchantId: string, draft: FeedbackDraft): Promise<void>` — returns nothing on purpose: the POST responds with a bare row that has no `shop_name` / `shop_slug`, so typing it as `FeedbackItem` would be a lie the compiler could not catch across the network boundary. No caller needs the row.
  - `fetchAdminFeedback(status?: FeedbackStatus): Promise<FeedbackItem[]>`
  - `setFeedbackStatus(id: string, status: FeedbackStatus): Promise<FeedbackItem>`

  Task 5 uses `submitFeedback`; Task 6 uses the other two.

- [ ] **Step 1: Add the row type**

Append to `apps/frontend/src/types.ts`:

```ts
// One row of merchant platform feedback (#89). shop_name / shop_slug are joined in by the
// admin list endpoint and are null for a shop that has since been deleted.
export interface FeedbackItem {
  id: string
  merchant_id: string
  user_id: string
  category: FeedbackCategory
  message: string
  status: FeedbackStatus
  created_at: string
  resolved_at: string | null
  shop_name: string | null
  shop_slug: string | null
}
```

and add the import at the top of `types.ts`:

```ts
import type { FeedbackCategory, FeedbackStatus } from '@bitetime/shared'
```

- [ ] **Step 2: Add the store functions**

Append to `apps/frontend/src/store.ts`:

```ts
// ── Merchant platform feedback (#89) ────────────────────────────────────────────
// merchantId scopes the route; the backend re-derives ownership from the bearer token
// and ignores anything else in the body, so there is nothing else to send.
//
// Returns nothing: the POST responds with a bare merchant_feedback row, which is NOT a
// FeedbackItem — it carries no shop_name / shop_slug, and only the admin list joins those
// in. Claiming the richer type here would be a cast the compiler cannot check. Throws on
// failure (apiSend's contract), which is what the form renders.
export async function submitFeedback(merchantId: string, draft: FeedbackDraft): Promise<void> {
  await apiSend<unknown>(`/api/merchants/${merchantId}/feedback`, 'POST', draft, { auth: true })
}

export async function fetchAdminFeedback(status?: FeedbackStatus): Promise<FeedbackItem[]> {
  const qs = status ? `?status=${status}` : ''
  return apiGet<FeedbackItem[]>(`/api/admin/feedback${qs}`, { auth: true })
}

export async function setFeedbackStatus(id: string, status: FeedbackStatus): Promise<FeedbackItem> {
  return apiSend<FeedbackItem>(`/api/admin/feedback/${id}`, 'PATCH', { status }, { auth: true })
}
```

Add `FeedbackItem` to the existing `./types` type import in `store.ts`, and add:

```ts
import type { FeedbackDraft, FeedbackStatus } from '@bitetime/shared'
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/types.ts apps/frontend/src/store.ts
git commit -m "feat(feedback): client calls for submit, list and triage (#89)"
```

---

### Task 5: The merchant FAB and dialog

**Files:**
- Create: `apps/frontend/src/merchant/FeedbackFab.tsx`
- Modify: `apps/frontend/src/merchant/Dashboard.tsx`

**Interfaces:**
- Consumes: `submitFeedback` (Task 4); `FEEDBACK_CATEGORIES`, `FEEDBACK_MAX_LENGTH`, `FeedbackCategory` (Task 2); `useSession` for `t` and `merchant`; shadcn `Dialog`, `Select`, `Textarea`, `Button` from `../components/ui/*`.
- Produces: default-exported `<FeedbackFab />`, taking no props. Task 7 verifies it in the browser.

- [ ] **Step 1: Write the component**

Create `apps/frontend/src/merchant/FeedbackFab.tsx`:

```tsx
import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { FEEDBACK_CATEGORIES, FEEDBACK_MAX_LENGTH, type FeedbackCategory } from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { submitFeedback } from '../store'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Textarea } from '../components/ui/textarea'
import { Button } from '../components/ui/button'
import { cn } from '@/lib/utils'

// Bilingual labels for the four categories the backend accepts. Keyed off the shared
// FEEDBACK_CATEGORIES tuple so adding a category there is a type error here until it is
// given a label — the list cannot silently drift out of sync with the server.
const CATEGORY_LABELS: Record<FeedbackCategory, { en: string; zh: string }> = {
  bug:     { en: 'Something is broken', zh: '出现故障' },
  feature: { en: 'Feature request',     zh: '功能建议' },
  billing: { en: 'Billing',             zh: '账单' },
  other:   { en: 'Something else',      zh: '其他' },
}

/**
 * Floating feedback button for the merchant dashboard (#89).
 *
 * Rendered by Dashboard.tsx rather than DashboardShell: the shell is shared with /admin,
 * and a superadmin does not need to send themselves feedback. z-30 keeps it under the
 * shell's mobile drawer backdrop (z-40) and the drawer itself (z-50), so it does not
 * bleed through an open menu; the dialog it opens portals above everything.
 */
export default function FeedbackFab() {
  const { t, merchant } = useSession()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  if (!merchant) return null

  const trimmed = message.trim()
  const tooLong = trimmed.length > FEEDBACK_MAX_LENGTH
  const canSubmit = category !== '' && trimmed.length > 0 && !tooLong && !busy

  // Reset on close so reopening never shows the previous submission's thank-you or error.
  const change = (next: boolean) => {
    setOpen(next)
    if (!next) { setCategory(''); setMessage(''); setError(''); setSent(false); setBusy(false) }
  }

  const send = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      await submitFeedback(merchant.id, { category: category as FeedbackCategory, message: trimmed })
      setSent(true)
      // Let the thank-you land before the dialog goes away.
      setTimeout(() => change(false), 1600)
    } catch (e) {
      // Keep what they typed — losing a long message to a failed request is the worst
      // possible outcome for a feedback form.
      setError(e instanceof Error ? e.message : t('Could not send feedback', '无法发送反馈'))
      setBusy(false)
    }
  }

  const title = t('Send feedback', '发送反馈')

  return (
    <>
      <button
        type="button"
        onClick={() => change(true)}
        aria-label={title}
        title={title}
        className={cn(
          'fixed z-30 bottom-6 right-6 max-sm:bottom-5 max-sm:right-5',
          'flex items-center gap-2 rounded-full px-4 py-3',
          'bg-oxblood text-cream shadow-lg cursor-pointer',
          'transition-colors duration-150 hover:bg-oxblood-deep',
          '[@media(pointer:coarse)]:min-h-[48px]',
        )}
      >
        <MessageSquarePlus size={18} strokeWidth={1.75} />
        <span className="text-[13px] font-sans font-medium max-sm:sr-only">{title}</span>
      </button>

      <Dialog open={open} onOpenChange={change}>
        <DialogContent className="p-6">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {t('Tell us what is working and what is not. We read every message.',
                 '告诉我们哪些好用、哪些不好用。我们会阅读每一条留言。')}
            </DialogDescription>
          </DialogHeader>

          {sent ? (
            <p className="py-6 text-center text-[14px] text-ink">
              {t('Thanks — we got it.', '谢谢，我们已收到。')}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <Select value={category} onValueChange={(v) => setCategory(v as FeedbackCategory)}>
                <SelectTrigger aria-label={t('Category', '类别')}>
                  <SelectValue placeholder={t('Pick a category', '选择类别')} />
                </SelectTrigger>
                <SelectContent>
                  {FEEDBACK_CATEGORIES.map(key => (
                    <SelectItem key={key} value={key}>
                      {t(CATEGORY_LABELS[key].en, CATEGORY_LABELS[key].zh)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div>
                <Textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={6}
                  aria-label={t('Your message', '你的留言')}
                  placeholder={t('What happened, or what would help?', '发生了什么？或者什么能帮到你？')}
                />
                <div className={cn(
                  'mt-1 text-right text-[11px]',
                  tooLong ? 'text-danger-fg' : 'text-text-tertiary',
                )}>
                  {trimmed.length} / {FEEDBACK_MAX_LENGTH}
                </div>
              </div>

              {error && <p className="text-[13px] text-danger-fg">{error}</p>}

              <Button onClick={send} disabled={!canSubmit}>
                {busy ? t('Sending…', '发送中…') : t('Send', '发送')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
```

- [ ] **Step 2: Render it from the dashboard**

In `apps/frontend/src/merchant/Dashboard.tsx`, add the import beside the other merchant imports:

```tsx
import FeedbackFab from './FeedbackFab'
```

and render it inside `DashboardShell`, immediately after the closing `</AnimatePresence>` (line 66):

```tsx
      </AnimatePresence>
      <FeedbackFab />
    </DashboardShell>
```

- [ ] **Step 3: Typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/merchant/FeedbackFab.tsx apps/frontend/src/merchant/Dashboard.tsx
git commit -m "feat(feedback): floating feedback button in the merchant dashboard (#89)"
```

---

### Task 6: The admin feedback section

**Files:**
- Create: `apps/frontend/src/admin/AdminFeedback.tsx`
- Modify: `apps/frontend/src/admin/AdminHome.tsx`

**Interfaces:**
- Consumes: `fetchAdminFeedback`, `setFeedbackStatus` (Task 4); `FeedbackItem` from `../types`; `FeedbackStatus` from `@bitetime/shared`; shadcn `Card`, `Badge`, `Button`.
- Produces: default-exported `<AdminFeedback />`, taking no props, and a `feedback` entry in `AdminHome`'s `SECTIONS`.

- [ ] **Step 1: Write the component**

Create `apps/frontend/src/admin/AdminFeedback.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { FeedbackStatus } from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { fetchAdminFeedback, setFeedbackStatus } from '../store'
import type { FeedbackItem } from '../types'
import { Card } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'

const CATEGORY_LABELS: Record<string, { en: string; zh: string }> = {
  bug:     { en: 'Broken',  zh: '故障' },
  feature: { en: 'Request', zh: '建议' },
  billing: { en: 'Billing', zh: '账单' },
  other:   { en: 'Other',   zh: '其他' },
}

/**
 * The superadmin's feedback inbox (#89). Newest-first, with an open-only filter and one
 * button per row to flip open ↔ resolved. Deliberately not a ticket system: no assignment,
 * no threading, no reply. If it grows one, that is a separate decision.
 */
export default function AdminFeedback() {
  const { t, lang } = useSession()
  const [openOnly, setOpenOnly] = useState(true)
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setItems(await fetchAdminFeedback(openOnly ? 'open' : undefined))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not load feedback', '无法加载反馈'))
    } finally {
      setLoading(false)
    }
  }, [openOnly, t])

  useEffect(() => { void load() }, [load])

  const toggle = async (item: FeedbackItem) => {
    const next: FeedbackStatus = item.status === 'open' ? 'resolved' : 'open'
    try {
      const updated = await setFeedbackStatus(item.id, next)
      // Filtering to open means a resolved row no longer belongs in the list.
      setItems(prev => openOnly && next === 'resolved'
        ? prev.filter(row => row.id !== item.id)
        : prev.map(row => (row.id === item.id ? { ...row, ...updated } : row)))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not update feedback', '无法更新反馈'))
    }
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-MY', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-[20px] text-oxblood">{t('Feedback', '反馈')}</h2>
        <Button variant="outline" size="sm" onClick={() => setOpenOnly(v => !v)}>
          {openOnly ? t('Show all', '显示全部') : t('Show open only', '仅显示未处理')}
        </Button>
      </div>

      {error && <p className="text-[13px] text-danger-fg">{error}</p>}
      {loading && <p className="text-[13px] text-text-tertiary">{t('Loading…', '加载中…')}</p>}

      {!loading && items.length === 0 && (
        <p className="text-[13px] text-text-tertiary">
          {openOnly
            ? t('No open feedback.', '没有未处理的反馈。')
            : t('No feedback yet.', '还没有反馈。')}
        </p>
      )}

      {items.map(item => (
        <Card key={item.id} className="p-4 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-heading text-[15px] text-oxblood">
              {item.shop_name ?? t('Deleted shop', '已删除的店铺')}
            </span>
            {item.shop_slug && (
              <span className="text-[12px] text-text-tertiary">/s/{item.shop_slug}</span>
            )}
            <Badge variant="secondary">
              {t(CATEGORY_LABELS[item.category]?.en ?? item.category,
                 CATEGORY_LABELS[item.category]?.zh ?? item.category)}
            </Badge>
            {item.status === 'resolved' && (
              <Badge variant="outline">{t('Resolved', '已处理')}</Badge>
            )}
            <span className="ml-auto text-[12px] text-text-tertiary">{formatDate(item.created_at)}</span>
          </div>

          <p className="text-[14px] text-ink whitespace-pre-wrap">{item.message}</p>

          <div>
            <Button variant="outline" size="sm" onClick={() => void toggle(item)}>
              {item.status === 'open' ? t('Resolve', '标记已处理') : t('Reopen', '重新打开')}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add the nav section**

In `apps/frontend/src/admin/AdminHome.tsx`:

Change the lucide import on line 5 to include `MessageSquare`:

```tsx
import { LayoutDashboard, Store, MessageSquare } from 'lucide-react'
```

Add the component import beside the others:

```tsx
import AdminFeedback from './AdminFeedback'
```

Add the section to `SECTIONS`:

```tsx
const SECTIONS = [
  { key: 'overview',  en: 'Overview',  zh: '概览', icon: <LayoutDashboard {...ICON} /> },
  { key: 'merchants', en: 'Merchants', zh: '商家', icon: <Store {...ICON} /> },
  { key: 'feedback',  en: 'Feedback',  zh: '反馈', icon: <MessageSquare {...ICON} /> },
]
```

Add the render branch beside the others:

```tsx
          {section === 'feedback'  && <AdminFeedback />}
```

- [ ] **Step 3: Typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/admin/AdminFeedback.tsx apps/frontend/src/admin/AdminHome.tsx
git commit -m "feat(feedback): superadmin feedback inbox with open/resolved toggle (#89)"
```

---

### Task 7: Run-and-verify

Per CLAUDE.md, UI is verified by running the app, not by component tests. The `verify` skill covers this flow.

**Files:** none — verification only.

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: nothing.

- [ ] **Step 1: Run the whole test suite**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all pass.

```bash
pnpm --filter @bitetime/backend test:db
```

Expected: all pass, including `tests/api/feedback.test.ts`.

- [ ] **Step 2: Start the app**

```bash
pnpm dev
```

Frontend on `:5173`, backend on `:8787`.

- [ ] **Step 3: Verify the merchant path**

Sign in as a merchant and open `/merchant`. Confirm:
- The floating button sits bottom-right and is visible on Overview, Orders, Products, Vouchers, Customers and Settings.
- Clicking it opens the dialog. Submit is disabled until a category is picked and a message typed.
- The counter tracks the trimmed length and turns red past 2000.
- Submitting shows the thank-you and the dialog closes itself.
- Reopening the dialog shows an empty form, not the previous thank-you.
- At ≤ 640px the button collapses to the icon, and opening the sidebar drawer covers it rather than letting it bleed through.

- [ ] **Step 4: Verify the admin path**

Sign in as the superadmin and open `/admin`. Confirm:
- A Feedback section appears in the sidebar.
- The submission from Step 3 is listed with the right shop, category badge and date.
- Resolve removes it from the open-only list; Show all brings it back marked Resolved; Reopen returns it to open.

- [ ] **Step 5: Verify the FAB is absent from `/admin`**

Still signed in as the superadmin on `/admin`: confirm there is **no** floating feedback button. It is rendered by `Dashboard.tsx`, not the shared shell.

- [ ] **Step 6: Close the issue**

```bash
gh issue close 89 --repo leongcheefai/Bitetime-Order-Platform \
  --comment "Shipped: merchant_feedback table, submit/list/triage endpoints, dashboard FAB, and the /admin inbox."
```

---

## Deferred (from the spec's "Out of scope")

Merchants viewing their own past submissions. Replies or any email loop back to the merchant. Attachments and screenshots. Star ratings. None is needed to start reading what merchants say; each is additive later.
