# Merchant Onboarding Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a newly-approved merchant a 3-step onboarding checklist card on the dashboard Overview that guides them to their first order, then celebrates and dismisses itself when done.

**Architecture:** A checklist card renders at the top of the Overview section (wired in `Dashboard.tsx` so it can drive section navigation). Two of the three steps are backed by new `boolean` flags on `merchants`, flipped by the merchant's own actions (saving Shipping settings; sharing the storefront link); the third (first product) is derived from the product count. When all three complete, the card flips to a celebration whose "Got it" button sets a `onboarding_dismissed` flag, hiding it forever.

**Tech Stack:** React 19 + Vite (frontend, TypeScript), Hono + postgres.js (backend, TypeScript), Supabase/Postgres migrations, Vitest.

## Global Constraints

- Monorepo: run all commands from repo root; `--filter @bitetime/<ws>` targets one workspace.
- Every user-facing string is `t(englishString, chineseString)` — no i18n library; `t` and `merchant` come from `useSession()`.
- Adding a migration file does NOT apply it — run `pnpm --filter @bitetime/backend db:migrate` (local) so PostgREST's schema cache sees new columns.
- All merchant-config writes go through `PATCH /api/merchants/:id`, which picks ONLY fields in `MERCHANT_CONFIG_FIELDS` (`apps/backend/src/writes.ts`). A column not in that allowlist is silently dropped — a new writable column MUST be added there.
- The backend `admin` client is RLS- and trigger-exempt; `writes.ts` allowlists are the only thing stopping privilege escalation. Booleans are validated as real booleans, never coerced from truthy values.
- Backend unit tests (`pnpm --filter @bitetime/backend test`) need no Supabase. Migrations/RLS are not exercised by unit tests.
- UI is verified by running the app (run-and-verify), per CLAUDE.md — not component tests. Pure logic gets Vitest unit tests.

---

### Task 1: Schema + backend write path for the onboarding flags

**Files:**
- Create: `apps/backend/supabase/migrations/20260723120000_merchant_onboarding.sql`
- Modify: `apps/backend/src/writes.ts` (add 3 fields to `MERCHANT_CONFIG_FIELDS`; add boolean validation in `pickMerchantConfig`)
- Test: `apps/backend/tests/unit/writes.test.ts` (new describe block)

**Interfaces:**
- Consumes: existing `pickMerchantConfig(body): PickResult` and `MERCHANT_CONFIG_FIELDS` in `writes.ts`.
- Produces: `merchants.onboarding_shipping_set`, `merchants.onboarding_link_shared`, `merchants.onboarding_dismissed` — all `boolean not null default false`, writable via `PATCH /api/merchants/:id`; non-boolean values are refused with `{ ok: false, error }`.

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260723120000_merchant_onboarding.sql`:

```sql
-- Merchant onboarding checklist (#102).
--
-- Two of the three checklist steps have no honest derivable signal: every shop
-- ships with default fulfilment methods on (so "set pickup/delivery" cannot be
-- read off the config), and "shared the order link" is an action that persists no
-- state. Each therefore gets an explicit boolean flag the merchant's own action
-- flips. The third step (first product) is derived from the product count and
-- needs no column. `onboarding_dismissed` hides the card once the merchant clears
-- the celebration.
--
-- Real columns rather than keys in the `config` jsonb: they are plain booleans read
-- alongside the row the dashboard already loads, and match the `tax_enabled` pattern.

alter table merchants
  add column onboarding_shipping_set boolean not null default false,
  add column onboarding_link_shared  boolean not null default false,
  add column onboarding_dismissed    boolean not null default false;

-- Every EXISTING shop predates onboarding and must never be shown the checklist.
-- Shops created after this migration start with all three false and see it.
update merchants set onboarding_dismissed = true;

comment on column merchants.onboarding_shipping_set is 'Merchant saved the Shipping settings tab at least once (#102).';
comment on column merchants.onboarding_link_shared is 'Merchant copied/opened/QR-shared the storefront link at least once (#102).';
comment on column merchants.onboarding_dismissed is 'Merchant cleared the onboarding checklist; card never shows again (#102).';
```

- [ ] **Step 2: Apply the migration locally**

Run: `pnpm --filter @bitetime/backend db:migrate`
Expected: migration applies without error; the three columns exist on `merchants`.
(If no local Supabase is running, `supabase start` from `apps/backend` first. This step is only needed to run the app later — the Task 1 unit test does not touch the DB.)

- [ ] **Step 3: Write the failing test**

Add to the end of `apps/backend/tests/unit/writes.test.ts`:

```ts
describe('pickMerchantConfig — onboarding flags (#102)', () => {
  it('accepts the three onboarding booleans', () => {
    expect(pickMerchantConfig({
      onboarding_shipping_set: true,
      onboarding_link_shared: true,
      onboarding_dismissed: true,
    })).toEqual({
      ok: true,
      patch: {
        onboarding_shipping_set: true,
        onboarding_link_shared: true,
        onboarding_dismissed: true,
      },
    })
  })

  it('passes a field through untouched when absent', () => {
    expect(pickMerchantConfig({ onboarding_link_shared: true })).toEqual({
      ok: true,
      patch: { onboarding_link_shared: true },
    })
  })

  it('refuses a non-boolean onboarding flag rather than coercing it', () => {
    expect(pickMerchantConfig({ onboarding_shipping_set: 'yes' }))
      .toEqual({ ok: false, error: expect.any(String) })
    expect(pickMerchantConfig({ onboarding_dismissed: 1 }))
      .toEqual({ ok: false, error: expect.any(String) })
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @bitetime/backend test -- writes`
Expected: FAIL — the "accepts the three onboarding booleans" case gets an empty `patch: {}` (fields not yet allowlisted), and the non-boolean case is accepted instead of refused.

- [ ] **Step 5: Add the fields to the allowlist**

In `apps/backend/src/writes.ts`, extend `MERCHANT_CONFIG_FIELDS`. Add this line inside the array (after the `origin_*` line, before the closing `] as const`):

```ts
  // Onboarding checklist flags (#102). Booleans flipped by the merchant's own
  // actions (saving Shipping; sharing the link) and the dismiss button.
  'onboarding_shipping_set', 'onboarding_link_shared', 'onboarding_dismissed',
```

- [ ] **Step 6: Add boolean validation**

In `apps/backend/src/writes.ts`, in `pickMerchantConfig`, extend the existing method-boolean loop. Change:

```ts
  for (const key of ['pickup_enabled', 'delivery_enabled', 'express_enabled'] as const) {
```

to:

```ts
  for (const key of [
    'pickup_enabled', 'delivery_enabled', 'express_enabled',
    'onboarding_shipping_set', 'onboarding_link_shared', 'onboarding_dismissed',
  ] as const) {
```

(The loop body already returns `{ ok: false, error: \`${key} must be a boolean\` }` for a non-boolean, so no other change is needed.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @bitetime/backend test -- writes`
Expected: PASS — all three new cases green, existing cases still green.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/supabase/migrations/20260723120000_merchant_onboarding.sql apps/backend/src/writes.ts apps/backend/tests/unit/writes.test.ts
git commit -m "feat(onboarding): merchants onboarding flags + write path (#102)"
```

---

### Task 2: `onboardingSteps` helper + Merchant type fields

**Files:**
- Create: `apps/frontend/src/merchant/onboardingSteps.ts`
- Create: `apps/frontend/src/merchant/onboardingSteps.test.ts`
- Modify: `apps/frontend/src/types.ts` (3 fields on `Merchant`)

**Interfaces:**
- Consumes: `Merchant` type from `../types`.
- Produces: `onboardingSteps(merchant: Merchant, productCount: number): OnboardingState` where `OnboardingState = { product: boolean; shipping: boolean; link: boolean; doneCount: number; allDone: boolean }`.

- [ ] **Step 1: Add the Merchant type fields**

In `apps/frontend/src/types.ts`, inside `export interface Merchant`, add before the `[key: string]: any` line:

```ts
  /** Onboarding checklist flags (#102). Read via `onboardingSteps`; absent means false. */
  onboarding_shipping_set?: boolean
  onboarding_link_shared?: boolean
  onboarding_dismissed?: boolean
```

- [ ] **Step 2: Write the failing test**

Create `apps/frontend/src/merchant/onboardingSteps.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { onboardingSteps } from './onboardingSteps'
import type { Merchant } from '../types'

const base: Merchant = { id: 'm1', name: 'Shop', slug: 'shop', status: 'active' }

describe('onboardingSteps (#102)', () => {
  it('all three incomplete for a fresh shop', () => {
    expect(onboardingSteps(base, 0)).toEqual({
      product: false, shipping: false, link: false, doneCount: 0, allDone: false,
    })
  })

  it('product step is derived from the product count', () => {
    expect(onboardingSteps(base, 3).product).toBe(true)
    expect(onboardingSteps(base, 0).product).toBe(false)
  })

  it('shipping and link steps come from the flags', () => {
    const m = { ...base, onboarding_shipping_set: true, onboarding_link_shared: true }
    const s = onboardingSteps(m, 0)
    expect(s.shipping).toBe(true)
    expect(s.link).toBe(true)
    expect(s.doneCount).toBe(2)
    expect(s.allDone).toBe(false)
  })

  it('allDone only when all three are satisfied', () => {
    const m = { ...base, onboarding_shipping_set: true, onboarding_link_shared: true }
    const s = onboardingSteps(m, 1)
    expect(s.doneCount).toBe(3)
    expect(s.allDone).toBe(true)
  })

  it('treats absent flags as false, not truthy', () => {
    expect(onboardingSteps(base, 1)).toMatchObject({ shipping: false, link: false })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @bitetime/frontend test -- onboardingSteps`
Expected: FAIL — `onboardingSteps` is not defined / module not found.

- [ ] **Step 4: Write the helper**

Create `apps/frontend/src/merchant/onboardingSteps.ts`:

```ts
import type { Merchant } from '../types'

export interface OnboardingState {
  product: boolean
  shipping: boolean
  link: boolean
  doneCount: number
  allDone: boolean
}

// Derives the three onboarding checklist steps. `product` is read from the live
// product count; `shipping` and `link` are persisted flags on the merchant row —
// read `=== true` so an absent (undefined) column is false, never truthy.
export function onboardingSteps(merchant: Merchant, productCount: number): OnboardingState {
  const product = productCount > 0
  const shipping = merchant.onboarding_shipping_set === true
  const link = merchant.onboarding_link_shared === true
  const doneCount = [product, shipping, link].filter(Boolean).length
  return { product, shipping, link, doneCount, allDone: doneCount === 3 }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @bitetime/frontend test -- onboardingSteps`
Expected: PASS — all five cases green.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/types.ts apps/frontend/src/merchant/onboardingSteps.ts apps/frontend/src/merchant/onboardingSteps.test.ts
git commit -m "feat(onboarding): onboardingSteps helper + Merchant flag types (#102)"
```

---

### Task 3: OnboardingChecklist card + Dashboard wire-in

**Files:**
- Create: `apps/frontend/src/merchant/OnboardingChecklist.tsx`
- Modify: `apps/frontend/src/merchant/Dashboard.tsx` (import + render on the overview section)

**Interfaces:**
- Consumes: `onboardingSteps` (Task 2); `useSession()` (`t`, `merchant`, `refreshMerchant`); `fetchProducts`, `updateMerchantConfig` from `../store`; `storefrontUrl` from `../storefrontUrl`; `Card`/`Button` from the UI kit; `selectSection` (the guarded section switch already in `DashboardInner`).
- Produces: `default export OnboardingChecklist({ onNavigate }: { onNavigate: (section: string) => void })`.

- [ ] **Step 1: Write the component**

Create `apps/frontend/src/merchant/OnboardingChecklist.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Circle, CheckCircle2, PartyPopper, ChevronRight, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { fetchProducts, updateMerchantConfig } from '../store'
import { storefrontUrl } from '../storefrontUrl'
import { onboardingSteps } from './onboardingSteps'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const ICON = { size: 20, strokeWidth: 1.75 }

// Onboarding checklist (#102). Renders at the top of the Overview section while a
// shop is still finding its feet, and never after the merchant dismisses the
// finished-state celebration. `onNavigate` jumps to the section that completes a
// step — the "hand to hand" guidance from the issue.
export default function OnboardingChecklist({ onNavigate }: { onNavigate: (section: string) => void }) {
  const { t, merchant, refreshMerchant } = useSession()
  const [productCount, setProductCount] = useState<number | null>(null)
  const [dismissing, setDismissing] = useState(false)

  useEffect(() => {
    const id = merchant?.id
    if (!id) return
    let active = true
    fetchProducts(id).then(ps => { if (active) setProductCount(ps.length) })
    return () => { active = false }
  }, [merchant?.id])

  // Hidden entirely once dismissed. Also wait for the product count before deciding
  // done-ness, so the card never flashes a wrong 0/3 for a shop with products.
  if (!merchant || merchant.onboarding_dismissed) return null
  if (productCount === null) return null

  const state = onboardingSteps(merchant, productCount)
  const url = storefrontUrl(merchant.slug, window.location.origin)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('Link copied', '链接已复制'))
    } catch {
      toast.error(t('Could not copy — copy it manually', '无法复制 — 请手动复制'))
    }
  }

  const dismiss = async () => {
    setDismissing(true)
    try {
      await updateMerchantConfig(merchant.id, { onboarding_dismissed: true })
      await refreshMerchant()
    } catch (e: any) {
      toast.error(e.message || t('Could not dismiss — try again', '无法关闭 — 请重试'))
      setDismissing(false)
    }
  }

  if (state.allDone) {
    return (
      <Card className="mb-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PartyPopper {...ICON} /> {t('Your shop is ready!', '您的店铺已就绪！')}
          </CardTitle>
          <CardDescription>
            {t('Copy your order link and start accepting orders.', '复制您的下单链接，开始接单。')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" className="w-auto" onClick={copy}>
            <Copy /> {t('Copy order link', '复制下单链接')}
          </Button>
          <Button variant="outline" size="sm" className="w-auto" onClick={dismiss} disabled={dismissing}>
            {dismissing ? t('Dismissing…', '关闭中…') : t('Got it', '知道了')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  const remaining = 3 - state.doneCount
  const rows = [
    { done: state.product,  label: t('Add your first product', '添加您的第一个产品'), section: 'products' },
    { done: state.shipping, label: t('Set your pickup / delivery', '设置自取 / 送货'),  section: 'settings' },
    { done: state.link,     label: t('Share your order link', '分享您的下单链接'),      section: 'overview' },
  ]

  return (
    <Card className="mb-5">
      <CardHeader>
        <CardTitle>{t('🎉 Welcome to TinyOrder', '🎉 欢迎使用 TinyOrder')}</CardTitle>
        <CardDescription>
          {t(
            `You’re only ${remaining} step${remaining === 1 ? '' : 's'} away from accepting your first order.`,
            `距离接收第一笔订单只差 ${remaining} 步。`,
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {rows.map(r => (
          <button
            key={r.section + r.label}
            type="button"
            onClick={() => onNavigate(r.section)}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-ink transition-colors hover:bg-surface-sunken"
          >
            {r.done
              ? <CheckCircle2 {...ICON} className="shrink-0 text-oxblood" />
              : <Circle {...ICON} className="shrink-0 text-rose-muted" />}
            <span className={r.done ? 'text-rose-muted line-through' : ''}>{r.label}</span>
            {!r.done && <ChevronRight size={16} strokeWidth={1.75} className="ml-auto shrink-0 text-rose-muted" />}
          </button>
        ))}
        <p className="mt-2 px-3 text-[13px] font-medium text-oxblood">
          {t(`Progress · ${state.doneCount} / 3 Complete`, `进度 · ${state.doneCount} / 3 完成`)}
        </p>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Wire it into the Dashboard**

In `apps/frontend/src/merchant/Dashboard.tsx`, add the import beside the other merchant imports (after `import Overview from './Overview'`):

```tsx
import OnboardingChecklist from './OnboardingChecklist'
```

Then, in `DashboardInner`'s returned JSX, insert the checklist between `<BillingBanner />` and the animated section `<div>`. Change:

```tsx
      <BillingBanner />
      <div key={section} {...enter}>
```

to:

```tsx
      <BillingBanner />
      {section === 'overview' && <OnboardingChecklist onNavigate={selectSection} />}
      <div key={section} {...enter}>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS — no type errors.

- [ ] **Step 4: Run-and-verify in the app**

Start local Supabase + dev servers (`supabase start` in `apps/backend` if needed, then `pnpm dev`). As a fresh, approved merchant with no products:
- Overview shows the "🎉 Welcome to TinyOrder" card at `0 / 3 Complete` above the storefront-link card.
- Clicking "Add your first product" switches to the Products section; "Set your pickup / delivery" switches to Settings; "Share your order link" stays on Overview.
- The card is absent for a backfilled existing shop (`onboarding_dismissed = true`).

(Flag-flip → tick behaviour and the celebration/dismiss are verified in Task 4, once the flips are wired. At this point only the product step can tick.)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/OnboardingChecklist.tsx apps/frontend/src/merchant/Dashboard.tsx
git commit -m "feat(onboarding): checklist card on dashboard overview (#102)"
```

---

### Task 4: Flip the shipping + link flags from merchant actions

**Files:**
- Modify: `apps/frontend/src/merchant/ShopSettings.tsx` (`ShippingTab.save()` payload)
- Modify: `apps/frontend/src/merchant/ShareStorefront.tsx` (copy / open / QR flip the link flag)

**Interfaces:**
- Consumes: `updateMerchantConfig` from `../store`; `refreshMerchant` from `useSession()`; the `onboarding_shipping_set` / `onboarding_link_shared` fields accepted by the write path (Task 1).
- Produces: side effects only — `onboarding_shipping_set` set true on first Shipping save; `onboarding_link_shared` set true on first share action.

- [ ] **Step 1: Flip the shipping flag on Shipping save**

In `apps/frontend/src/merchant/ShopSettings.tsx`, inside `ShippingTab`'s `save()`, in the `updateMerchantConfig(merchant!.id, { ... })` call, add the flag. Change the first line of that object literal from:

```tsx
      const shipping = shopRates({ WM: fields.wm, EM: fields.em })
      await updateMerchantConfig(merchant!.id, {
        shipping,
```

to:

```tsx
      const shipping = shopRates({ WM: fields.wm, EM: fields.em })
      await updateMerchantConfig(merchant!.id, {
        shipping,
        // Saving the Shipping tab completes the onboarding "set pickup / delivery"
        // step (#102). Idempotent — already true after the first save.
        onboarding_shipping_set: true,
```

- [ ] **Step 2: Flip the link flag from ShareStorefront actions**

In `apps/frontend/src/merchant/ShareStorefront.tsx`:

Add `updateMerchantConfig` to the store import. Change:

```tsx
import { useSession } from '../SessionContext'
import { storefrontUrl } from '../storefrontUrl'
```

to:

```tsx
import { useSession } from '../SessionContext'
import { updateMerchantConfig } from '../store'
import { storefrontUrl } from '../storefrontUrl'
```

Pull `refreshMerchant` from the session. Change:

```tsx
  const { t, merchant } = useSession()
```

to:

```tsx
  const { t, merchant, refreshMerchant } = useSession()
```

Add a `markShared` helper and call it from the copy handler. Change:

```tsx
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('Link copied', '链接已复制'))
    } catch {
      toast.error(t('Could not copy — copy it manually', '无法复制 — 请手动复制'))
    }
  }
```

to:

```tsx
  // Sharing the link — by copy, open, or QR — completes the onboarding "share your
  // order link" step (#102). Fire-and-forget and guarded to fire at most once: a
  // failed flag write must never block or fail the share the merchant asked for.
  const markShared = () => {
    if (!merchant.onboarding_link_shared) {
      updateMerchantConfig(merchant.id, { onboarding_link_shared: true })
        .then(refreshMerchant)
        .catch(() => {})
    }
  }

  const copy = async () => {
    markShared()
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('Link copied', '链接已复制'))
    } catch {
      toast.error(t('Could not copy — copy it manually', '无法复制 — 请手动复制'))
    }
  }
```

Call `markShared` from the "Open storefront" link and the "QR code" button. Change:

```tsx
            <Button variant="outline" size="sm" className="w-auto" render={<a href={url} target="_blank" rel="noopener" />}>
              <ExternalLink /> {t('Open storefront', '打开店铺')}
            </Button>
            <Button variant="outline" size="sm" className="w-auto" onClick={() => setQrOpen(true)}>
              <QrCode /> {t('QR code', '二维码')}
            </Button>
```

to:

```tsx
            <Button variant="outline" size="sm" className="w-auto" onClick={markShared} render={<a href={url} target="_blank" rel="noopener" />}>
              <ExternalLink /> {t('Open storefront', '打开店铺')}
            </Button>
            <Button variant="outline" size="sm" className="w-auto" onClick={() => { markShared(); setQrOpen(true) }}>
              <QrCode /> {t('QR code', '二维码')}
            </Button>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS.

- [ ] **Step 4: Run-and-verify the full flow**

As a fresh, approved merchant (all three flags false, card at `0 / 3`):
- Add a product → Overview checklist shows "Add your first product" ticked (1/3).
- Save the Shipping settings tab → "Set your pickup / delivery" ticked (2/3).
- Copy / open / QR the storefront link on Overview → "Share your order link" ticked; card flips to "🎉 Your shop is ready!".
- Click **Got it** → card disappears; reload the dashboard → card stays gone (`onboarding_dismissed` persisted).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/ShopSettings.tsx apps/frontend/src/merchant/ShareStorefront.tsx
git commit -m "feat(onboarding): flip shipping + link flags from merchant actions (#102)"
```

---

## Self-Review

**Spec coverage:**
- Placement (Overview, wired in Dashboard, above section content) → Task 3. ✅
- Completion signals (product derived, shipping flag, link flag) → Task 2 (helper) + Task 4 (flips). ✅
- Schema (3 booleans + backfill) → Task 1. ✅
- Write-path allowlist + boolean validation → Task 1. ✅
- Merchant type fields → Task 2. ✅
- Card states (incomplete / celebration / dismissed) → Task 3. ✅
- Share-link row targets `overview`; flag flipped by ShareStorefront buttons → Task 3 (row) + Task 4 (flip). ✅
- "Set pickup / delivery" = Shipping tab, jumps to `settings` → Task 3 (row) + Task 4 (flip). ✅
- Testing (pure helper unit test, backend allowlist test, run-and-verify) → Tasks 1–4. ✅
- Out of scope items (takeover, emails, re-show) → not planned. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✅

**Type consistency:** `onboardingSteps(merchant, productCount) → OnboardingState { product, shipping, link, doneCount, allDone }` defined in Task 2, consumed identically in Task 3. `onboarding_shipping_set` / `onboarding_link_shared` / `onboarding_dismissed` named identically across migration (Task 1), allowlist (Task 1), type (Task 2), helper (Task 2), component (Task 3), flips (Task 4). ✅
