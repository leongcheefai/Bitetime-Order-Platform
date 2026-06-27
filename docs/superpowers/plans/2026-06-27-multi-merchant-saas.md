# Multi-Merchant SaaS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert BiteTime from a single-tenant ordering app (hardcoded `OWNER_EMAIL`) into a multi-merchant SaaS where many businesses self-onboard, manage their own products/customers/orders, and serve customers at path-slug storefronts (`/s/:slug`).

**Architecture:** Tenant data is isolated by a `merchant_id` foreign key on every tenant-owned table, enforced at the database boundary with Postgres RLS (app-layer filtering alone is insecure — the anon key is public). All Supabase access stays behind the single data-access seam `src/store.js`, where every function becomes merchant-scoped. A React Router boundary resolves the merchant from the URL slug once and provides it via `MerchantContext`; the monolithic `App.jsx` decomposes along route boundaries. A `role` on the profile (`customer | merchant | superadmin`) replaces the hardcoded owner-email gate.

**Tech Stack:** Vite 8, React 19, `@supabase/supabase-js`, `react-router-dom` (new), `pinyin-pro` (new, slug transliteration), Vitest (new, first test suite in repo), Supabase CLI (local Postgres for RLS integration tests).

## Global Constraints

- React 19.2.x, Vite 8.x — do not downgrade. (from `package.json`)
- All Supabase access goes through `src/store.js` — no `supabase.from(...)` calls in components. (existing convention, CLAUDE.md)
- Every user-facing string uses `t(en, zh)` where `t = (en, zh) => lang === 'zh' ? zh : en`. Bilingual behaviour preserved per-merchant. (CLAUDE.md)
- RLS is mandatory on every tenant table. App-layer `merchant_id` filtering is never the sole isolation mechanism. (PRD)
- Path-slug storefronts only: `/s/:slug`. No subdomains. (PRD)
- One Supabase Auth user per email (Auth is global-by-email); per-merchant customers are realised as one `profiles` row per `(user_id, merchant_id)`. (PRD)
- Manual payment only — each merchant's own payment details render on their storefront. No payment-processor integration. (PRD)
- Fresh start: existing global single-tenant data is NOT migrated. BiteTime re-onboards as the first merchant. (PRD)
- Order numbers: `<merchant.order_prefix>-YYMMDD-NNNN`, per-merchant daily counter. (PRD)
- Slug rules: auto-generated from shop name (latin → slugify; Chinese → pinyin); empty → `shop-<id>`; collisions get numeric suffix; reserved words rejected; editable once before going live, then locked. (PRD)
- Merchant lifecycle: signup → `pending` → super-admin approves → `active` (or `suspended`). (PRD)
- Migrations are forward-only, ordered by timestamp filename, additive on top of the existing baseline in `supabase/migrations/`. (existing repo state)

---

## Phasing Overview

| Phase | Deliverable | Detail level in this doc |
|-------|-------------|--------------------------|
| **P0** | Test infra + multi-tenant schema + RLS + pure slug/order-number functions | **Full bite-sized TDD (execute directly)** |
| P1 | `react-router-dom` + `MerchantContext` + role-based gate replacing `OWNER_EMAIL` | Task decomposition (expand to micro-steps on arrival) |
| P2 | Merchant signup + onboarding (shop name → auto-slug → `pending`) | Task decomposition |
| P3 | Super-admin approval queue (approve / suspend) | Task decomposition |
| P4 | Merchant dashboard — port owner UI, scoped to `merchant_id` | Task decomposition |
| P5 | Customer storefront at `/s/:slug` + per-merchant Telegram/payment | Task decomposition |
| P6 | Root marketing + merchant-signup landing page | Task decomposition |

Each phase produces working, testable software on its own. **Recommendation:** before executing P1–P6, run `writing-plans` again on that single phase to expand its tasks into full step-by-step TDD (with complete component code) — UI steps depend on P0 outcomes and are best detailed once the schema is real.

---

# P0 — Foundations (full TDD)

**Why first:** Nothing else can be built or tested without the test runner, the multi-tenant schema, RLS, and the pure functions (slug + order number) that the onboarding and order flows depend on. P0 ships zero UI but unblocks every later phase and is fully testable in isolation.

**File structure for P0:**
- Create `src/slug.js` — pure slug generation (slugify, transliterate, resolve uniqueness/reserved/fallback). One responsibility: turn a shop name + existing-slug set into a valid unique slug.
- Create `src/orderNumber.js` — pure order-number core (prefix + counter math), separated from the Supabase I/O wrapper.
- Create `src/slug.test.js`, `src/orderNumber.test.js` — Vitest unit tests.
- Create `supabase/migrations/20260627120000_multitenant_schema.sql` — merchants table + `merchant_id` columns + per-merchant counter + roles.
- Create `supabase/migrations/20260627120100_multitenant_rls.sql` — RLS policies + role helper functions.
- Create `tests/rls/isolation.test.js` — RLS integration test against local Supabase.
- Modify `package.json` — add `vitest`, `pinyin-pro`, `test` script.
- Modify `vite.config.js` — add Vitest config (jsdom not needed; node env for pure tests).

---

### Task 0.1: Add Vitest test runner with a smoke test

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Modify: `vite.config.js`
- Create: `src/smoke.test.js`

**Interfaces:**
- Produces: `npm test` runs Vitest once; `npm run test:watch` watches. Test files match `*.test.js`.

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest@^3
```

- [ ] **Step 2: Add test scripts to package.json**

In `package.json` `"scripts"`, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Configure Vitest in vite.config.js**

Add a `test` block to the existing `defineConfig`:

```js
// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'tests/**/*.test.js'],
  },
})
```

- [ ] **Step 4: Write the smoke test**

```js
// src/smoke.test.js
import { describe, it, expect } from 'vitest'

describe('test runner', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npm test`
Expected: PASS, 1 test passed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vite.config.js src/smoke.test.js
git commit -m "test: add Vitest runner with smoke test"
```

---

### Task 0.2: `slugify` — latin shop name to URL slug

**Files:**
- Create: `src/slug.js`
- Create: `src/slug.test.js`

**Interfaces:**
- Produces: `slugify(name: string) => string` — lowercases, replaces non-alphanumeric runs with single hyphens, trims leading/trailing hyphens. Pure, no I/O.

- [ ] **Step 1: Write the failing test**

```js
// src/slug.test.js
import { describe, it, expect } from 'vitest'
import { slugify } from './slug'

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Joe’s Cookie Shop')).toBe('joe-s-cookie-shop')
  })
  it('collapses repeated separators', () => {
    expect(slugify('  Aunt   May -- Bakes ')).toBe('aunt-may-bakes')
  })
  it('returns empty string for non-latin input', () => {
    expect(slugify('点心铺')).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/slug.test.js`
Expected: FAIL — "Failed to resolve import './slug'".

- [ ] **Step 3: Write minimal implementation**

```js
// src/slug.js
export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/slug.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/slug.js src/slug.test.js
git commit -m "feat: add slugify for latin shop names"
```

---

### Task 0.3: Pinyin transliteration for Chinese shop names

**Files:**
- Modify: `src/slug.js`
- Modify: `src/slug.test.js`
- Modify: `package.json` (add `pinyin-pro`)

**Interfaces:**
- Produces: `toSlugBase(name: string) => string` — latin names slugify directly; names containing CJK are transliterated to pinyin (no tone marks) then slugified; returns `''` when nothing usable remains.

- [ ] **Step 1: Install pinyin-pro**

```bash
npm install pinyin-pro@^3
```

- [ ] **Step 2: Write the failing test**

Add to `src/slug.test.js`:

```js
import { toSlugBase } from './slug'

describe('toSlugBase', () => {
  it('passes latin names through slugify', () => {
    expect(toSlugBase('Cookie Corner')).toBe('cookie-corner')
  })
  it('transliterates Chinese to pinyin', () => {
    expect(toSlugBase('点心铺')).toBe('dian-xin-pu')
  })
  it('handles mixed latin + Chinese', () => {
    expect(toSlugBase('点心 Cafe')).toBe('dian-xin-cafe')
  })
  it('returns empty for pure punctuation', () => {
    expect(toSlugBase('!!!')).toBe('')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/slug.test.js`
Expected: FAIL — `toSlugBase is not a function`.

- [ ] **Step 4: Write minimal implementation**

Add to `src/slug.js`:

```js
import { pinyin } from 'pinyin-pro'

// True if the string contains any CJK ideograph.
function hasCJK(s) {
  return /[一-鿿]/.test(s)
}

export function toSlugBase(name) {
  const raw = String(name ?? '')
  const latinised = hasCJK(raw)
    ? pinyin(raw, { toneType: 'none', type: 'array' }).join(' ') + ' ' + raw.replace(/[一-鿿]+/g, ' ')
    : raw
  return slugify(latinised)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/slug.test.js`
Expected: PASS. (If pinyin output spacing differs, assert on the actual `pinyin('点心铺', {toneType:'none'})` value — pin the expected string to the library's real output.)

- [ ] **Step 6: Commit**

```bash
git add src/slug.js src/slug.test.js package.json package-lock.json
git commit -m "feat: transliterate Chinese shop names to pinyin slugs"
```

---

### Task 0.4: Resolve a unique, non-reserved slug with fallback

**Files:**
- Modify: `src/slug.js`
- Modify: `src/slug.test.js`

**Interfaces:**
- Consumes: `toSlugBase` (Task 0.3).
- Produces: `RESERVED_SLUGS: string[]` and `resolveSlug(name, { taken = [], id = '' }) => string`. `taken` is the set of slugs already in use. Returns the base slug if free + not reserved; otherwise appends `-2`, `-3`, …; if base is empty, uses `shop-<first 6 chars of id>`; the fallback is also de-duplicated against `taken`.

- [ ] **Step 1: Write the failing test**

Add to `src/slug.test.js`:

```js
import { resolveSlug, RESERVED_SLUGS } from './slug'

describe('resolveSlug', () => {
  it('returns the base slug when free', () => {
    expect(resolveSlug('Cookie Corner', { taken: [] })).toBe('cookie-corner')
  })
  it('suffixes on collision', () => {
    expect(resolveSlug('Cookie Corner', { taken: ['cookie-corner'] })).toBe('cookie-corner-2')
    expect(resolveSlug('Cookie Corner', { taken: ['cookie-corner', 'cookie-corner-2'] })).toBe('cookie-corner-3')
  })
  it('avoids reserved words by suffixing', () => {
    expect(RESERVED_SLUGS).toContain('admin')
    expect(resolveSlug('Admin', { taken: [] })).toBe('admin-2')
  })
  it('falls back to shop-<id> when base is empty', () => {
    expect(resolveSlug('!!!', { taken: [], id: 'a3f9c1d2-xxxx' })).toBe('shop-a3f9c1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/slug.test.js`
Expected: FAIL — `resolveSlug is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/slug.js`:

```js
// Every top-level route segment the router owns must be reserved here.
export const RESERVED_SLUGS = [
  's', 'admin', 'api', 'merchant', 'app', 'www', 'auth',
  'login', 'signup', 'account', 'static', 'assets',
]

export function resolveSlug(name, { taken = [], id = '' } = {}) {
  const base = toSlugBase(name) || `shop-${id.replace(/-/g, '').slice(0, 6)}`
  const used = new Set(taken)
  const blocked = (s) => used.has(s) || RESERVED_SLUGS.includes(s)
  if (!blocked(base)) return base
  let n = 2
  while (blocked(`${base}-${n}`)) n++
  return `${base}-${n}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/slug.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slug.js src/slug.test.js
git commit -m "feat: resolve unique non-reserved slug with fallback"
```

---

### Task 0.5: Pure order-number core (prefix + per-merchant counter)

**Files:**
- Create: `src/orderNumber.js`
- Create: `src/orderNumber.test.js`

**Interfaces:**
- Produces: `nextOrderNumber({ prefix, counter, today }) => { orderNumber, counter }` where `counter` is `{ date, value } | null` (the stored per-merchant counter row), `today` is a `YYMMDD` string, `prefix` is the merchant's order prefix. Resets the counter to 50 on a new day, else increments. Pure — the Supabase read/write wrapper lives in `store.js` (Task 1.x / P4) and calls this.

- [ ] **Step 1: Write the failing test**

```js
// src/orderNumber.test.js
import { describe, it, expect } from 'vitest'
import { nextOrderNumber } from './orderNumber'

describe('nextOrderNumber', () => {
  it('starts at 50 when there is no prior counter', () => {
    const r = nextOrderNumber({ prefix: 'CC', counter: null, today: '260627' })
    expect(r.orderNumber).toBe('CC-260627-0050')
    expect(r.counter).toEqual({ date: '260627', value: 50 })
  })
  it('increments within the same day', () => {
    const r = nextOrderNumber({ prefix: 'CC', counter: { date: '260627', value: 50 }, today: '260627' })
    expect(r.orderNumber).toBe('CC-260627-0051')
    expect(r.counter).toEqual({ date: '260627', value: 51 })
  })
  it('resets to 50 on a new day', () => {
    const r = nextOrderNumber({ prefix: 'CC', counter: { date: '260626', value: 73 }, today: '260627' })
    expect(r.orderNumber).toBe('CC-260627-0050')
    expect(r.counter).toEqual({ date: '260627', value: 50 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/orderNumber.test.js`
Expected: FAIL — cannot resolve `./orderNumber`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/orderNumber.js
export function nextOrderNumber({ prefix, counter, today }) {
  const value = counter && counter.date === today ? counter.value + 1 : 50
  return {
    orderNumber: `${prefix}-${today}-${String(value).padStart(4, '0')}`,
    counter: { date: today, value },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/orderNumber.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orderNumber.js src/orderNumber.test.js
git commit -m "feat: pure per-merchant order-number core"
```

---

### Task 0.6: Multi-tenant schema migration

**Files:**
- Create: `supabase/migrations/20260627120000_multitenant_schema.sql`

**Interfaces:**
- Produces: `merchants` table; `merchant_id` FK on `products`, `vouchers`, `orders`, `profiles`; per-merchant order counter; `app_role` on profiles; helper `current_merchant_id()`. Later tasks read/write these via merchant-scoped `store.js` functions.

**Context — the baseline:** `supabase/migrations/20260626120000_init_schema.sql` already defines single-tenant `profiles`, `orders`, `settings` (key-value blob) with an `is_owner()` email gate. This migration is **additive and forward-only**. Per the PRD "fresh start", products and vouchers become real tables (they previously lived inside `settings`).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260627120000_multitenant_schema.sql
-- Multi-tenant foundation. Additive on top of the single-tenant baseline.

-- ── merchants ────────────────────────────────────────────────────────────────
create table if not exists public.merchants (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text not null unique,
  order_prefix text not null,
  status       text not null default 'pending'
               check (status in ('pending','active','suspended')),
  -- payment + notification config, per merchant (manual payment model)
  payment_qr   text,
  payment_bank text,
  payment_note text,
  tg_token     text,
  tg_chat_id   text,
  -- store config previously held in settings.main, now per merchant
  shipping     jsonb not null default '{"WM":8,"EM":18}'::jsonb,
  config       jsonb not null default '{}'::jsonb,   -- sameday, pickup, leadDays, availableDays, blockedDates
  slug_locked  boolean not null default false,        -- editable once, then true
  owner_id     uuid references auth.users (id),       -- the merchant admin account
  created_at   timestamptz not null default now()
);

-- ── role on profiles ─────────────────────────────────────────────────────────
-- 'customer' (default) | 'merchant' | 'superadmin'
alter table public.profiles
  add column if not exists app_role text not null default 'customer'
    check (app_role in ('customer','merchant','superadmin'));

-- Per-merchant customer profiles: one row per (user_id, merchant_id).
-- profiles.id stays the surrogate; we add the tenant link and a uniqueness rule.
alter table public.profiles
  add column if not exists merchant_id uuid references public.merchants (id);

-- A given auth user has at most one profile per merchant.
create unique index if not exists profiles_user_merchant_key
  on public.profiles (id, merchant_id)
  where merchant_id is not null;

-- ── tenant scoping on orders ─────────────────────────────────────────────────
alter table public.orders
  add column if not exists merchant_id uuid references public.merchants (id);
create index if not exists orders_merchant_id_idx on public.orders (merchant_id);

-- Order status / AWB / notes move off the settings blob onto orders.
alter table public.orders
  add column if not exists status text default 'new';
alter table public.orders
  add column if not exists awb text;
alter table public.orders
  add column if not exists note text;

-- order_number is unique PER MERCHANT (not globally).
drop index if exists orders_order_number_key;
create unique index if not exists orders_merchant_order_number_key
  on public.orders (merchant_id, order_number)
  where order_number is not null;

-- ── products ─────────────────────────────────────────────────────────────────
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  name        text not null,
  name_zh     text,
  descr       text,
  descr_zh    text,
  price       numeric not null default 0,
  unit        text,
  sort        int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists products_merchant_id_idx on public.products (merchant_id);

-- ── vouchers ─────────────────────────────────────────────────────────────────
create table if not exists public.vouchers (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  code        text not null,
  kind        text,                                   -- percent | fixed | etc.
  amount      numeric,
  max_uses    int,                                    -- null = unlimited total (still 1/customer)
  used_by     jsonb not null default '[]'::jsonb,     -- list of emails / guest tokens
  created_at  timestamptz not null default now(),
  unique (merchant_id, code)
);
create index if not exists vouchers_merchant_id_idx on public.vouchers (merchant_id);

-- ── per-merchant order counter ───────────────────────────────────────────────
create table if not exists public.order_counters (
  merchant_id uuid primary key references public.merchants (id),
  day         text,                                   -- 'YYMMDD'
  value       int not null default 50
);

-- ── helper: the merchant the current user administers ─────────────────────────
create or replace function public.current_merchant_id()
returns uuid
language sql
stable
as $$
  select m.id from public.merchants m where m.owner_id = auth.uid() limit 1;
$$;

create or replace function public.is_superadmin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.app_role = 'superadmin'
  );
$$;

grant execute on function public.current_merchant_id() to anon, authenticated;
grant execute on function public.is_superadmin()       to anon, authenticated;
```

- [ ] **Step 2: Apply locally and verify it runs clean**

Run: `supabase db reset` (or `supabase migration up`)
Expected: all migrations apply with no error; `\d public.merchants` shows the table.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260627120000_multitenant_schema.sql
git commit -m "feat(db): multi-tenant schema (merchants, merchant_id, per-merchant counter)"
```

---

### Task 0.7: RLS policies for tenant isolation

**Files:**
- Create: `supabase/migrations/20260627120100_multitenant_rls.sql`

**Interfaces:**
- Consumes: `current_merchant_id()`, `is_superadmin()` (Task 0.6).
- Produces: RLS such that a merchant admin reads/writes only their own `products`/`vouchers`/`orders`/`order_counters`/`merchant`; customers read active products + write own orders/profiles scoped to a merchant; superadmin sees all; merchant rows are publicly readable by slug (storefront resolution).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260627120100_multitenant_rls.sql
alter table public.merchants      enable row level security;
alter table public.products       enable row level security;
alter table public.vouchers       enable row level security;
alter table public.order_counters enable row level security;

-- ── merchants ────────────────────────────────────────────────────────────────
-- Anyone may read a merchant (needed to resolve /s/:slug). Writes: own or super.
drop policy if exists merchants_select_public on public.merchants;
create policy merchants_select_public on public.merchants
  for select using (true);

drop policy if exists merchants_insert_self on public.merchants;
create policy merchants_insert_self on public.merchants
  for insert with check (owner_id = auth.uid());

drop policy if exists merchants_update_own_or_super on public.merchants;
create policy merchants_update_own_or_super on public.merchants
  for update using (owner_id = auth.uid() or public.is_superadmin())
  with check (owner_id = auth.uid() or public.is_superadmin());

-- ── products ─────────────────────────────────────────────────────────────────
-- Public reads ACTIVE products (storefront). Merchant writes own. Super: all.
drop policy if exists products_select_public on public.products;
create policy products_select_public on public.products
  for select using (active or merchant_id = public.current_merchant_id() or public.is_superadmin());

drop policy if exists products_write_own on public.products;
create policy products_write_own on public.products
  for all
  using (merchant_id = public.current_merchant_id() or public.is_superadmin())
  with check (merchant_id = public.current_merchant_id() or public.is_superadmin());

-- ── vouchers ─────────────────────────────────────────────────────────────────
-- Public reads (customer applies a code at checkout). Merchant writes own.
drop policy if exists vouchers_select_public on public.vouchers;
create policy vouchers_select_public on public.vouchers
  for select using (true);

drop policy if exists vouchers_write_own on public.vouchers;
create policy vouchers_write_own on public.vouchers
  for all
  using (merchant_id = public.current_merchant_id() or public.is_superadmin())
  with check (merchant_id = public.current_merchant_id() or public.is_superadmin());

-- ── order_counters ───────────────────────────────────────────────────────────
-- Counter advancement happens through a security-definer RPC (P4); direct table
-- access is owner/super only.
drop policy if exists order_counters_own on public.order_counters;
create policy order_counters_own on public.order_counters
  for all
  using (merchant_id = public.current_merchant_id() or public.is_superadmin())
  with check (merchant_id = public.current_merchant_id() or public.is_superadmin());

-- ── orders (replace single-tenant policies) ──────────────────────────────────
-- Guests still insert (checkout). Reads: the ordering user, the merchant that
-- owns the order, or superadmin. Updates (status/awb/note): merchant or super.
drop policy if exists orders_select_own_or_owner on public.orders;
create policy orders_select_scoped on public.orders
  for select using (
    user_id = auth.uid()
    or merchant_id = public.current_merchant_id()
    or public.is_superadmin()
  );

drop policy if exists orders_update_owner on public.orders;
create policy orders_update_merchant on public.orders
  for update
  using (merchant_id = public.current_merchant_id() or public.is_superadmin())
  with check (merchant_id = public.current_merchant_id() or public.is_superadmin());
-- orders_insert_any (guest checkout) from the baseline is retained.

-- ── profiles (tighten the baseline public select) ────────────────────────────
-- Baseline allowed SELECT to everyone (referral lookup). Keep self/super only;
-- referral lookup moves to a security-definer RPC in P5.
drop policy if exists profiles_select_public on public.profiles;
create policy profiles_select_self_or_super on public.profiles
  for select using (id = auth.uid() or public.is_superadmin());
```

- [ ] **Step 2: Apply locally**

Run: `supabase db reset`
Expected: applies clean.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260627120100_multitenant_rls.sql
git commit -m "feat(db): RLS policies for multi-tenant isolation"
```

---

### Task 0.8: RLS isolation integration test (two merchants)

**Files:**
- Create: `tests/rls/isolation.test.js`
- Create: `tests/rls/helpers.js`

**Interfaces:**
- Consumes: a running local Supabase (`supabase start`) and its anon/service keys from `supabase status`.
- Produces: a test proving merchant A cannot read/write merchant B's products/orders, and superadmin can read both. This is the security-critical seam; it cannot be replaced by app-layer tests.

- [ ] **Step 1: Add a test helper that builds authed clients**

```js
// tests/rls/helpers.js
import { createClient } from '@supabase/supabase-js'

// Read from env so CI / local can inject. `supabase status` prints these.
const URL = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

export function anonClient() {
  return createClient(URL, ANON)
}
export function serviceClient() {
  return createClient(URL, SERVICE, { auth: { persistSession: false } })
}

// Create a confirmed user + signed-in client via the service role.
export async function makeUser(email, password) {
  const svc = serviceClient()
  await svc.auth.admin.createUser({ email, password, email_confirm: true })
  const client = anonClient()
  await client.auth.signInWithPassword({ email, password })
  return client
}
```

- [ ] **Step 2: Write the failing isolation test**

```js
// tests/rls/isolation.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import { makeUser, serviceClient } from './helpers'

describe('tenant isolation (RLS)', () => {
  let merchantA, merchantB, idA, idB

  beforeAll(async () => {
    const svc = serviceClient()
    merchantA = await makeUser('a@test.dev', 'password123')
    merchantB = await makeUser('b@test.dev', 'password123')
    const uA = (await merchantA.auth.getUser()).data.user.id
    const uB = (await merchantB.auth.getUser()).data.user.id
    ;({ data: { id: idA } } = await svc.from('merchants')
      .insert({ name: 'A', slug: 'shop-a', order_prefix: 'AA', owner_id: uA, status: 'active' })
      .select('id').single())
    ;({ data: { id: idB } } = await svc.from('merchants')
      .insert({ name: 'B', slug: 'shop-b', order_prefix: 'BB', owner_id: uB, status: 'active' })
      .select('id').single())
    await svc.from('products').insert({ merchant_id: idB, name: 'Secret B cookie', price: 9, active: false })
  })

  it('merchant A cannot read merchant B inactive products', async () => {
    const { data } = await merchantA.from('products').select('*').eq('merchant_id', idB)
    expect(data).toEqual([])
  })

  it('merchant A cannot write into merchant B', async () => {
    const { error } = await merchantA.from('products')
      .insert({ merchant_id: idB, name: 'hack', price: 1 })
    expect(error).not.toBeNull()
  })

  it('merchant A can write into its own tenant', async () => {
    const { error } = await merchantA.from('products')
      .insert({ merchant_id: idA, name: 'A cookie', price: 5 })
    expect(error).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails (before Supabase is up / proves it runs)**

Run: `supabase start` then
`SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm test -- tests/rls/isolation.test.js`
Expected: with the P0.6/P0.7 migrations applied, these PASS. If RLS were missing, test 1 and 2 would FAIL — confirm by temporarily disabling a policy.

- [ ] **Step 4: Document the test command**

Add a `test:rls` script to `package.json`:

```json
"test:rls": "vitest run tests/rls"
```

- [ ] **Step 5: Commit**

```bash
git add tests/rls/helpers.js tests/rls/isolation.test.js package.json
git commit -m "test(db): RLS tenant-isolation integration test"
```

**P0 complete:** test runner live, multi-tenant schema + RLS applied and proven isolated, pure slug/order-number functions tested. No UI yet — everything below builds on this.

---

# P1 — Routing + role-based access

> Expand to step-level TDD before executing (run `writing-plans` on this phase).

**Goal:** Introduce `react-router-dom`, resolve the merchant from `/s/:slug` once into `MerchantContext`, and replace the hardcoded `OWNER_EMAIL` gate with the `app_role` from the profile.

**Files:**
- Modify: `package.json` — add `react-router-dom`.
- Create: `src/MerchantContext.jsx` — context + `useMerchant()` hook.
- Create: `src/routes.jsx` — route table (`/`, `/s/:slug`, `/s/:slug/account`, `/merchant/*`, `/admin/*`).
- Modify: `src/main.jsx` — wrap app in `<BrowserRouter>`.
- Modify: `src/App.jsx` — stop being the universal switch; render `<Routes>`; remove `OWNER_EMAIL` constant + email gate, gate on `account.app_role` instead.
- Modify: `src/store.js` — add `fetchMerchantBySlug(slug)`, `fetchCurrentRole()`.
- Create: `src/store.test.js` — unit-test `fetchMerchantBySlug` (mock supabase) returns null on miss.

**Interfaces:**
- Produces:
  - `fetchMerchantBySlug(slug: string) => Promise<Merchant | null>`
  - `MerchantProvider` + `useMerchant() => { merchant, loading }`
  - `RequireRole({ role, children })` route guard reading `app_role`.
- Consumes: schema from P0 (`merchants`, `profiles.app_role`).

**Tasks (each ends testable):**
1. Add `react-router-dom`; wrap `main.jsx` in `<BrowserRouter>`; render existing `App` at `/` — app still loads (manual smoke + lint).
2. Add `fetchMerchantBySlug` to `store.js` + unit test with a mocked supabase client (resolve → merchant; PGRST116 not-found → null).
3. Build `MerchantContext` + `useMerchant`; `/s/:slug` route resolves merchant, shows a "shop not found" state for null. Test the resolver hook with a mocked store.
4. Replace `OWNER_EMAIL` gate: add `fetchCurrentRole`, render owner/merchant UI only when `app_role !== 'customer'`. Remove the `OWNER_EMAIL` constant.
5. Reserved-slug guard: route `/s/:slug` rejects any slug in `RESERVED_SLUGS` (already enforced in data, defend in routing too).

**Testing:** unit-test the pure store functions with a mocked `supabase` (Vitest `vi.mock('./supabase')`). Router wiring verified by a manual smoke run (`npm run dev`) — no prior art for component tests in this repo; defer RTL until a later phase if needed.

**Out of scope here:** any new merchant/customer screens (P2+). This phase only re-platforms navigation and auth-gating.

---

# P2 — Merchant signup + onboarding

> Expand to step-level TDD before executing.

**Goal:** A prospective merchant signs up with a shop name only; the system auto-generates a slug (editable once), creates the auth user + merchant in `pending`, and shows a "waiting for approval" state.

**Files:**
- Create: `src/merchant/SignupScreen.jsx` — email/password + shop name; live slug preview.
- Create: `src/merchant/PendingScreen.jsx` — shown while `status === 'pending'`.
- Modify: `src/store.js` — `createMerchant({ name, slugOverride })`, `listTakenSlugs()`, `updateMerchantSlug(id, slug)` (only while `slug_locked = false`).
- Modify: `src/routes.jsx` — `/merchant/signup`, `/merchant/pending`.
- Create: `src/merchant/SignupScreen.test.jsx` (or pure-logic test of the create flow).

**Interfaces:**
- Consumes: `resolveSlug`, `RESERVED_SLUGS` (P0), `signUp` (existing in `store.js`), `useMerchant`/role (P1).
- Produces:
  - `createMerchant({ name, slugOverride? }) => Promise<Merchant>` — signs the user up if needed, resolves slug against `listTakenSlugs()`, derives `order_prefix` (e.g. first 2 latin chars of slug, uppercased), inserts `merchants` with `status='pending'`, `owner_id=auth.uid()`, sets the caller's `profiles.app_role='merchant'`.
  - `updateMerchantSlug(id, slug)` — re-validates against taken+reserved, sets `slug_locked=true` once chosen-and-confirmed at go-live.

**Tasks:**
1. `listTakenSlugs()` + `createMerchant` in `store.js`; unit-test slug resolution path with mocked supabase (collision → suffix; Chinese name → pinyin).
2. `SignupScreen` — shop-name field with live slug preview via `toSlugBase`; "edit slug" toggle (one-time) writing through `updateMerchantSlug`.
3. On submit → create merchant `pending` → route to `PendingScreen`.
4. `order_prefix` derivation function (pure, tested): from slug, take alnum, uppercase, first 2; fallback `SH`.
5. Bilingual: all copy via `t()`.

**Testing:** unit-test `createMerchant`/`order_prefix` derivation (pure where possible, mocked supabase otherwise). Behaviour asserted: pending merchant created, slug unique, role set to merchant.

**Out of scope:** product entry (P4), going-live slug lock UI polish, payment config (P4/P5).

---

# P3 — Super-admin approval queue

> Expand to step-level TDD before executing.

**Goal:** The platform super-admin reviews pending merchants and approves (`active`) or suspends them.

**Files:**
- Create: `src/admin/AdminMerchants.jsx` — table of merchants by status with approve/suspend actions.
- Modify: `src/store.js` — `fetchAllMerchants()`, `setMerchantStatus(id, status)`.
- Modify: `src/routes.jsx` — `/admin/merchants` behind `RequireRole role="superadmin"`.
- Create: a migration to bootstrap the first super-admin (`update profiles set app_role='superadmin' where id = <bitetimeandco user id>`), or document doing it via the service role.

**Interfaces:**
- Consumes: `is_superadmin()` RLS (P0), `RequireRole` (P1).
- Produces:
  - `fetchAllMerchants() => Promise<Merchant[]>` (superadmin-only by RLS)
  - `setMerchantStatus(id, 'active'|'suspended') => Promise<void>`

**Tasks:**
1. `fetchAllMerchants` + `setMerchantStatus` in `store.js`; unit-test with mocked supabase.
2. `AdminMerchants` table: filter by status; approve/suspend buttons.
3. Route guard: non-superadmin hitting `/admin/*` is redirected.
4. Bootstrap super-admin documented + migration.

**Testing:** unit-test store functions; manual verification that a suspended merchant's storefront becomes unavailable (ties into P5 storefront gate on `status === 'active'`).

**Out of scope:** email notifications to merchants on approval; audit log.

---

# P4 — Merchant dashboard (port owner UI, scoped)

> Expand to step-level TDD before executing. **Largest phase — the `App.jsx` monolith split lands here.**

**Goal:** Port the existing owner pages (Home/order form, Orders, Menu & Settings, Vouchers, Customers) into a `/merchant/*` dashboard, every query scoped to the signed-in merchant.

**Files:**
- Create: `src/merchant/Dashboard.jsx` (shell + nav, replaces `OWNER_NAV`).
- Create: `src/merchant/MenuSettings.jsx`, `src/merchant/Orders.jsx`, `src/merchant/Vouchers.jsx`, `src/merchant/Customers.jsx`, `src/merchant/PaymentSettings.jsx` (QR/bank/Telegram per merchant).
- Modify: `src/store.js` — make product/voucher/order/settings functions merchant-scoped; add `fetchProducts(merchantId)`, `saveProduct`, `fetchMerchantOrders(merchantId)`, `setOrderStatus`, `setOrderAwb`, `setOrderNote`, and a security-definer RPC `next_order_number(merchant_id)` wrapping `nextOrderNumber` + `order_counters`.
- Create: migration `..._next_order_number_rpc.sql`.
- Modify: existing `OrderForm.jsx`, `Menu`/`Vouchers` components to read products/vouchers from tables (not `DEFAULTS`/`settings` blob) via context.

**Interfaces:**
- Consumes: P0 tables, `nextOrderNumber` (P0), `useMerchant` (P1).
- Produces (merchant-scoped store API):
  - `fetchProducts(merchantId) => Product[]`, `upsertProduct(p)`, `deleteProduct(id)`
  - `fetchVouchers(merchantId)`, `createVoucher`, `markVoucherUsed`, `deleteVoucher` (re-scoped; reuse existing pure helpers `voucherUsesLeft`/`voucherFullyUsed`)
  - `fetchMerchantOrders(merchantId)`, `setOrderStatus(orderId, status)`, `setOrderAwb`, `setOrderNote`
  - RPC `next_order_number(p_merchant uuid) => text` (security definer; advances `order_counters` atomically using the P0 core's logic in SQL)

**Tasks:**
1. `next_order_number` SQL RPC (atomic counter advance) + integration test (two concurrent-ish calls produce distinct numbers).
2. Re-scope products store functions + migrate `OrderForm`/`Menu` to read from `products` table; seed BiteTime's products on its merchant.
3. Re-scope vouchers (keep pure `voucherUsesLeft`/`voucherFullyUsed`, move storage to `vouchers` table).
4. Re-scope orders: status/awb/note now columns (not settings blob); update Orders page.
5. `PaymentSettings` page writes `merchants.payment_*` / `tg_*`.
6. Dashboard shell + routing; remove the old `ownerPage`-switch in `App.jsx`.
7. Decommission the `settings` blob reads for `main`/`vouchers`/`order_*` once parity confirmed.

**Testing:** unit-test re-scoped store functions (mocked supabase); RLS integration test extended to assert a merchant's Orders page query returns only own rows; the existing pure voucher helpers keep their behaviour (add unit tests since none exist today).

**Out of scope:** new dashboard features beyond current owner parity; analytics.

---

# P5 — Customer storefront at `/s/:slug`

> Expand to step-level TDD before executing.

**Goal:** Customers browse a merchant's products at `/s/:slug`, sign up/log in scoped to that merchant (one auth user, profile-per-merchant), place orders, and receive that merchant's payment instructions + Telegram notification.

**Files:**
- Create: `src/store/Storefront.jsx` — the customer order page, merchant from context.
- Create: `src/store/CustomerAccount.jsx` — drawer (personal details / vouchers / order history) scoped to merchant.
- Modify: `src/store.js` — `ensureProfileForMerchant(userId, merchantId)`, `fetchUserOrders(userId, merchantId)`, `saveOrder` to stamp `merchant_id` + use merchant tg token; referral lookup via new security-definer RPC `referrer_by_code(code)` returning only `{ id }`.
- Modify: notification path — Telegram token/chatId from `merchant`, not `DEFAULTS`.
- Create: migration `..._referrer_rpc.sql` (replaces the public profiles read removed in P0.7).
- Modify: `localStorage` cache keys → namespaced by merchant (`bitetime_settings_<merchantId>`, `bitetime_addr_<userId>_<merchantId>`).

**Interfaces:**
- Consumes: `useMerchant` (P1), products/vouchers tables (P4), `next_order_number` RPC (P4).
- Produces:
  - `ensureProfileForMerchant(userId, merchantId)` — creates the `(user_id, merchant_id)` profile row on first interaction.
  - `saveOrder(order)` now requires `order.merchant_id`; sends Telegram via that merchant's token.
  - `referrer_by_code(code) => { id } | null` RPC.

**Tasks:**
1. Storefront gates on `merchant.status === 'active'` (pending/suspended → "not available").
2. Customer auth scoped: on login/signup at `/s/:slug`, `ensureProfileForMerchant`.
3. Order flow stamps `merchant_id`, uses `next_order_number`, merchant payment note + tg token.
4. Account drawer queries scoped to merchant.
5. Referral lookup RPC + wire-up; remove reliance on public profile reads.
6. Namespace localStorage caches per merchant (prevent cross-tenant leakage).

**Testing:** unit-test `saveOrder` builds the right payload (mocked supabase + mocked fetch for Telegram); RLS integration test: a customer of merchant A cannot read merchant B orders; `referrer_by_code` returns only `{id}` (no email).

**Out of scope:** cross-merchant cart; marketplace discovery.

---

# P6 — Root marketing + signup landing

> Expand to step-level TDD before executing.

**Goal:** Root `/` is a marketing page for the platform with a "Start your shop" CTA into `/merchant/signup`.

**Files:**
- Create: `src/marketing/Landing.jsx`.
- Modify: `src/routes.jsx` — `/` → `Landing`.

**Interfaces:**
- Consumes: routing (P1), signup (P2).
- Produces: a static, bilingual landing page; CTA navigates to `/merchant/signup`.

**Tasks:**
1. Build `Landing` (value prop, CTA, bilingual via `t()`).
2. Route `/` to it; ensure existing customers reaching `/` are guided (they normally arrive via `/s/:slug` links).

**Testing:** manual smoke; no data layer. Optional: a render test once RTL is introduced.

**Out of scope:** SEO, blog, pricing/billing pages.

---

## Self-Review Notes

- **Spec coverage:** every PRD user-story cluster maps to a phase — onboarding/slug → P2 (+P0 slug fns); store config/products/vouchers/orders → P4; per-merchant customer/storefront/payment/Telegram → P5; super-admin → P3; routing/role → P1; root marketing → P6; isolation/RLS → P0.7/0.8. Order-number per-merchant → P0.5 + P4 RPC.
- **Type consistency:** `resolveSlug`/`toSlugBase`/`RESERVED_SLUGS` (P0) reused by name in P1/P2; `nextOrderNumber` core (P0) wrapped by `next_order_number` RPC (P4); `current_merchant_id()`/`is_superadmin()` (P0.6) referenced by RLS (P0.7) and guards (P1/P3).
- **Known carry-over risk:** existing `[[db-code-drift]]` quirks (`profiles` PK, non-unique `order_number`) — P0.6 changes order_number uniqueness to **per-merchant** and adds the `(id, merchant_id)` profile uniqueness; verify no legacy duplicates before applying (fresh-start makes this safe).
- **Placeholder scan:** P0 is fully concrete (real code + commands). P1–P6 are deliberately task-level, not micro-step — flagged at the top of each to expand via `writing-plans` before execution, because their component code depends on P0 outcomes.
