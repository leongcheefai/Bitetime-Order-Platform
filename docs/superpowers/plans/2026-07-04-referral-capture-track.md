# Referral Capture & Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the referring code when a new shop signs up with `?ref`, and show the referrer a list of shops that used their code.

**Architecture:** A migration adds `merchants.referred_by_code` and a `SECURITY DEFINER` RPC `my_referred_shops()` that returns safe columns for shops matching the caller's own derived code. A pure helper validates/normalizes the code (with a self-referral guard). `createMerchant` writes the column; `SignupScreen` feeds it `?ref`. `ReferralTab` gains an "Invited shops" section backed by `fetchReferredShops()`. No reward logic, no backfill.

**Tech Stack:** Postgres/Supabase (SQL migration + RLS), React 19 + TypeScript + Vite frontend, Vitest (frontend unit + backend RLS integration).

## Global Constraints

- Frontend TypeScript strict, `moduleResolution: bundler` → extensionless relative imports. Backend tests use `.js` import specifiers (e.g. `./helpers.js`).
- Every user-facing string uses `t(en, zh)` from `useSession()`.
- `referred_by_code` is stored ONLY if it is 8-hex (`^[0-9A-F]{8}$`, uppercased) AND not equal to the owner's own code (`referralCodeOf(owner_id)`); otherwise `null`.
- `my_referred_shops()` MUST be `security definer`, `set search_path = public`, schema-qualify tables as `public.merchants`, `grant execute ... to authenticated`, return ONLY `name, created_at, status`, and filter by `upper(left(replace(auth.uid()::text, '-', ''), 8))` (the caller's own code — same derivation as `referralCodeOf`).
- No reward/credit logic. No backfill of pre-existing shops.
- After adding the migration, apply it with `pnpm --filter @bitetime/backend db:migrate` (needs local Supabase running — `supabase start` from `apps/backend` if it is not).
- Do NOT import `referralCodeOf` into `referralCode.ts` (store.ts imports the helper → circular). The self-referral guard receives the owner's code as a parameter.

---

### Task 1: Migration — column + index + `my_referred_shops` RPC

**Files:**
- Create: `apps/backend/supabase/migrations/20260704130000_referral_capture.sql`

**Interfaces:**
- Produces (SQL): `merchants.referred_by_code text`; `public.my_referred_shops()` returning `table(name text, created_at timestamptz, status text)`.

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260704130000_referral_capture.sql`:

```sql
-- Referral capture & track (spec: docs/superpowers/specs/2026-07-04-referral-capture-track-design.md)
-- Records which referral code a new merchant signed up under, and lets a referrer
-- list the shops that used their code. Display-only — no reward logic.

alter table public.merchants
  add column if not exists referred_by_code text;

create index if not exists merchants_referred_by_code_idx
  on public.merchants (referred_by_code);

-- Returns the shops that signed up with the CALLER's own referral code. The caller's
-- code is derived from auth.uid() in SQL exactly as referralCodeOf() does in the app
-- (strip dashes, first 8 hex chars, uppercase). SECURITY DEFINER so it can read across
-- tenants, but it only ever returns rows matching the caller's code and only three
-- non-sensitive columns.
create or replace function public.my_referred_shops()
returns table (name text, created_at timestamptz, status text)
language sql
security definer
set search_path = public
as $$
  select m.name, m.created_at, m.status::text
  from public.merchants m
  where m.referred_by_code = upper(left(replace(auth.uid()::text, '-', ''), 8))
  order by m.created_at desc;
$$;

grant execute on function public.my_referred_shops() to authenticated;
```

- [ ] **Step 2: Apply the migration**

Run: `pnpm --filter @bitetime/backend db:migrate`
Expected: applies `20260704130000_referral_capture` with no error. (If it fails with a connection error, local Supabase is not running — run `supabase start` from `apps/backend`, then re-run. If Supabase cannot be started in this environment, report DONE_WITH_CONCERNS noting the migration is written but not applied; behavior is covered by the Task 6 RLS test.)

- [ ] **Step 3: Verify the objects exist**

Run: `pnpm --filter @bitetime/backend exec supabase db execute --local "select 1 from information_schema.columns where table_name='merchants' and column_name='referred_by_code'; select proname from pg_proc where proname='my_referred_shops';"` (or, if that CLI subcommand is unavailable, `psql "$SUPABASE_DB_URL" -c "\d public.merchants" -c "\df public.my_referred_shops"`).
Expected: the `referred_by_code` column and `my_referred_shops` function are listed. If no local DB is reachable, skip this step and note it as a concern.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/supabase/migrations/20260704130000_referral_capture.sql
git commit -m "feat(referral): migration — referred_by_code column + my_referred_shops RPC"
```

---

### Task 2: Pure code helpers — `normalizeReferralCode` + `resolveReferredByCode`

**Files:**
- Create: `apps/frontend/src/referralCode.ts`
- Test: `apps/frontend/src/referralCode.test.ts`

**Interfaces:**
- Produces:
  - `normalizeReferralCode(raw: string | null | undefined): string | null` — trims, uppercases, returns the code iff it matches `^[0-9A-F]{8}$`, else `null`.
  - `resolveReferredByCode(raw: string | null | undefined, ownerCode: string): string | null` — the normalized code unless it equals `ownerCode` (self-referral), else `null`.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/referralCode.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeReferralCode, resolveReferredByCode } from './referralCode'

describe('normalizeReferralCode', () => {
  it('accepts an 8-char hex code, uppercased', () => {
    expect(normalizeReferralCode('ab12cd34')).toBe('AB12CD34')
  })
  it('trims surrounding whitespace', () => {
    expect(normalizeReferralCode('  AB12CD34 ')).toBe('AB12CD34')
  })
  it('rejects wrong length', () => {
    expect(normalizeReferralCode('AB12CD3')).toBeNull()
    expect(normalizeReferralCode('AB12CD345')).toBeNull()
  })
  it('rejects non-hex characters', () => {
    expect(normalizeReferralCode('AB12CG34')).toBeNull()
  })
  it('returns null for empty / nullish', () => {
    expect(normalizeReferralCode('')).toBeNull()
    expect(normalizeReferralCode(null)).toBeNull()
    expect(normalizeReferralCode(undefined)).toBeNull()
  })
})

describe('resolveReferredByCode', () => {
  it('returns the normalized code when it differs from the owner code', () => {
    expect(resolveReferredByCode('ab12cd34', 'FFFFFFFF')).toBe('AB12CD34')
  })
  it('returns null on self-referral (equals owner code)', () => {
    expect(resolveReferredByCode('AB12CD34', 'AB12CD34')).toBeNull()
    expect(resolveReferredByCode('ab12cd34', 'AB12CD34')).toBeNull()
  })
  it('returns null for a malformed code', () => {
    expect(resolveReferredByCode('nope', 'FFFFFFFF')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bitetime/frontend exec vitest run src/referralCode.test.ts`
Expected: FAIL — cannot resolve `./referralCode`.

- [ ] **Step 3: Write the implementation**

Create `apps/frontend/src/referralCode.ts`:

```ts
// Pure referral-code helpers — format validation + self-referral guard. DOM/DB-free and
// unit-testable. A referral code is the first 8 hex chars of a user id, uppercased
// (see referralCodeOf in store.ts). The self-referral guard takes the owner's code as a
// parameter rather than importing referralCodeOf, to avoid a store.ts ↔ referralCode.ts
// import cycle.

export function normalizeReferralCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase()
  return /^[0-9A-F]{8}$/.test(code) ? code : null
}

// The code to store on a new merchant: normalized, but never the owner's own code.
export function resolveReferredByCode(
  raw: string | null | undefined,
  ownerCode: string,
): string | null {
  const code = normalizeReferralCode(raw)
  if (!code) return null
  return code === ownerCode ? null : code
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bitetime/frontend exec vitest run src/referralCode.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/referralCode.ts apps/frontend/src/referralCode.test.ts
git commit -m "feat(referral): pure normalizeReferralCode + resolveReferredByCode helpers"
```

---

### Task 3: Capture — write `referred_by_code` from signup

**Files:**
- Modify: `apps/frontend/src/store.ts` (`createMerchant`, ~149-163; add import)
- Modify: `apps/frontend/src/merchant/SignupScreen.tsx` (params ~20-24; call site ~56)

**Interfaces:**
- Consumes: `resolveReferredByCode` (Task 2); `referralCodeOf` (existing, `store.ts:388`).
- Produces: `createMerchant({ ..., referredByCode?: string })` — writes `merchants.referred_by_code`.

- [ ] **Step 1: Add the import in store.ts**

At the top of `apps/frontend/src/store.ts`, alongside the other local imports, add:

```ts
import { resolveReferredByCode } from './referralCode'
```

- [ ] **Step 2: Extend `createMerchant`**

Replace the existing `createMerchant` function (currently `store.ts:149-163`) with:

```ts
export async function createMerchant({ name, plan = 'basic', billing = 'monthly', region = 'US', referredByCode }: { name: string; plan?: string; billing?: string; region?: string; referredByCode?: string }) {
  const user = await getCurrentUser()
  if (!user) throw new Error('Not signed in')
  const taken = await listTakenSlugs()
  const slug = await resolveSlug(name, { taken, id: user.id })
  const { data, error } = await supabase
    .from('merchants')
    .insert({
      name, slug, order_prefix: orderPrefix(slug), owner_id: user.id, status: 'pending',
      plan, billing_cycle: billing, billing_region: region,
      referred_by_code: resolveReferredByCode(referredByCode, referralCodeOf(user.id)),
    })
    .select().single()
  if (error) throw error
  return data
}
```

- [ ] **Step 3: Read `?ref` in SignupScreen**

In `apps/frontend/src/merchant/SignupScreen.tsx`, in the block that reads search params (~lines 20-24, after the `canceled` line), add:

```ts
  const ref = params.get('ref') ?? undefined
```

- [ ] **Step 4: Pass it to `createMerchant`**

Change the `createMerchant` call site (~line 56) from:

```ts
    await createMerchant({ name, plan, billing, region: pricing.region })
```

to:

```ts
    await createMerchant({ name, plan, billing, region: pricing.region, referredByCode: ref })
```

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend lint`
Expected: PASS. (Behavioral proof that the column is written correctly comes from the Task 6 RLS test; the pure guard is already covered by Task 2.)

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/store.ts apps/frontend/src/merchant/SignupScreen.tsx
git commit -m "feat(referral): capture ?ref at signup into merchants.referred_by_code"
```

---

### Task 4: Track data — `ReferredShop` type + `fetchReferredShops`

**Files:**
- Modify: `apps/frontend/src/types.ts` (add `ReferredShop`)
- Modify: `apps/frontend/src/store.ts` (add `fetchReferredShops` in the Referral program section, near `referralCodeOf` ~388)

**Interfaces:**
- Consumes: the `my_referred_shops` RPC (Task 1); `MerchantStatus` (existing, `types.ts:13`).
- Produces: `ReferredShop = { name: string; created_at: string; status: MerchantStatus }`; `fetchReferredShops(): Promise<ReferredShop[]>`.

- [ ] **Step 1: Add the `ReferredShop` type**

In `apps/frontend/src/types.ts`, after the `Merchant` interface, add:

```ts
export interface ReferredShop {
  name: string
  created_at: string
  status: MerchantStatus
}
```

- [ ] **Step 2: Add `fetchReferredShops` to store.ts**

In `apps/frontend/src/store.ts`, in the "Referral program" section (just below `referralCodeOf`, ~line 390), add:

```ts
// Shops that signed up with the current user's referral code. Reads the
// my_referred_shops SECURITY DEFINER RPC, which filters by the caller's own code and
// returns only name/created_at/status.
export async function fetchReferredShops(): Promise<ReferredShop[]> {
  const { data, error } = await supabase.rpc('my_referred_shops')
  if (error) throw error
  return (data ?? []) as ReferredShop[]
}
```

Ensure `ReferredShop` is imported from `./types` in store.ts (add it to the existing type import from `./types` if one exists; otherwise add `import type { ReferredShop } from './types'`).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/types.ts apps/frontend/src/store.ts
git commit -m "feat(referral): ReferredShop type + fetchReferredShops RPC call"
```

---

### Task 5: Track UI — "Invited shops" section in ReferralTab

**Files:**
- Modify: `apps/frontend/src/merchant/ReferralTab.tsx`

**Interfaces:**
- Consumes: `fetchReferredShops` (Task 4); `ReferredShop` (Task 4).

- [ ] **Step 1: Add the imports**

In `apps/frontend/src/merchant/ReferralTab.tsx`, update the imports:
- Change `import { useState } from 'react'` to `import { useEffect, useState } from 'react'`.
- Add `import { referralCodeOf, fetchReferredShops } from '../store'` (replace the existing `import { referralCodeOf } from '../store'`).
- Add `import type { ReferredShop } from '../types'`.

- [ ] **Step 2: Load the referred shops**

Inside the `ReferralTab` component, after the existing `const [qrOpen, setQrOpen] = useState(false)` line, add the loading state and effect:

```tsx
  const [shops, setShops] = useState<ReferredShop[] | null>(null)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let alive = true
    fetchReferredShops()
      .then((rows) => { if (alive) setShops(rows) })
      .catch(() => { if (alive) setLoadError(true) })
    return () => { alive = false }
  }, [])
```

- [ ] **Step 3: Wrap the existing card and add the Invited shops card**

The component currently returns a single `<Card>…</Card>`. Wrap it and the new card in a fragment. Change the `return (` block so the outer element is:

```tsx
  return (
    <div className="flex flex-col gap-6">
      <Card>
        {/* …the entire existing Card (header, content, dialog) stays unchanged… */}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t('Invited shops', '已邀请店铺')}{shops ? ` (${shops.length})` : ''}
          </CardTitle>
          <CardDescription>
            {t('Shops that signed up with your code.', '使用您推荐码注册的店铺。')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="text-[13px] text-rose-muted">{t('Could not load invited shops.', '无法加载已邀请店铺。')}</p>
          ) : shops === null ? (
            <p className="text-[13px] text-rose-muted">{t('Loading…', '加载中…')}</p>
          ) : shops.length === 0 ? (
            <p className="text-[13px] text-rose-muted">{t('No invited shops yet.', '还没有已邀请的店铺。')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-clay-border">
              {shops.map((s, i) => (
                <li key={i} className="flex items-center justify-between py-2">
                  <div className="flex flex-col">
                    <span className="text-[14px] text-ink">{s.name}</span>
                    <span className="text-[12px] text-rose-muted">{new Date(s.created_at).toLocaleDateString()}</span>
                  </div>
                  <StatusBadge status={s.status} t={t} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
```

Keep the existing `<Dialog>…</Dialog>` where it is — inside the first `<Card>` (unchanged). Only the outer wrapper and the second `<Card>` are new.

- [ ] **Step 4: Add the StatusBadge helper**

Below the `ReferralTab` default export function (end of file), add:

```tsx
function StatusBadge({ status, t }: { status: ReferredShop['status']; t: (en: string, zh?: string) => string }) {
  const label = status === 'active' ? t('Active', '营业中')
    : status === 'suspended' ? t('Suspended', '已暂停')
    : t('Pending', '待审核')
  const tone = status === 'active' ? 'text-oxblood' : 'text-rose-muted'
  return (
    <span className={`rounded-full border-[1.5px] border-clay-border bg-surface-sunken px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {label}
    </span>
  )
}
```

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/merchant/ReferralTab.tsx
git commit -m "feat(referral): Invited shops list in ReferralTab"
```

---

### Task 6: RLS integration test — capture & track isolation

**Files:**
- Create: `apps/backend/tests/rls/referral.test.ts`

**Interfaces:**
- Consumes: `hasEnv`, `makeUser`, `serviceClient` from `./helpers.js` (existing); the `my_referred_shops` RPC + `referred_by_code` column (Task 1).

- [ ] **Step 1: Write the test**

Create `apps/backend/tests/rls/referral.test.ts` (mirrors `isolation.test.ts`; skips when local Supabase env is absent):

```ts
// Security-critical: proves referral capture + track only ever exposes a referrer's own
// invited shops (three safe columns), never others'. Requires a running local Supabase
// with SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY set.
import { describe, it, expect, beforeAll } from 'vitest'
import { hasEnv, makeUser, serviceClient } from './helpers.js'

// Same derivation as referralCodeOf() in the frontend store.
const codeOf = (uid: string) => uid.replace(/-/g, '').slice(0, 8).toUpperCase()

describe.skipIf(!hasEnv)('referral capture & track (RLS)', () => {
  let userA: any, userC: any
  let uA: string

  beforeAll(async () => {
    const svc = serviceClient()

    userA = await makeUser('ref-a@test.dev', 'password123')
    const userB = await makeUser('ref-b@test.dev', 'password123')
    userC = await makeUser('ref-c@test.dev', 'password123')

    uA = (await userA.auth.getUser()).data.user!.id
    const uB = (await userB.auth.getUser()).data.user!.id
    const uC = (await userC.auth.getUser()).data.user!.id

    // A is the referrer.
    await svc.from('merchants').insert({ name: 'Shop A', slug: 'ref-shop-a', order_prefix: 'RA', owner_id: uA, status: 'active' })
    // B signed up with A's code.
    await svc.from('merchants').insert({ name: 'Shop B', slug: 'ref-shop-b', order_prefix: 'RB', owner_id: uB, status: 'pending', referred_by_code: codeOf(uA) })
    // C is unrelated (no referral).
    await svc.from('merchants').insert({ name: 'Shop C', slug: 'ref-shop-c', order_prefix: 'RC', owner_id: uC, status: 'active' })
  }, 30_000)

  it('referrer A sees shop B with its name, date and status', async () => {
    const { data, error } = await userA.rpc('my_referred_shops')
    expect(error).toBeNull()
    const b = data.find((r: any) => r.name === 'Shop B')
    expect(b).toBeTruthy()
    expect(b.status).toBe('pending')
    expect(b.created_at).toBeTruthy()
    // Only the three safe columns are returned.
    expect(Object.keys(b).sort()).toEqual(['created_at', 'name', 'status'])
  })

  it('unrelated user C sees no referred shops', async () => {
    const { data, error } = await userC.rpc('my_referred_shops')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})
```

- [ ] **Step 2: Run the RLS test**

Run: `pnpm --filter @bitetime/backend test:rls`
Expected: with local Supabase running (migration from Task 1 applied), the new suite passes. If the env vars are absent, the suite is skipped (`describe.skipIf(!hasEnv)`) and the command still exits green — in that case report DONE_WITH_CONCERNS noting the test could not run here and must be run against a local Supabase before merge.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/tests/rls/referral.test.ts
git commit -m "test(referral): RLS integration — capture & track isolation"
```

---

## Self-Review

**Spec coverage:**
- Data model: column + index + `my_referred_shops` RPC → Task 1. ✓ (search_path=public + schema-qualified + grant to authenticated + 3 columns + auth.uid()-derived filter, per Global Constraints, matching repo's `next_order_number`.)
- Pure normalize/validate + self-referral guard → Task 2. ✓ (circular-import avoided by passing ownerCode.)
- Capture at signup (`?ref` → createMerchant → column) → Task 3. ✓
- Track data (`ReferredShop` + `fetchReferredShops`) → Task 4. ✓
- Track UI (Invited shops: count, list name/date/status badge, empty + loading + error states, localized) → Task 5. ✓
- Unit tests (helper) → Task 2; RLS integration (A refers B, C sees nothing, only safe columns) → Task 6. ✓
- No reward logic / no backfill → no such task. ✓
- Run-and-verify UI → controller performs after Task 5 (needs merchant auth; documented at plan handoff).

**Placeholder scan:** none — every step carries real SQL/TS/commands.

**Type consistency:** `resolveReferredByCode(raw, ownerCode)` signature identical in Task 2 (def) and Task 3 (call, passing `referralCodeOf(user.id)`); `ReferredShop` fields identical across Task 4 (def), Task 5 (consumer), Task 1 (RPC return shape name/created_at/status); `fetchReferredShops(): Promise<ReferredShop[]>` consistent Task 4 → Task 5; RPC name `my_referred_shops` identical in Tasks 1, 4, 6; `referred_by_code` column name identical in Tasks 1, 3, 6.

**Note on verification dependencies:** Tasks 1 and 6 require a running local Supabase. If unavailable in the execution environment, those tasks are completed as written and reported DONE_WITH_CONCERNS; the migration + RLS test must be exercised against a local Supabase before merge. All frontend tasks (2–5) verify fully offline via Vitest/typecheck/lint.
