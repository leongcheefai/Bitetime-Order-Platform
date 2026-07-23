# Fulfilment Methods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant choose which of three fulfilment methods — pickup, delivery (flat region rate) and express delivery (distance-priced) — their storefront offers, with at least one always enabled.

**Architecture:** `merchants.shipping_mode` is deleted and replaced by three independent boolean columns. "Which rule prices a delivery" stops being a shop-level fact and becomes a property of the method the customer picked: `delivery` → region rate, `express` → `base + rate × routed km`. A new shared row→domain mapper, `shopMethods`, is the single reading of those columns on both sides of the wire, exactly as `shopRates` / `shopTax` / `shopDistance` already are.

**Tech Stack:** pnpm + Turborepo monorepo; TypeScript throughout; Hono + postgres.js + supabase-js on the backend; React 19 + Vite + Tailwind on the frontend; Vitest for tests; Supabase/Postgres migrations.

**Spec:** `docs/superpowers/specs/2026-07-22-fulfilment-methods-design.md`
**Issue:** [#103](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/103) — **Branch:** `feat/distance-delivery-fees` — **PR:** [#104](https://github.com/leongcheefai/Bitetime-Order-Platform/pull/104)

## Global Constraints

- **Everything lands on the existing branch `feat/distance-delivery-fees`.** Do not create a new branch and do not open a second PR.
- **Rewrite `apps/backend/supabase/migrations/20260722120000_distance_shipping.sql` in place.** Do not add a follow-on migration. This is safe *only* because PR #104 is unmerged and the column has never reached a remote project. After rewriting it, the local DB must be reset — `cd apps/backend && supabase db reset` — because `db:migrate` will not re-run an already-applied file.
- **Method names on the wire and in the database are exactly `pickup`, `delivery`, `express`.**
- **Customer-facing labels are exactly:** `Pickup` / `自取`, `Delivery` / `送货`, `Express delivery` / `快速配送`. Every user-visible string in this repo is written `t(english, chinese)` — there is no i18n library.
- **Fail closed.** A shop with no method enabled offers nothing and takes no order. Never fall back to pickup, and never fall back from express pricing to the region rate.
- **`'sameday'` is deleted**, not deprecated: from `PriceInput['mode']`, from `shippingFee`'s `samedayFee` parameter, and from `MODE_LABELS` in `OrdersView.tsx`.
- **Per-task gate.** Every task ends with all three of these green, from the repo root:
  ```bash
  pnpm typecheck && pnpm lint && pnpm test
  ```
  Tasks that touch the database or the backend routes additionally run `pnpm --filter @bitetime/backend test:db`, which needs a local Supabase (`cd apps/backend && supabase start`).
- **Never mock the database** in `apps/backend/tests/rls/` or `apps/backend/tests/api/`. Those suites exist to prove properties of real Postgres.
- **Backend relative imports keep their `.js` specifiers** (`NodeNext` resolution) even though the files are `.ts`. Frontend imports are extensionless. Do not "fix" either.
- **UI is verified by running the app**, not by component tests (CLAUDE.md). Tasks 8 and 9 have manual verification steps instead of component tests.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/frontend/src/fulfilmentLabel.ts` | The one frontend mapping from a `mode` value to its bilingual label. Replaces three hand-rolled ternaries. |
| `apps/frontend/src/fulfilmentLabel.test.ts` | Unit tests for the above. |
| `docs/adr/0002-fulfilment-methods-coexist.md` | Why region and distance pricing stopped being exclusive. |

**Modified:**

| File | Change |
|---|---|
| `packages/shared/src/pricing.ts` | Adds `shopMethods` + `FulfilmentMethod`; `shopDistance` gates on `express_enabled`; `PriceInput['mode']` gains `express`, loses `sameday`. |
| `packages/shared/src/index.ts` | Re-exports the new symbols. |
| `packages/shared/src/pricing.test.ts` | Tests for all of the above. |
| `apps/backend/supabase/migrations/20260722120000_distance_shipping.sql` | `shipping_mode` → three boolean flags + two CHECK constraints. |
| `apps/backend/src/writes.ts` | Column allowlist + boolean validation. |
| `apps/backend/src/app.ts` | Merchant PATCH validation; quote-endpoint gate; intake mode allowlist. |
| `apps/backend/src/orders.ts` | Mode union; `method_not_offered`; express pricing path; SQL select lists. |
| `apps/backend/src/notify.ts` | Telegram mode label. |
| `apps/backend/tests/rls/helpers.ts` | Merchant fixture columns. |
| `apps/backend/tests/api/*.test.ts` | New and updated assertions. |
| `apps/frontend/src/types.ts` | `Merchant` row type. |
| `apps/frontend/src/store.ts` | `placeOrder` mode union. |
| `apps/frontend/src/savedDetails.ts` | Address-saving rule. |
| `apps/frontend/src/merchant/ShopSettings.tsx` | Three checkboxes; both rate cards. |
| `apps/frontend/src/merchant/settingsDirty.ts` | Field type. |
| `apps/frontend/src/merchant/OrdersView.tsx` | Uses `fulfilmentLabel`. |
| `apps/frontend/src/store/Storefront.tsx` | Three buttons; per-mode address form; conditional pickup copy. |
| `apps/frontend/src/store/ReceiptDialog.tsx` | Uses `fulfilmentLabel`; express fee line. |
| `apps/frontend/src/store/OrderHistory.tsx` | Uses `fulfilmentLabel`; express fee line. |
| `CONTEXT.md` | *Shipping policy* → *Fulfilment methods*. |
| `docs/adr/0001-distance-fees-from-a-cached-google-route.md` | Superseding note. |

**Task order rationale.** Task 2 is the column rename cascade and is deliberately the one place `shipping_mode` disappears from SQL, TypeScript and fixtures at once — a select list naming a dropped column is a runtime 500, so those cannot be split across commits. To keep every other task small, Task 2 leaves `ShopDistance.mode` in place as a derived compatibility field; Task 10 deletes it once no reader is left.

**Known temporary inconsistency.** Between Task 4 and Task 9 the backend prices express orders but the storefront still submits `mode: 'delivery'` at an express shop. Typecheck and all suites stay green throughout; the storefront is simply not yet offering the new method. Do not "fix" this early — Task 9 is where it lands.

---

### Task 1: `shopMethods` — the shared row→domain mapper

**Files:**
- Modify: `packages/shared/src/pricing.ts` (append after `shopDistance`'s helpers, near `shopTax`)
- Modify: `packages/shared/src/index.ts:14-23`
- Test: `packages/shared/src/pricing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type FulfilmentMethod = 'pickup' | 'delivery' | 'express'
  export const FULFILMENT_METHODS: readonly FulfilmentMethod[]   // ['pickup','delivery','express']
  export interface ShopMethods { pickup: boolean; delivery: boolean; express: boolean }
  export function shopMethods(row: unknown): ShopMethods
  export function offersMethod(methods: ShopMethods, mode: string): boolean
  export function firstOfferedMethod(methods: ShopMethods): FulfilmentMethod | null
  ```

This lives in `pricing.ts`, beside `shopRates` / `shopTax` / `shopDistance`, because it is a member of that mapper family and `mode` is a pricing input. It does **not** go in `fulfilment.ts` — that file is the fulfilment *date window*, an unrelated thing that happens to share a word.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/pricing.test.ts`. Add `shopMethods, offersMethod, firstOfferedMethod` to the existing `import { ... } from './pricing.js'` at the top of the file.

```ts
describe('shopMethods', () => {
  it('reads the three flags off the row', () => {
    expect(shopMethods({ pickup_enabled: true, delivery_enabled: false, express_enabled: true }))
      .toEqual({ pickup: true, delivery: false, express: true })
  })

  it('falls back to each column\'s own default for a row that predates them', () => {
    // A pre-#103 row, or a fixture that names none of them: the shop is exactly what it was
    // before this feature — pickup and delivery on, express off.
    expect(shopMethods({})).toEqual({ pickup: true, delivery: true, express: false })
    expect(shopMethods(null)).toEqual({ pickup: true, delivery: true, express: false })
  })

  it('honours an explicit false', () => {
    expect(shopMethods({ pickup_enabled: false }).pickup).toBe(false)
  })

  it('treats a non-boolean as absent rather than coercing it', () => {
    // Both drivers hand these back as real booleans. Anything else is a fixture or a bug, and
    // guessing what 'false' or 0 meant is how a shop starts offering a method it switched off.
    expect(shopMethods({ pickup_enabled: 'false' }).pickup).toBe(true)
    expect(shopMethods({ express_enabled: 1 }).express).toBe(false)
  })

  it('reports all-false as all-false — it does not fall back to pickup', () => {
    // FAILS CLOSED. A shop offering nothing takes no order; inventing pickup here would offer a
    // method the merchant switched off. Unreachable past merchants_one_fulfilment_method, and
    // guarded anyway, because that is the direction this whole family fails in.
    const none = { pickup_enabled: false, delivery_enabled: false, express_enabled: false }
    expect(shopMethods(none)).toEqual({ pickup: false, delivery: false, express: false })
    expect(firstOfferedMethod(shopMethods(none))).toBeNull()
  })
})

describe('offersMethod', () => {
  const methods = { pickup: true, delivery: false, express: true }

  it('answers for each of the three methods', () => {
    expect(offersMethod(methods, 'pickup')).toBe(true)
    expect(offersMethod(methods, 'delivery')).toBe(false)
    expect(offersMethod(methods, 'express')).toBe(true)
  })

  it('refuses a mode that is not a method at all', () => {
    expect(offersMethod(methods, 'sameday')).toBe(false)
    expect(offersMethod(methods, '')).toBe(false)
  })
})

describe('firstOfferedMethod', () => {
  it('prefers pickup, then delivery, then express', () => {
    expect(firstOfferedMethod({ pickup: true, delivery: true, express: true })).toBe('pickup')
    expect(firstOfferedMethod({ pickup: false, delivery: true, express: true })).toBe('delivery')
    expect(firstOfferedMethod({ pickup: false, delivery: false, express: true })).toBe('express')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @bitetime/shared test -- --run pricing.test.ts
```
Expected: FAIL — `SyntaxError` / `does not provide an export named 'shopMethods'`.

- [ ] **Step 3: Implement the mapper**

Append to `packages/shared/src/pricing.ts`, immediately after `exceedsMaxKm`:

```ts
/** The three things a customer can choose. A closed set: `mode` selects the shipping fee. */
export type FulfilmentMethod = 'pickup' | 'delivery' | 'express'

/** Precedence order, and the order the storefront renders them in. */
export const FULFILMENT_METHODS: readonly FulfilmentMethod[] = ['pickup', 'delivery', 'express']

export interface ShopMethods {
  pickup: boolean
  /** Flat region rate (WM/EM). */
  delivery: boolean
  /** Distance-priced: `base + rate × routed km`. Read the rates through `shopDistance`. */
  express: boolean
}

/**
 * A merchant row → the methods this shop offers. The fourth of `shopRates`', `shopTax`'s and
 * `shopDistance`'s family, and it exists for the identical reason: the storefront decides which
 * buttons to render from it and the backend refuses an unoffered method from it, and the two
 * disagreeing is a refused checkout, not a cosmetic gap.
 *
 * A NON-BOOLEAN reads as absent, so it takes that column's own default. Both drivers hand these
 * columns back as real booleans, so anything else is a fixture or a bug — and coercing `'false'`
 * or `0` is how a shop starts offering a method its merchant switched off.
 *
 * ALL THREE FALSE IS RETURNED AS-IS. It is not repaired into pickup: a shop that offers nothing
 * takes no order, and the callers refuse. That is the same direction `ShopDistance.usable` fails
 * in, for the same reason. `merchants_one_fulfilment_method` makes it unconstructible anyway.
 */
export function shopMethods(row: unknown): ShopMethods {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  return {
    pickup: flag(r.pickup_enabled, true),
    delivery: flag(r.delivery_enabled, true),
    express: flag(r.express_enabled, false),
  }
}

/** Does this shop offer the method the customer asked for? Any other string is not a method. */
export function offersMethod(methods: ShopMethods, mode: string): boolean {
  return (FULFILMENT_METHODS as readonly string[]).includes(mode)
    && methods[mode as FulfilmentMethod]
}

/**
 * The method a storefront lands on. `null` when the shop offers none — which is a REFUSAL to
 * take an order, never a reason to invent pickup.
 */
export function firstOfferedMethod(methods: ShopMethods): FulfilmentMethod | null {
  return FULFILMENT_METHODS.find(m => methods[m]) ?? null
}
```

- [ ] **Step 4: Export from the package index**

In `packages/shared/src/index.ts`, extend the two `from './pricing.js'` blocks:

```ts
export {
  priceOrder, voucherError, shippingFee, voucherFromRow, shopRates, shopTax,
  promoState, promoClaims, productFromRow,
  shopDistance, routedKm, distanceFee, exceedsMaxKm,
  shopMethods, offersMethod, firstOfferedMethod, FULFILMENT_METHODS,
  EM_STATES, DEFAULT_WM_RATE,
} from './pricing.js'
export type {
  PriceInput, PriceBreakdown, PriceLine,
  VoucherCtx, VoucherErrorCode,
  PricedProduct, PricedVoucher, PromoState, ShopTax, ShopDistance,
  ShopMethods, FulfilmentMethod,
} from './pricing.js'
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @bitetime/shared test -- --run pricing.test.ts
```
Expected: PASS, all `shopMethods` / `offersMethod` / `firstOfferedMethod` cases green.

- [ ] **Step 6: Run the full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all green. This task is purely additive — nothing else reads these symbols yet.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/pricing.ts packages/shared/src/index.ts packages/shared/src/pricing.test.ts
git commit -m "feat(shared): one mapper for the methods a shop offers

The storefront decides which buttons to render and the backend refuses a
method the shop does not offer. Two readings of those columns is a
refused checkout, so shopMethods joins shopRates, shopTax and
shopDistance as the single one.

All three false is returned as-is rather than repaired into pickup: a
shop that offers nothing takes no order, and inventing a method the
merchant switched off is the failure direction this family refuses in."
```

---

### Task 2: The column cascade — `shipping_mode` out, three flags in

**Files:**
- Modify: `apps/backend/supabase/migrations/20260722120000_distance_shipping.sql`
- Modify: `packages/shared/src/pricing.ts` (`ShopDistance`, `shopDistance`)
- Modify: `packages/shared/src/pricing.test.ts` (the `DISTANCE_ROW` fixture and the `shopDistance` block)
- Modify: `apps/backend/src/writes.ts:22` and `:78-80`
- Modify: `apps/backend/src/orders.ts:368` and `:471`
- Modify: `apps/backend/src/app.ts:1017`
- Modify: `apps/backend/tests/rls/helpers.ts:82` and `:99`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ShopDistance` gains `enabled: boolean` and keeps `mode: 'region' | 'distance'` as a **derived compatibility field**, removed in Task 10. `usable` keeps its meaning and its contract.

A SQL select list naming a dropped column is a runtime 500, so the migration and every reader of `shipping_mode` change in one commit. That is what makes this task bigger than its neighbours and why it cannot be split.

- [ ] **Step 1: Rewrite the migration**

In `apps/backend/supabase/migrations/20260722120000_distance_shipping.sql`, replace the `shipping_mode` column and the `merchants_shipping_mode_valid` / `merchants_distance_requires_origin` constraints and the `shipping_mode` comment. The `distance_quotes` table, the `orders` columns and every other constraint stay exactly as they are.

```sql
-- Every default keeps an existing shop EXACTLY where it is: pickup and delivery on, express off.

alter table merchants
  add column pickup_enabled       boolean       not null default true,
  add column delivery_enabled     boolean       not null default true,
  add column express_enabled      boolean       not null default false,
  add column delivery_base_fee    numeric(10,2) not null default 0,
  add column delivery_rate_per_km numeric(10,2) not null default 0,
  -- null = no limit. NOT "0 = no limit": 0 would be an honest "deliver nowhere" and the two
  -- must not collide.
  add column delivery_max_km      numeric(6,1),
  add column origin_place_id      text,
  add column origin_lat           numeric(9,6),
  add column origin_lng           numeric(9,6),
  add column origin_address       text;

alter table merchants
  -- The rule #103 rests on, so it is a database fact and not a UI courtesy: a shop that offers
  -- nothing has a storefront no customer can order from, and no save may produce one.
  add constraint merchants_one_fulfilment_method
    check (pickup_enabled or delivery_enabled or express_enabled),
  add constraint merchants_delivery_base_fee_nonneg
    check (delivery_base_fee >= 0),
  add constraint merchants_delivery_rate_nonneg
    check (delivery_rate_per_km >= 0),
  add constraint merchants_delivery_max_km_positive
    check (delivery_max_km is null or delivery_max_km > 0),
  -- The validation that makes "you cannot half-configure your way into quoting nothing" a
  -- database fact rather than a UI courtesy: express REQUIRES an origin to route from.
  -- `nullif(origin_place_id, '')`, not a bare `is not null`: an EMPTY STRING is not null and
  -- would otherwise slip straight through, leaving an express shop with no real origin to
  -- route from — refused too.
  add constraint merchants_express_requires_origin
    check (not express_enabled or nullif(origin_place_id, '') is not null);

comment on column merchants.delivery_enabled is
  'Offers flat region-rate delivery (WM/EM). Independent of express_enabled — a shop may offer both.';
comment on column merchants.express_enabled is
  'Offers distance-priced express delivery (base + rate x km). Requires an origin to route from.';
comment on column merchants.delivery_max_km is
  'Routed km beyond which this shop does not deliver by express. NULL = no limit.';
comment on column merchants.origin_place_id is
  'The delivery origin''s Google place id — the routing origin AND the distance cache key. A merchant who moves changes this and so invalidates their own cached distances.';
```

- [ ] **Step 2: Reset the local database**

```bash
cd apps/backend && supabase db reset && cd ../..
```
Expected: every migration replays; the final output names no errors. `db:migrate` will **not** do this — it skips a file already recorded as applied.

- [ ] **Step 3: Write the failing tests for the new gate**

In `packages/shared/src/pricing.test.ts`, change the shared fixture and add two cases. Find `const DISTANCE_ROW = {` (around line 539) and replace `shipping_mode: 'distance',` with `express_enabled: true,`. Then in the `describe('shopDistance', …)` block replace the two `shipping_mode` tests:

```ts
  it('is dormant when express is off, whatever the rates say', () => {
    const p = shopDistance({ express_enabled: false, delivery_base_fee: 6, origin_place_id: 'x' })
    expect(p.enabled).toBe(false)
    expect(p.usable).toBe(false)
  })

  it('treats a missing express_enabled as off — every shop that predates this feature', () => {
    expect(shopDistance({}).enabled).toBe(false)
    expect(shopDistance(null).enabled).toBe(false)
  })
```

- [ ] **Step 4: Run them to verify they fail**

```bash
pnpm --filter @bitetime/shared test -- --run pricing.test.ts
```
Expected: FAIL — `expected undefined to be false` on `p.enabled`, plus the `DISTANCE_ROW` cases failing because `shipping_mode` no longer switches anything on.

- [ ] **Step 5: Flip `shopDistance`'s gate**

In `packages/shared/src/pricing.ts`, in `interface ShopDistance` replace the `mode` field's declaration with:

```ts
export interface ShopDistance {
  /** Express delivery is switched on for this shop. Its configuration stays stored when off. */
  enabled: boolean
  /**
   * @deprecated Derived from `enabled` purely so #103's cascade can land in small commits.
   * Delete this field, and its last readers, in Task 10.
   */
  mode: 'region' | 'distance'
```

and in `shopDistance` replace the `const mode = …` line and the `usable` / return expressions:

```ts
export function shopDistance(row: unknown): ShopDistance {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const enabled = r.express_enabled === true
  const base = num(r.delivery_base_fee)
  const ratePerKm = num(r.delivery_rate_per_km)
  const maxKmRaw = num(r.delivery_max_km)
  const originPlaceId = typeof r.origin_place_id === 'string' && r.origin_place_id ? r.origin_place_id : null

  const usable =
    enabled &&
    originPlaceId !== null &&
    base !== null && base >= 0 &&
    ratePerKm !== null && ratePerKm >= 0 &&
    (r.delivery_max_km == null || (maxKmRaw !== null && maxKmRaw > 0))

  return {
    enabled,
    mode: enabled ? 'distance' : 'region',
    base: base ?? 0,
    ratePerKm: ratePerKm ?? 0,
    maxKm: maxKmRaw !== null && maxKmRaw > 0 ? maxKmRaw : null,
    originPlaceId,
    usable,
  }
}
```

Also update the doc comment above `usable` inside the interface: replace both occurrences of "Distance mode" with "Express enabled", and "Meaningless in region mode" with "Meaningless when express is off".

- [ ] **Step 6: Swap the column in every SQL select list and allowlist**

`apps/backend/src/writes.ts:22` — in `MERCHANT_CONFIG_FIELDS`, replace `'shipping_mode',` with the three flags:

```ts
  'pickup_enabled', 'delivery_enabled', 'express_enabled',
  'delivery_base_fee', 'delivery_rate_per_km', 'delivery_max_km',
  'origin_place_id', 'origin_lat', 'origin_lng', 'origin_address',
```

`apps/backend/src/writes.ts:78-80` — replace the `shipping_mode` validation with:

```ts
  // Real booleans, not truthiness: these columns are `boolean not null`, and a coerced 'false'
  // or 0 would switch a method on that the merchant switched off.
  for (const key of ['pickup_enabled', 'delivery_enabled', 'express_enabled'] as const) {
    if (out[key] !== undefined && typeof out[key] !== 'boolean') {
      return { ok: false, error: `${key} must be a boolean` }
    }
  }
```

`apps/backend/src/orders.ts:368` — inside `resolveRoutedMetres`:

```ts
    select id::text, status::text, express_enabled, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id
```

`apps/backend/src/orders.ts:471` — inside `assertOrderableMerchant`:

```ts
    select order_prefix, status::text, shipping, currency, config, timezone, tax_enabled, tax_rate,
           pickup_enabled, delivery_enabled, express_enabled,
           delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id
```

`apps/backend/src/app.ts:1017` — the quote endpoint's select:

```ts
    .select('id, currency, status, express_enabled, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id')
```

- [ ] **Step 7: Update the DB test fixture**

`apps/backend/tests/rls/helpers.ts` — at line 82 replace the `shipping_mode` field declaration, and at line 99 its spread:

```ts
  /** Fulfilment methods (#103). Omitted fields keep the column defaults — pickup + delivery. */
  pickup_enabled?: boolean
  delivery_enabled?: boolean
  express_enabled?: boolean
```

```ts
      ...(fields.pickup_enabled !== undefined ? { pickup_enabled: fields.pickup_enabled } : {}),
      ...(fields.delivery_enabled !== undefined ? { delivery_enabled: fields.delivery_enabled } : {}),
      ...(fields.express_enabled !== undefined ? { express_enabled: fields.express_enabled } : {}),
```

- [ ] **Step 8: Fix the remaining fixtures the compiler and the suites point at**

```bash
grep -rn "shipping_mode" --include="*.ts" --include="*.tsx" --include="*.sql" apps packages | grep -v node_modules | grep -v worktrees
```
Expected after this step: only `apps/frontend/src/types.ts` and `apps/frontend/src/merchant/ShopSettings.tsx` (Tasks 6 and 8) still match. Everything else — including `apps/backend/tests/api/shippingQuote.test.ts`, `orders.test.ts` and `writes-merchants.test.ts` — must have `shipping_mode: 'distance'` replaced by `express_enabled: true` and `shipping_mode: 'region'` replaced by `express_enabled: false`.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
pnpm --filter @bitetime/shared test -- --run pricing.test.ts
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @bitetime/backend test:db
```
Expected: all PASS. Behaviour is unchanged — a shop that was `shipping_mode: 'distance'` is now `express_enabled: true` and `shopDistance` still reports `mode: 'distance'` to its three readers.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/supabase/migrations/20260722120000_distance_shipping.sql \
        packages/shared/src/pricing.ts packages/shared/src/pricing.test.ts \
        apps/backend/src/writes.ts apps/backend/src/orders.ts apps/backend/src/app.ts \
        apps/backend/tests
git commit -m "refactor(shipping): make the methods a shop offers three flags, not one mode

shipping_mode said a shop prices deliveries EITHER by region OR by
distance. #103 needs both at once, so the exclusivity goes: three
boolean columns, and a CHECK that keeps at least one method on.

The migration is rewritten in place rather than followed on. It has
never reached a remote project — PR #104 is unmerged — so the column it
drops is one that only ever existed on this branch. Local stacks need a
db reset.

shopDistance now gates on express_enabled. Its .mode field survives as a
derived value so this cascade could land without rewriting its three
readers in the same commit; it goes when they do."
```

---

### Task 3: The merchant PATCH must judge the merged row

**Files:**
- Modify: `apps/backend/src/app.ts:149-157`
- Test: `apps/backend/tests/api/writes-merchants.test.ts`

**Interfaces:**
- Consumes: `shopMethods` (Task 1); the three columns (Task 2).
- Produces: two 400 refusals from `PATCH /api/merchants/:id` — `'Your shop must offer at least one fulfilment method'` and `'Set your delivery origin before switching on express delivery'`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/backend/tests/api/writes-merchants.test.ts`, following the file's existing pattern for authenticated merchant PATCHes.

```ts
  it('refuses a save that would leave the shop offering nothing', async () => {
    const m = await seedMerchant({ pickup_enabled: true, delivery_enabled: true, express_enabled: false })
    const res = await app.request(`/api/merchants/${m.id}`, {
      method: 'PATCH',
      headers: authHeaders(m.ownerToken),
      body: JSON.stringify({ pickup_enabled: false, delivery_enabled: false }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/at least one fulfilment method/)
  })

  it('judges the LAST flag against the stored row, not against the patch alone', async () => {
    // The trap this check exists for. Two saves, each legal on its own body: the first turns
    // delivery off, the second turns pickup off. Reading only the patch, the second sees one
    // false flag and waves it through — and the shop is left with no method at all.
    const m = await seedMerchant({ pickup_enabled: true, delivery_enabled: false, express_enabled: false })
    const res = await app.request(`/api/merchants/${m.id}`, {
      method: 'PATCH',
      headers: authHeaders(m.ownerToken),
      body: JSON.stringify({ pickup_enabled: false }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/at least one fulfilment method/)
  })

  it('refuses express with no origin, and says why', async () => {
    const m = await seedMerchant({ express_enabled: false, origin_place_id: undefined })
    const res = await app.request(`/api/merchants/${m.id}`, {
      method: 'PATCH',
      headers: authHeaders(m.ownerToken),
      body: JSON.stringify({ express_enabled: true }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/delivery origin/)
  })

  it('accepts express switched on in the SAME save as the origin', async () => {
    const m = await seedMerchant({ express_enabled: false })
    const res = await app.request(`/api/merchants/${m.id}`, {
      method: 'PATCH',
      headers: authHeaders(m.ownerToken),
      body: JSON.stringify({ express_enabled: true, origin_place_id: 'place-abc', delivery_rate_per_km: 2 }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).express_enabled).toBe(true)
  })

  it('lets one shop offer delivery AND express at once', async () => {
    const m = await seedMerchant({ express_enabled: false })
    const res = await app.request(`/api/merchants/${m.id}`, {
      method: 'PATCH',
      headers: authHeaders(m.ownerToken),
      body: JSON.stringify({ delivery_enabled: true, express_enabled: true, origin_place_id: 'place-abc' }),
    })
    expect(res.status).toBe(200)
    const row = await res.json()
    expect(row.delivery_enabled).toBe(true)
    expect(row.express_enabled).toBe(true)
  })

  it('refuses a non-boolean flag rather than coercing it', async () => {
    const m = await seedMerchant({})
    const res = await app.request(`/api/merchants/${m.id}`, {
      method: 'PATCH',
      headers: authHeaders(m.ownerToken),
      body: JSON.stringify({ pickup_enabled: 'false' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/pickup_enabled must be a boolean/)
  })
```

Match the file's own helper names (`seedMerchant`, `authHeaders` or whatever it already uses) rather than introducing new ones — read the top of the file first.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @bitetime/backend test:db -- --run writes-merchants
```
Expected: FAIL — the min-one cases return 200 (the DB CHECK turns the *first* one into a bare 500 from PostgREST, which is exactly the unhelpful answer this check replaces), and the express-origin cases return the old `shipping_mode` wording or 200.

- [ ] **Step 3: Implement the merged-row validation**

In `apps/backend/src/app.ts`, replace lines 149-157 (the comment block and the `if (patch.shipping_mode === 'distance')` check) with:

```ts
  // These two rules must see the row's CURRENT flags as well as the patch's. A merchant who
  // turns delivery off in one save and pickup off in the next sends two bodies that are each
  // legal alone — and lands on a storefront no customer can order from. `c.get('merchant')` is
  // the row `requireMerchantOwns` already loaded (`select('*')`) for the ownership check above,
  // so this is a read of already-fetched data, not a second query.
  //
  // The columns' own CHECK constraints (`merchants_one_fulfilment_method`,
  // `merchants_express_requires_origin`) are the backstop. These are the checks that can say
  // WHY, in time for the merchant still looking at the form, instead of a bare 500 out of
  // PostgREST.
  const stored = c.get('merchant')
  const merged = {
    pickup: patch.pickup_enabled ?? stored.pickup_enabled,
    delivery: patch.delivery_enabled ?? stored.delivery_enabled,
    express: patch.express_enabled ?? stored.express_enabled,
  }
  if (!merged.pickup && !merged.delivery && !merged.express) {
    return c.json({ error: 'Your shop must offer at least one fulfilment method' }, 400)
  }
  if (merged.express) {
    const origin = patch.origin_place_id !== undefined ? patch.origin_place_id : stored.origin_place_id
    if (!origin) return c.json({ error: 'Set your delivery origin before switching on express delivery' }, 400)
  }
```

`??` is correct here and `||` is not: only `null`/`undefined` may fall through to the stored value, and `false` is a real answer the patch is entitled to give.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @bitetime/backend test:db -- --run writes-merchants
```
Expected: PASS, all six new cases.

- [ ] **Step 5: Run the full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @bitetime/backend test:db
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/app.ts apps/backend/tests/api/writes-merchants.test.ts
git commit -m "feat(settings): refuse a save that leaves a shop offering nothing

Min-one has to be judged against the STORED flags, not the patch's. Two
saves that are each legal alone — delivery off, then pickup off — walk a
shop into a storefront no customer can order from, and reading only the
body cannot see it coming.

The CHECK constraints already refuse it. These checks exist to say why,
while the merchant is still looking at the form, rather than as a bare
500 out of PostgREST."
```

---

### Task 4: The wire contract — `express` in, `sameday` out

**Files:**
- Modify: `packages/shared/src/pricing.ts` (`PriceInput.mode`, `shippingFee`, `priceOrder`)
- Modify: `packages/shared/src/pricing.test.ts`
- Modify: `apps/backend/src/orders.ts` (`PlaceOrderInput.mode`, `OrderErrorCode`, `placeOrder`, `resolveRoutedMetres`, `assertOrderableMerchant`)
- Modify: `apps/backend/src/app.ts:892` (the intake allowlist) and `:1027` (the quote endpoint's gate)
- Test: `apps/backend/tests/api/orders.test.ts`, `apps/backend/tests/api/shippingQuote.test.ts`

**Interfaces:**
- Consumes: `shopMethods`, `offersMethod` (Task 1); `ShopDistance.enabled` (Task 2).
- Produces:
  - `PriceInput['mode']: 'pickup' | 'delivery' | 'express'`
  - `shippingFee(mode, state, rates): number` — the `samedayFee` parameter is gone
  - `PlaceOrderInput['mode']: 'pickup' | 'delivery' | 'express'`
  - `OrderErrorCode` gains `'method_not_offered'`
  - `OrderableMerchant` gains `methods: ShopMethods`

- [ ] **Step 1: Write the failing shared tests**

In `packages/shared/src/pricing.test.ts`, add:

```ts
describe('priceOrder — express', () => {
  it('prices express by distance', () => {
    const bd = priceOrder({
      products, cart, mode: 'express', rates: RATES, now: NOW,
      distance: shopDistance(DISTANCE_ROW),   // base 5, rate 2/km in the fixture
      routedMetres: 25_216,
    })
    // routedKm rounds to 25.2 BEFORE the rate multiplies it.
    expect(bd.shipping).toBe(5 + 2 * 25.2)
    expect(bd.shippingPending).toBe(false)
  })

  it('leaves a plain delivery on the region rate at a shop that also offers express', () => {
    // The whole point of #103: the fee rule follows the METHOD, not the shop.
    const bd = priceOrder({
      products, cart, mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance: shopDistance(DISTANCE_ROW),
      routedMetres: 25_216,
    })
    expect(bd.shipping).toBe(RATES.WM)
    expect(bd.shippingPending).toBe(false)
  })

  it('refuses rather than invents a fee when express has no routed distance', () => {
    const bd = priceOrder({
      products, cart, mode: 'express', rates: RATES, now: NOW,
      distance: shopDistance(DISTANCE_ROW),
      routedMetres: null,
    })
    expect(bd.shippingPending).toBe(true)
    expect(bd.shipping).toBe(0)   // NOT a fee — see PriceBreakdown.shippingPending
  })

  it('refuses when express is priced by an unusable configuration', () => {
    const bd = priceOrder({
      products, cart, mode: 'express', rates: RATES, now: NOW,
      distance: shopDistance({ ...DISTANCE_ROW, origin_place_id: null }),
      routedMetres: 25_216,
    })
    expect(bd.shippingPending).toBe(true)
  })
})
```

Adjust `RATES` / `DISTANCE_ROW` / `products` / `cart` / `NOW` to whatever the surrounding file already binds — read it, do not introduce new fixtures. If `DISTANCE_ROW`'s base and rate differ from 5 and 2, use its real values in the arithmetic.

Then delete the `'sameday'` cases: search the file for `sameday` and remove those tests and any `samedayFee` argument.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @bitetime/shared test -- --run pricing.test.ts
```
Expected: FAIL — `Type '"express"' is not assignable`, and the express cases returning region rates.

- [ ] **Step 3: Change the mode union and the pricing branch**

In `packages/shared/src/pricing.ts`:

Replace the `mode` line in `PriceInput`:

```ts
  /**
   * Which method the customer chose. An ALLOWLIST, and it is a price rule: `mode` selects the
   * shipping fee, so any unrecognised value prices shipping at 0.
   *
   * `delivery` is the flat region rate; `express` is distance-priced. Both may be offered by the
   * same shop — see `shopMethods`.
   */
  mode: FulfilmentMethod
```

Delete the `samedayFee?: number` field from `PriceInput`, and rewrite `shippingFee`:

```ts
export function shippingFee(
  mode: PriceInput['mode'],
  state: string | null | undefined,
  rates: { WM: number; EM: number },
): number {
  if (mode === 'delivery' && state) return rates[EM_STATES.includes(state) ? 'EM' : 'WM'] || 0
  return 0
}
```

In `priceOrder`, replace the `distancePriced` line and the `shippingFee` call:

```ts
  // The fee rule follows the METHOD the customer chose, not a policy on the shop: one shop can
  // offer flat-rate `delivery` and distance-priced `express` side by side (#103).
  const distancePriced = input.mode === 'express'
```

```ts
        : shippingFee(input.mode, input.state, input.rates)
```

Update the `shippingPending` doc comment on `PriceBreakdown` — replace "this shop prices by distance, the mode is delivery" with "the mode is `express`".

- [ ] **Step 4: Run the shared tests to verify they pass**

```bash
pnpm --filter @bitetime/shared test -- --run pricing.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write the failing backend intake tests**

In `apps/backend/tests/api/orders.test.ts`:

```ts
  it('refuses a method the shop does not offer', async () => {
    const m = await seedMerchant({ pickup_enabled: true, delivery_enabled: false, express_enabled: false })
    const res = await postOrder({ merchantId: m.id, mode: 'delivery', address: { state: 'Selangor' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('method_not_offered')
  })

  it('refuses express at a shop that only offers flat delivery', async () => {
    const m = await seedMerchant({ delivery_enabled: true, express_enabled: false })
    const res = await postOrder({ merchantId: m.id, mode: 'express' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('method_not_offered')
  })

  it('stamps the distance snapshot on an express order', async () => {
    const m = await seedExpressMerchant()      // express_enabled, origin, base 5, rate 2
    await seedDistanceQuote(m.origin_place_id, 'place-dest', 25_216)
    const res = await postOrder({
      merchantId: m.id, mode: 'express',
      address: { line1: 'somewhere', place_id: 'place-dest' },
    })
    expect(res.status).toBe(200)
    const row = await orderRow((await res.json()).order_number)
    expect(Number(row.delivery_distance_km)).toBe(25.2)
    expect(Number(row.delivery_base_fee)).toBe(5)
    expect(Number(row.delivery_rate_per_km)).toBe(2)
  })

  it('leaves the distance snapshot null on a flat delivery at the same shop', async () => {
    // Both methods on. The order that chose `delivery` must carry no distance line at all —
    // a reader must never see 0 km where the answer is "this order was not priced by distance".
    const m = await seedExpressMerchant({ delivery_enabled: true })
    const res = await postOrder({ merchantId: m.id, mode: 'delivery', address: { state: 'Selangor' } })
    expect(res.status).toBe(200)
    const row = await orderRow((await res.json()).order_number)
    expect(row.delivery_distance_km).toBeNull()
    expect(row.delivery_base_fee).toBeNull()
    expect(row.delivery_rate_per_km).toBeNull()
  })

  it('still refuses a flat delivery with no state', async () => {
    const m = await seedMerchant({ delivery_enabled: true })
    const res = await postOrder({ merchantId: m.id, mode: 'delivery', address: { line1: 'x' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('delivery_state_required')
  })
```

Use the file's own helpers and seeding style — read it first and reuse `seedMerchant`, the order-posting helper and the quoted-total handling it already has. If there is no express-shop helper, build the merchant inline with `seedMerchant({ express_enabled: true, origin_place_id: …, delivery_base_fee: 5, delivery_rate_per_km: 2 })`.

- [ ] **Step 6: Run them to verify they fail**

```bash
pnpm --filter @bitetime/backend test:db -- --run api/orders
```
Expected: FAIL — `mode: 'express'` is rejected by the route allowlist as `invalid_body` (400), and `method_not_offered` never appears.

- [ ] **Step 7: Widen the intake allowlist**

`apps/backend/src/app.ts`, replacing line 892 and correcting the comment above it:

```ts
  // An ALLOWLIST, not a string check: `mode` SELECTS THE SHIPPING FEE. Any unrecognised value
  // prices shipping at 0, so a free string is a client-chosen value that zeroes a fee — the same
  // hole as a client-supplied `total`, and `mode: 'sameday'` walked straight through it with an
  // address attached.
  //
  // Whether the SHOP offers the method it names is `placeOrder`'s call, not HTTP's — the same
  // split as the delivery region, allowlisted for shape here and refused there.
  const mode = b.mode === 'pickup' || b.mode === 'delivery' || b.mode === 'express' ? b.mode : null
```

- [ ] **Step 8: Teach intake the three methods**

In `apps/backend/src/orders.ts`:

Import the new symbols — extend the existing `@bitetime/shared` import with `shopMethods, offersMethod` and the `ShopMethods` type.

Replace the `mode` field on `PlaceOrderInput`:

```ts
  /**
   * The method the customer chose, as a UNION and not a string — `mode` selects the shipping
   * fee, so a free string is a client-chosen value that can zero one. It was a string, and
   * `mode: 'sameday'` bought a delivery with a shipping_fee of 0.
   *
   * `delivery` is the flat region rate and `express` is distance-priced. Whether this shop
   * OFFERS the named method is checked in the transaction (`method_not_offered`).
   */
  mode: 'pickup' | 'delivery' | 'express'
```

Add to the `OrderErrorCode` union, above `'distance_lookup_failed'`:

```ts
  /**
   * The shop does not offer the method this order names. Checked in the transaction because the
   * flags live on the shop's row, which only the backend reads — the storefront renders no
   * button for a disabled method, so an honest checkout never sees this.
   */
  | 'method_not_offered'
```

In `assertOrderableMerchant`, add to the returned object (after `distance:`):

```ts
    // shopMethods, for the same reason as shopRates, shopTax and shopDistance above: the
    // storefront renders its buttons from this exact function, and a second reading here is a
    // second rule the customer meets as a refusal of a button they were just offered.
    methods: shopMethods(merchant),
```

and add `methods: ShopMethods` to the `OrderableMerchant` interface.

In the transaction body, replace the `distancePriced` line and put the method gate **first**, before the state and distance checks:

```ts
    const merchant = await assertOrderableMerchant(tx, input.merchantId)

    // BEFORE the fee rules, because "you cannot order that way here" is the answer to give when
    // both could fire: a shop with express switched off should not be told its distance lookup
    // failed.
    if (!offersMethod(merchant.methods, input.mode)) {
      throw new OrderError('method_not_offered')
    }

    // The fee rule follows the METHOD, not the shop: `delivery` is the flat region rate and
    // `express` is priced by the routed distance, and one shop may offer both.
    const distancePriced = input.mode === 'express'
```

Then the two guards below it become:

```ts
    if (input.mode === 'delivery' && deliveryState(input.mode, input.address) === null) {
      throw new OrderError('delivery_state_required')
    }
    if (input.mode === 'express' && routedMetres === null) {
      throw new OrderError('distance_lookup_failed')
    }
```

Note what changed in the first: the `&& !distancePriced` clause is gone. A `delivery` order is now *always* region-priced, whatever else the shop offers, so it always needs a state.

In `resolveRoutedMetres`, replace the two gates:

```ts
  if (input.mode !== 'express') return null
```

```ts
  const policy = shopDistance(rows[0])
  // Not this shop's method. The transaction refuses it with `method_not_offered`; returning null
  // here just means no Google call is paid for on the way to that refusal.
  if (!policy.enabled) return null
```

`deliveryState` is unchanged: it already returns `null` for anything but `delivery`, which is now exactly right — express takes its fee from the routed distance and the state is only ever printed on the parcel.

- [ ] **Step 9: Migrate the quote endpoint's gate**

`apps/backend/src/app.ts:1027` still reads `ShopDistance`'s compatibility field. Replace it:

```ts
  const policy = shopDistance(merchant)
  // `not_distance_priced` keeps its wire name — the storefront already branches on it, and
  // renaming a refusal code is a separate, customer-visible change.
  if (!policy.enabled || !policy.usable) return c.json({ error: 'not_distance_priced' }, 409)
```

Then confirm `apps/backend/tests/api/shippingQuote.test.ts` still covers the refusal with the flag rather than the old column — its fixture was swapped to `express_enabled` in Task 2 Step 8, so the existing "refuses a shop that is not distance priced" case should already be exercising `express_enabled: false`. Add one if it is not:

```ts
  it('refuses a quote at a shop that does not offer express', async () => {
    const m = await seedMerchant({ express_enabled: false, delivery_enabled: true })
    const res = await app.request('/api/shipping/quote', {
      method: 'POST',
      body: JSON.stringify({ merchantId: m.id, placeId: 'place-dest' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('not_distance_priced')
  })
```

- [ ] **Step 10: Run the tests to verify they pass**

```bash
pnpm --filter @bitetime/backend test:db -- --run api/orders
pnpm --filter @bitetime/backend test:db -- --run api/shippingQuote
```
Expected: PASS, including the pre-existing distance cases (which now post `mode: 'express'` — update them if they still post `mode: 'delivery'` against an express shop).

- [ ] **Step 11: Run the full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @bitetime/backend test:db
```

- [ ] **Step 12: Commit**

```bash
git add packages/shared apps/backend/src/orders.ts apps/backend/src/app.ts apps/backend/tests/api
git commit -m "feat(orders): price by the method the customer chose

delivery is the flat region rate, express is base + rate x km, and one
shop can now offer both. The fee rule stops being a property of the shop
and becomes a property of the method — which is what lets the two
coexist.

Intake refuses a method the shop does not offer, and refuses it BEFORE
the fee rules: a shop with express switched off should not be told its
distance lookup failed.

sameday goes with the union it lived in. It has been unreachable and
rate-less since the legacy order form was deleted, and a dead third
value beside two real ones is an invitation to bring it back."
```

---

### Task 5: The Telegram message names the method

**Files:**
- Modify: `apps/backend/src/notify.ts:66`
- Test: `apps/backend/tests/unit/notify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing test**

Add to `apps/backend/tests/unit/notify.test.ts`, matching the file's existing message-building helper:

```ts
  it('names the fulfilment method rather than printing the column value', () => {
    expect(buildMessage({ ...baseOrder, mode: 'express' })).toContain('*Mode:* Express delivery')
    expect(buildMessage({ ...baseOrder, mode: 'delivery' })).toContain('*Mode:* Delivery')
    expect(buildMessage({ ...baseOrder, mode: 'pickup' })).toContain('*Mode:* Pickup')
  })

  it('prints an unknown mode as-is rather than dropping the line', () => {
    // A row written by an older build still has to say something. Losing the line entirely is
    // worse than an unpolished one — the merchant reads this to know whether to expect a rider.
    expect(buildMessage({ ...baseOrder, mode: 'sameday' })).toContain('*Mode:* sameday')
  })
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @bitetime/backend test -- --run notify
```
Expected: FAIL — received `*Mode:* express`.

- [ ] **Step 3: Add the label map**

In `apps/backend/src/notify.ts`, above the message builder:

```ts
// The merchant-facing name for each method. English only, and deliberately a local map rather
// than an import: this file already keeps its own `formatMoney` twin for the same reason —
// Telegram is the backend's own surface and the frontend's translator does not reach it.
const MODE_LABELS: Record<string, string> = {
  pickup: 'Pickup',
  delivery: 'Delivery',
  express: 'Express delivery',
}
```

and replace line 66:

```ts
  if (order.mode) msg += `*Mode:* ${MODE_LABELS[order.mode as string] ?? order.mode}\n`
```

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @bitetime/backend test -- --run notify
```
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add apps/backend/src/notify.ts apps/backend/tests/unit/notify.test.ts
git commit -m "feat(notify): name the fulfilment method in the Telegram message

'*Mode:* express' is a column value, not a label. An unknown mode still
prints as-is: losing the line is worse than an unpolished one, because
the merchant reads it to know whether to expect a rider."
```

---

### Task 6: Frontend wire types

**Files:**
- Modify: `apps/frontend/src/types.ts:36-42`
- Modify: `apps/frontend/src/store.ts:611`
- Modify: `apps/frontend/src/savedDetails.ts:58` and `:65`
- Test: `apps/frontend/src/savedDetails.test.ts`

**Interfaces:**
- Consumes: `FulfilmentMethod` (Task 1).
- Produces: `Merchant` carries `pickup_enabled?` / `delivery_enabled?` / `express_enabled?`; `placeOrder`'s and `savedDetailsFromOrder`'s `mode` accept `'express'`.

- [ ] **Step 1: Write the failing test**

Add to `apps/frontend/src/savedDetails.test.ts`:

```ts
  it('saves the address on an express order, the same as a delivery', () => {
    // The rule is "not a pickup", not "is a delivery". An express order carries an address the
    // customer will want back next time, and testing for 'delivery' silently drops it.
    const address = { line1: '12 Jalan Example', postcode: '47301', city: 'PJ', state: 'Selangor' }
    expect(savedDetailsFromOrder({ mode: 'express', wa: '60123456789', address }))
      .toEqual({ whatsapp: '60123456789', delivery_address: address })
  })
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @bitetime/frontend test -- --run savedDetails
```
Expected: FAIL — `Type '"express"' is not assignable to type '"pickup" | "delivery"'`.

- [ ] **Step 3: Update the three type sites**

`apps/frontend/src/types.ts` — replace the `shipping_mode` field on `Merchant`:

```ts
  /** Which methods this shop offers. Read through `shopMethods`, never directly — an absent
   *  column means that column's own default, not `false`. */
  pickup_enabled?: boolean
  delivery_enabled?: boolean
  express_enabled?: boolean
```

`apps/frontend/src/store.ts:611` — in `placeOrder`'s parameter type:

```ts
  // The wire contract, not a string: the backend allowlists exactly these three and 400s on
  // anything else, because `mode` selects the shipping fee. Mirrors PlaceOrderInput's union.
  mode: 'pickup' | 'delivery' | 'express'
```

`apps/frontend/src/savedDetails.ts` — the parameter type at line 58 and the rule at line 65:

```ts
export function savedDetailsFromOrder(order: {
  mode: 'pickup' | 'delivery' | 'express'
  wa: string
  address: AddressParts
}): SavedDetails {
```

```ts
  // A pickup order carries no address. Writing the form's empty one would blank the address the
  // customer saved on their last delivery — and they would only discover it at the next
  // checkout. The test is "not a pickup", not "is a delivery": an express order carries an
  // address too, and it is just as worth keeping.
  if (order.mode !== 'pickup' && isCompleteAddress(order.address)) {
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @bitetime/frontend test -- --run savedDetails
```
Expected: PASS, including the existing pickup case.

- [ ] **Step 5: Run the full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add apps/frontend/src/types.ts apps/frontend/src/store.ts apps/frontend/src/savedDetails.ts apps/frontend/src/savedDetails.test.ts
git commit -m "feat(frontend): carry the three fulfilment methods on the wire types

savedDetailsFromOrder's rule becomes 'not a pickup' rather than 'is a
delivery'. An express order carries an address the customer will want
back next checkout, and the old test silently dropped it."
```

---

### Task 7: One label for one method

**Files:**
- Create: `apps/frontend/src/fulfilmentLabel.ts`
- Create: `apps/frontend/src/fulfilmentLabel.test.ts`
- Modify: `apps/frontend/src/merchant/OrdersView.tsx:22-33`
- Modify: `apps/frontend/src/store/ReceiptDialog.tsx:126-129` and `:147`
- Modify: `apps/frontend/src/store/OrderHistory.tsx:214-217` and `:236`

**Interfaces:**
- Consumes: `Translate` from `./types`.
- Produces:
  ```ts
  export function fulfilmentLabel(mode: string | null | undefined, t: Translate): string
  export function feeLineLabel(mode: string | null | undefined, km: number | null, t: Translate): string
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/fulfilmentLabel.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fulfilmentLabel, feeLineLabel } from './fulfilmentLabel'

const en = (e: string) => e
const zh = (_e: string, z?: string) => z ?? _e

describe('fulfilmentLabel', () => {
  it('names each method in both languages', () => {
    expect(fulfilmentLabel('pickup', en)).toBe('Pickup')
    expect(fulfilmentLabel('delivery', en)).toBe('Delivery')
    expect(fulfilmentLabel('express', en)).toBe('Express delivery')
    expect(fulfilmentLabel('pickup', zh)).toBe('自取')
    expect(fulfilmentLabel('delivery', zh)).toBe('送货')
    expect(fulfilmentLabel('express', zh)).toBe('快速配送')
  })

  it('renders an unknown mode capitalised rather than blank', () => {
    // Rows written by older builds still have to say something in the dashboard.
    expect(fulfilmentLabel('sameday', en)).toBe('Sameday')
  })

  it('renders a missing mode as an em dash', () => {
    expect(fulfilmentLabel(null, en)).toBe('—')
    expect(fulfilmentLabel(undefined, en)).toBe('—')
  })
})

describe('feeLineLabel', () => {
  it('names the method on the fee line, and appends the distance it charged for', () => {
    expect(feeLineLabel('express', 25.2, en)).toBe('Express delivery fee (25.2 km)')
    expect(feeLineLabel('express', 25.2, zh)).toBe('快速配送费（25.2 公里）')
  })

  it('omits the distance when there is none', () => {
    // A region-priced order has no distance, and a line reading "(0.0 km)" would be a lie about
    // what produced the money.
    expect(feeLineLabel('delivery', null, en)).toBe('Delivery fee')
    expect(feeLineLabel('delivery', null, zh)).toBe('送货费')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @bitetime/frontend test -- --run fulfilmentLabel
```
Expected: FAIL — `Failed to resolve import "./fulfilmentLabel"`.

- [ ] **Step 3: Implement the helper**

Create `apps/frontend/src/fulfilmentLabel.ts`:

```ts
// The ONE mapping from a `mode` value to what the customer and the merchant read.
//
// It exists because there were three hand-rolled `mode === 'delivery' ? … : …` ternaries — the
// receipt, the customer's order history and the dashboard — and a fourth is exactly how one
// surface ends up calling a method something the other three do not. A customer comparing their
// receipt against their history must not find two names for one order.
import type { Translate } from './types'

const LABELS: Record<string, { en: string; zh: string }> = {
  pickup:   { en: 'Pickup',           zh: '自取' },
  delivery: { en: 'Delivery',         zh: '送货' },
  express:  { en: 'Express delivery', zh: '快速配送' },
}

/** The method's name. An unknown mode is capitalised rather than blanked — an old row still
 *  has to say something. */
export function fulfilmentLabel(mode: string | null | undefined, t: Translate): string {
  if (!mode) return '—'
  const l = LABELS[mode]
  return l ? t(l.en, l.zh) : mode.charAt(0).toUpperCase() + mode.slice(1)
}

/**
 * The money line for the shipping charge, named after the method that produced it.
 *
 * `km` is appended only when there is one. The distance is what makes the fee reconcilable on a
 * calculator (`base + rate × km`), and it is already the rounded km the fee was derived from —
 * see `routedKm`. A region-priced order has no distance, and printing `(0.0 km)` would be a lie
 * about what produced the money.
 */
export function feeLineLabel(mode: string | null | undefined, km: number | null, t: Translate): string {
  const base = mode === 'express'
    ? t('Express delivery fee', '快速配送费')
    : t('Delivery fee', '送货费')
  if (km === null) return base
  return t(`${base} (${km.toFixed(1)} km)`, `${base}（${km.toFixed(1)} 公里）`)
}
```

- [ ] **Step 4: Run them to verify they pass**

```bash
pnpm --filter @bitetime/frontend test -- --run fulfilmentLabel
```
Expected: PASS.

- [ ] **Step 5: Replace the three hand-rolled label sites**

`apps/frontend/src/merchant/OrdersView.tsx` — delete `MODE_LABELS` and the local `modeLabel` function (lines 22-33) and import the shared one:

```ts
import { fulfilmentLabel } from '../fulfilmentLabel'
```

Then replace both call sites, `modeLabel(row.original.mode, …)` at line 124 and `modeLabel(selected.mode, t)` at line 337, with `fulfilmentLabel(…)` taking the same arguments.

`apps/frontend/src/store/ReceiptDialog.tsx` — import `{ fulfilmentLabel, feeLineLabel }` from `'../fulfilmentLabel'`, then replace the fee-line expression at lines 126-129:

```tsx
                  feeLineLabel(
                    order.mode,
                    order.delivery_distance_km != null ? Number(order.delivery_distance_km) : null,
                    t,
                  )
```

and the total-row label at line 147:

```tsx
              {fulfilmentLabel(order.mode, t)}
```

`apps/frontend/src/store/OrderHistory.tsx` — the same two replacements against `o` instead of `order`, at lines 214-217 and 236.

- [ ] **Step 6: Verify in the running app**

```bash
pnpm dev
```
Open a storefront, place a pickup order, and check the confirmation and **Order history**: the total row reads `Pickup` / `自取` and no fee line appears. Switch the language toggle and confirm the Chinese. Then in the merchant dashboard's Orders table, confirm the Mode column reads `Pickup`.

- [ ] **Step 7: Run the full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add apps/frontend/src/fulfilmentLabel.ts apps/frontend/src/fulfilmentLabel.test.ts \
        apps/frontend/src/merchant/OrdersView.tsx apps/frontend/src/store/ReceiptDialog.tsx \
        apps/frontend/src/store/OrderHistory.tsx
git commit -m "refactor(frontend): one place decides what a method is called

Three hand-rolled ternaries named the same two methods, and a third
method meant writing a fourth. A customer comparing their receipt
against their order history must not find two names for one order.

The fee line takes the method's name with it: with express as a distinct
method, 'Delivery fee' on an express order names the wrong one."
```

---

### Task 8: Shop Settings — three checkboxes, both rate cards

**Files:**
- Modify: `apps/frontend/src/merchant/ShopSettings.tsx` (the `ShippingFields` type, the `saved` initialiser at :120-153, `save()` at :204-215, the shipping-mode card at :305-334, and the rates cards at :375-430)
- Modify: `apps/frontend/src/merchant/settingsDirty.ts:10-23`

**Interfaces:**
- Consumes: `shopMethods` (Task 1), `shopDistance` (Task 2), the PATCH validation (Task 3).
- Produces: nothing other tasks read.

- [ ] **Step 1: Widen the settings field type**

`apps/frontend/src/merchant/settingsDirty.ts` — replace the `taxEnabled?: boolean` line's neighbourhood in `SettingsFields`:

```ts
export type SettingsFields = {
  [key: string]: string | boolean | undefined
  currency?: string
  wm?: string
  em?: string
  pickupAddress?: string
  taxEnabled?: boolean
  /** The three fulfilment-method checkboxes (#103). */
  pickupEnabled?: boolean
  deliveryEnabled?: boolean
  expressEnabled?: boolean
  taxRate?: string
  bank?: string
  note?: string
  tgToken?: string
  tgChat?: string
}
```

Also update the type's doc comment: `taxEnabled` is no longer "the one boolean" — say "the booleans are the tax toggle and the three fulfilment-method checkboxes".

- [ ] **Step 2: Read the flags into form state**

In `ShopSettings.tsx`, in the `saved` initialiser, add beside `const distance = shopDistance(merchant!)`:

```ts
    // shopMethods, not a local read of these columns, for exactly the reason shopRates, shopTax
    // and shopDistance are used above: this form shows the merchant what their shop OFFERS, and
    // what it offers is decided by that one function on both sides of the wire.
    const methods = shopMethods(merchant!)
```

and in the returned object replace `shippingMode: distance.mode,` with:

```ts
      pickupEnabled: methods.pickup,
      deliveryEnabled: methods.delivery,
      expressEnabled: methods.express,
```

Add `shopMethods` to the `@bitetime/shared` import at the top of the file, and remove `shippingMode` from the `ShippingFields` type declaration, replacing it with the three booleans.

- [ ] **Step 3: Replace the policy radio card with method checkboxes**

Replace the whole card at lines 305-334 (`<h3>{t('How you charge for delivery', …)}</h3>` and its two radios) with:

```tsx
      <div className={CARD}>
        <h3 className={HEADING}>{t('What customers can choose', '顾客可选的方式')}</h3>
        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-[14px] text-ink">
            <input type="checkbox" className="mt-1"
              checked={fields.pickupEnabled}
              // The LAST ticked box cannot be unticked. Min-one is a CHECK constraint and the
              // backend refuses a save that breaks it, but a merchant should meet that rule as
              // an input that will not turn off, not as an error after they pressed Save.
              disabled={onlyMethod === 'pickup'}
              onChange={e => setFields(f => ({ ...f, pickupEnabled: e.target.checked }))} />
            <span>{t('Pickup — customers collect from you.', '自取 — 顾客自行前来领取。')}</span>
          </label>
          <label className="flex items-start gap-2 text-[14px] text-ink">
            <input type="checkbox" className="mt-1"
              checked={fields.deliveryEnabled}
              disabled={onlyMethod === 'delivery'}
              onChange={e => setFields(f => ({ ...f, deliveryEnabled: e.target.checked }))} />
            <span>
              {t('Delivery — one flat rate for West Malaysia, one for East Malaysia.',
                 '送货 — 西马一个统一运费，东马一个。')}
            </span>
          </label>
          <label className="flex items-start gap-2 text-[14px] text-ink">
            <input type="checkbox" className="mt-1"
              checked={fields.expressEnabled}
              disabled={onlyMethod === 'express' || !fields.originPlaceId}
              onChange={e => setFields(f => ({ ...f, expressEnabled: e.target.checked }))} />
            <span>
              {t('Express delivery — a base fee plus a rate for every kilometre your rider drives.',
                 '快速配送 — 基本运费加上每公里费率。')}
            </span>
          </label>
          {!fields.originPlaceId && (
            /* Says WHY the option is disabled. Without an origin there is nowhere to measure
               from, and a shop that switched it on anyway would quote nothing at all. */
            <p className="text-[12px] text-rose-muted leading-[1.5]">
              {t('Set your delivery origin below before you can offer express delivery.',
                 '请先在下方设置配送起点，才能提供快速配送。')}
            </p>
          )}
          <p className="text-[12px] text-rose-muted leading-[1.5]">
            {t('You must offer at least one. A method you switch off keeps its settings.',
               '至少须提供一种。关闭的方式会保留其设置。')}
          </p>
        </div>
      </div>
```

Add the `onlyMethod` derivation just above the `save` function:

```ts
  // The one method still on, if exactly one is — the checkbox that must not be untickable.
  // `null` whenever two or more are on, which is when every box is free to move.
  const enabledMethods = (['pickup', 'delivery', 'express'] as const)
    .filter(m => fields[`${m}Enabled` as const])
  const onlyMethod = enabledMethods.length === 1 ? enabledMethods[0] : null
```

- [ ] **Step 4: Show both rate cards independently**

The two rate cards are currently the two arms of one ternary, `{fields.shippingMode === 'region' ? ( <div className={CARD}>…Shipping rates…</div> ) : ( <div className={CARD}>…Distance rates…</div> )}`. Turn them into two independent blocks.

This is a **re-wrap, not a rewrite**: cut each arm's `<div className={CARD}> … </div>` and paste it whole, changing only its wrapping condition and its `<h3>` text. Every `<Input>`, every `<Label>`, every hint paragraph and the worked-example line move across untouched.

```tsx
      {fields.deliveryEnabled && (
        <div className={CARD}>
          <h3 className={HEADING}>{t('Delivery rates', '送货费')}</h3>
          {/* the ternary's FIRST arm, from its `<div className="flex flex-col gap-2">` down to
              its closing tag: the shop-wm and shop-em inputs and the blank-East-Malaysia hint */}
        </div>
      )}

      {fields.expressEnabled && (
        <div className={CARD}>
          <h3 className={HEADING}>{t('Express delivery rates', '快速配送费率')}</h3>
          {/* the ternary's SECOND arm, likewise: shop-base-fee, shop-rate-km, shop-max-km, the
              blank-maximum hint and the worked example */}
        </div>
      )}
```

Both headings change (`Shipping rates` → `Delivery rates`, `Distance rates` → `Express delivery rates`) so that each card names the method whose fee it sets — with both on screen, "Shipping rates" no longer says which shipping.

Both showing at once is now an ordinary state, not a contradiction: a shop can charge a flat rate for post and a per-km rate for its rider.

- [ ] **Step 5: Save the flags**

In `save()`, replace `shipping_mode: fields.shippingMode,` with:

```ts
        // Every rate is written on every save, whichever methods are on: a disabled method's
        // configuration is kept so switching it back does not mean retyping it (story 10) —
        // the same arrangement a disabled tax's rate already has.
        pickup_enabled: fields.pickupEnabled,
        delivery_enabled: fields.deliveryEnabled,
        express_enabled: fields.expressEnabled,
```

- [ ] **Step 6: Verify in the running app**

```bash
pnpm dev
```

1. Sign in as a merchant, open **Shop Settings → shipping tab**. Confirm three checkboxes, Pickup and Delivery ticked, Express unticked and **disabled** with the origin hint below.
2. Untick Delivery. Pickup's checkbox becomes disabled (it is now the only one). The Delivery rates card disappears; its values are still there when you re-tick it.
3. Pick a delivery origin via the autocomplete. Express becomes tickable. Tick it — the **Express delivery rates** card appears *alongside* the Delivery rates card.
4. Save. Reload the page. All three states persist.
5. Untick everything you can and press Save — the last box will not untick, so the merchant cannot reach the refusal by clicking. (The backend refusal from Task 3 is the backstop for anything that bypasses the form.)

- [ ] **Step 7: Run the full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add apps/frontend/src/merchant/ShopSettings.tsx apps/frontend/src/merchant/settingsDirty.ts
git commit -m "feat(settings): let a merchant choose which methods they offer

The radio that made region and distance pricing exclusive becomes three
checkboxes, and both rate cards can now be on screen at once — a shop
can post parcels at a flat rate and run a rider by the kilometre.

The last ticked box will not untick. Min-one is a CHECK constraint and
the backend refuses a save that breaks it, but a merchant should meet
that rule as an input that will not turn off, not as an error after they
pressed Save."
```

---

### Task 9: The storefront offers what the shop offers

**Files:**
- Modify: `apps/frontend/src/store/Storefront.tsx` — the `mode` state (:99), the policy derivations (:265-278), the auto-quote effect (:321), the `priceOrder` call (:480-500), `deliveryReady` (:514-526), the refusal copy (:155-165 and :825-836), the submit error map (~:810), and the Fulfilment section (:1176-1290)

**Interfaces:**
- Consumes: `shopMethods`, `firstOfferedMethod`, `FulfilmentMethod` (Task 1); `ShopDistance.enabled` (Task 2); `method_not_offered` (Task 4); `fulfilmentLabel` (Task 7).
- Produces: nothing other tasks read.

- [ ] **Step 1: Derive the shop's methods and the starting mode**

Add `shopMethods, firstOfferedMethod` and the type `FulfilmentMethod` to the `@bitetime/shared` import, then beside `const distance = shopDistance(merchant)` (line 265):

```ts
  // The SAME mapper intake refuses with. A second reading of these columns here is a second
  // rule, and the customer meets it as a refusal of a button they were just offered.
  const methods = shopMethods(merchant)
  // `null` when the shop offers nothing — a state the CHECK constraint makes unconstructible,
  // and which this form must still refuse rather than invent a method for.
  const defaultMode = firstOfferedMethod(methods)
```

Replace the `mode` state (line 99) — note it must be declared *after* `methods`, so move the `useState` down to sit beside these derivations, and delete the old line 99:

```ts
  const [modeInput, setModeInput] = useState<FulfilmentMethod | null>(null)
  // DERIVED, not seeded by an effect — the same shape as the profile prefill above: `null` means
  // "the customer has not chosen", so the shop's first offered method fills in until they do.
  // `?? 'pickup'` is unreachable (see `defaultMode`) and is here only so `mode` is never null
  // for the price call; `noMethods` below is what actually stops such a shop taking an order.
  const mode = modeInput ?? defaultMode ?? 'pickup'
  const setMode = setModeInput
  const noMethods = defaultMode === null
```

- [ ] **Step 2: Retarget the distance derivations at the selected method**

Replace lines 265-278's `distanceMode` / `distancePriced` (keeping `const distance = shopDistance(merchant)` above them):

```ts
  // Is the CUSTOMER'S CHOICE the distance-priced one? This is what `priceOrder` branches on
  // internally (`mode === 'express'`), and gating the storefront on anything else is how a
  // region form's fee leaked into a distance quote (#101 review, Finding 1).
  const expressChosen = mode === 'express'
  // Chosen AND priceable. `!distance.usable` is a REFUSAL of express at this shop, not a
  // fallback to the delivery form or its rate — see `ShopDistance.usable`'s own contract
  // ("FALSE IS A REFUSAL, NOT A FALLBACK"). Unreachable today (the DB constraint and the
  // backend's allowlist make it unconstructible) and honoured anyway.
  const expressPriced = expressChosen && distance.usable
```

Then replace every remaining use of `distanceMode` with `expressChosen` and `distancePriced` with `expressPriced` throughout the file:

```bash
grep -n "distanceMode\|distancePriced" apps/frontend/src/store/Storefront.tsx
```

Expected sites: the auto-quote effect's guard (:211 and :321-326), the `resolvedShipping` expression (:497), `deliveryReady` (:514-526), the `price_changed` re-quote (:794), and the Fulfilment section's render branches (:1218-1290).

- [ ] **Step 3: Correct the price call and the readiness gate**

At line 497, `resolvedShipping`'s region placeholder now applies to the `delivery` method specifically:

```ts
    resolvedShipping: mode === 'delivery' && !address.state ? baseDeliveryFee : undefined,
```

The `!distanceMode &&` clause goes: a `delivery` order is region-priced at every shop now, whatever else that shop offers. The estimate remains a DISPLAY fallback held honest by `deliveryReady`, and the comment above it should say `delivery` rather than "REGION shops".

Replace `deliveryReady` (lines 514-526):

```ts
  const deliveryReady =
    mode === 'pickup' ||
    (mode === 'express'
      // `!distance.usable` refuses outright — no address form is even rendered in that state
      // (see the Fulfilment section below), so there is nothing here that could become "ready".
      // At a priceable express shop the address must have been SELECTED (so it has a place id)
      // and a fee must have come back. This gate is load-bearing for the PRICE, not just form
      // validity: it is the only thing stopping an order the shop would have to cancel.
      ? distance.usable && quotedForThisAddress && address.line1.trim() !== ''
      : address.line1.trim() !== '' &&
        address.postcode.length === 5 &&
        address.city.trim() !== '' &&
        address.state.trim() !== '')
  const canSubmit = cartItems.length > 0 && name.trim() !== '' && wa.trim() !== '' && !busy
    && deliveryReady && chosenDate !== null && !noMethods
```

- [ ] **Step 4: Stop the refusal copy promising pickup that is not offered**

In `fetchQuote`'s error branch (lines 155-165) and the `delivery_out_of_range` / `distance_lookup_failed` branches of the submit handler (~lines 825-836), the copy currently ends "You can still choose pickup." / "or choose pickup." That is a lie at a shop with pickup switched off. Add beside `defaultMode`:

```ts
  // Only offer the escape the shop actually has. "Please choose pickup instead" at a shop that
  // does not do pickup is worse than no suggestion at all — it sends the customer looking for a
  // button that is not there.
  const pickupEscape = methods.pickup
```

and make each message conditional, for example the out-of-range one:

```ts
        message: code === 'out_of_range'
          ? (pickupEscape
              ? t('Sorry, this shop does not deliver to that address. You can still choose pickup.',
                  '抱歉，本店不配送到该地址。您仍可选择自取。')
              : t('Sorry, this shop does not deliver to that address.',
                  '抱歉，本店不配送到该地址。'))
```

Apply the same treatment to the `lookup_failed` message in `fetchQuote`, and to the `delivery_out_of_range` and `distance_lookup_failed` branches of the submit handler. There are **four** messages in total that name pickup.

- [ ] **Step 5: Message the new refusal**

In the submit handler's error map, beside `delivery_state_required`:

```ts
      } else if (code === 'method_not_offered') {
        // Unreachable from this form — it renders no button for a method the shop does not
        // offer — and messaged anyway, because the alternative is the customer reading the
        // literal string `method_not_offered` on the checkout screen. It fires if the merchant
        // switches a method off while someone is mid-checkout.
        const msg = t('This shop no longer offers that option. Please choose another.',
                      '本店已不再提供该方式，请另选一种。')
        setError(msg)
        toast.error(msg)
```

- [ ] **Step 6: Render one button per offered method**

Replace the two hard-coded buttons in the Fulfilment section (lines 1176-1225) with a loop over the offered methods. The button classes are copied verbatim from the existing markup.

```tsx
            <div className="flex gap-[10px]" role="group" aria-label={t('Fulfilment method', '配送方式')}>
              {FULFILMENT_METHODS.filter(m => methods[m]).map(m => (
                <button
                  key={m}
                  type="button"
                  className={cn(
                    "flex-1 border rounded-md py-[10px] px-[14px] pointer-coarse:min-h-11 cursor-pointer text-[14px] font-sans text-center transition-all hover:border-oxblood focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2",
                    mode === m
                      ? "border-[1.5px] border-oxblood bg-oxblood-tint text-oxblood font-medium"
                      : "border-clay-border bg-surface-raised text-ink"
                  )}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                >
                  {/* The fee is stated BEFORE the customer types an address — what they are
                      committing to is the rate, not a number they have yet to see. The express
                      formula is gated on `distance.usable`, not on the bare flag: `shopDistance`
                      defaults base/ratePerKm to 0 for the UNUSABLE case specifically so nothing
                      downstream mistakes them for a chosen rate, and rendering "RM 0.00 + RM
                      0.00/km" here would be exactly that mistake (#101 review, Finding 3). */}
                  {m === 'pickup'
                    ? fulfilmentLabel('pickup', t)
                    : m === 'delivery'
                      ? <>{fulfilmentLabel('delivery', t)} (+{formatMoney(baseDeliveryFee, currency)})</>
                      : distance.usable
                        ? t(`Express delivery — ${formatMoney(distance.base, currency)} + ${formatMoney(distance.ratePerKm, currency)}/km`,
                             `快速配送 — ${formatMoney(distance.base, currency)} + ${formatMoney(distance.ratePerKm, currency)}/公里`)
                        : fulfilmentLabel('express', t)}
                </button>
              ))}
            </div>
            {noMethods && (
              /* Unreachable past `merchants_one_fulfilment_method`. Said anyway, because the
                 alternative is a checkout with no buttons and no explanation. */
              <p className="text-[13px] text-oxblood mt-3">
                {t('This shop is not accepting orders right now.', '本店目前暂不接受订单。')}
              </p>
            )}
```

Import `FULFILMENT_METHODS` from `@bitetime/shared` and `fulfilmentLabel` from `'../fulfilmentLabel'`.

- [ ] **Step 7: Branch the address form on the selected method**

The pickup blurb's condition (line 1226) is unchanged — `mode === 'pickup' && merchant?.pickup_address`.

Today one wrapper, `{mode === 'delivery' && (…)}`, contains a ternary whose arms are the two address forms. Split it into two siblings, each guarded by the method it belongs to.

This is a **re-wrap, not a rewrite**: the express arm's `<AddressAutocomplete>` + unit `<Input>` + `{quoting && …}` spinner + `{quoteErrorForThisAddress && …}` line move across whole, and so does the delivery arm's `sf-line1` / postcode / city / state form. Only the guards and the refusal copy change.

```tsx
            {mode === 'express' && (
              <div className="flex flex-col gap-3 mt-3">
                {distance.usable ? (
                  <>{/* …the existing AddressAutocomplete + unit field + quote spinner/error… */}</>
                ) : (
                  // `usable === false`: no address field at all. Offering one would invite a pick
                  // that can never quote, and a region form here is the exact fallback
                  // `ShopDistance.usable`'s contract forbids. Unreachable today — the DB and the
                  // backend cannot construct this state — but the storefront must not silently
                  // invent a fee if they ever could.
                  <p className="text-[13px] text-oxblood">
                    {methods.pickup
                      ? t('Express delivery is not available at this shop right now. Please choose pickup instead.',
                          '本店目前暂不提供快速配送，请改选自取。')
                      : t('Express delivery is not available at this shop right now.',
                          '本店目前暂不提供快速配送。')}
                  </p>
                )}
              </div>
            )}

            {mode === 'delivery' && (
              <div className="flex flex-col gap-3 mt-3">
                {/* …the existing free-text line1 / postcode / city / state form, verbatim… */}
              </div>
            )}
```

The `line1` field in the delivery form keeps going through `clearAddressForNewText` — the comment there explains why, and it now matters more, not less: a customer who switches from Express to Delivery at the same shop is carrying a confirmed place id into a form with no field to confirm one.

- [ ] **Step 8: Verify the whole flow in the running app**

```bash
pnpm dev
```

With a shop configured (Task 8) for **all three** methods:

1. The storefront shows three buttons. Pickup is selected; the pickup address blurb shows.
2. Choose **Delivery**: the free-text address + state form appears, the summary shows the flat WM fee, and the button reads `Delivery (+RM 8.00)`.
3. Choose **Express**: the autocomplete + unit field appears. Pick an address — the spinner runs, then the summary reads `Express delivery fee (X.X km)` with a fee matching `base + rate × km`.
4. Switch back to **Delivery**: the fee returns to the flat rate and the state select is back.
5. Place the express order. The confirmation, **Order history** and the merchant dashboard all say `Express delivery`; the Telegram message says `*Mode:* Express delivery` with a `*Distance:*` line.
6. Switch the language to 中文 and confirm `自取` / `送货` / `快速配送`.
7. In Shop Settings, switch **Pickup off**. Reload the storefront: two buttons, Delivery selected by default. Enter an address the shop cannot route to and confirm the refusal no longer says "choose pickup".

- [ ] **Step 9: Run the full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add apps/frontend/src/store/Storefront.tsx
git commit -m "feat(storefront): offer the methods the shop actually offers

One button per enabled method, and the address form now branches on what
the CUSTOMER chose rather than on a policy flag on the shop: express
asks for a confirmed place, delivery asks for a state, and one session
can visit both.

The refusal copy stops promising pickup. 'Please choose pickup instead'
at a shop that does not do pickup sends the customer looking for a
button that is not there."
```

---

### Task 10: Delete the compatibility field, and write the docs down

**Files:**
- Modify: `packages/shared/src/pricing.ts` (`ShopDistance.mode`)
- Modify: `CONTEXT.md` (the *Shipping policy* section, lines 29-46, and the `mode` allowlist paragraph at line 21)
- Modify: `docs/adr/0001-distance-fees-from-a-cached-google-route.md`
- Create: `docs/adr/0002-fulfilment-methods-coexist.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `ShopDistance` no longer carries `mode`.

- [ ] **Step 1: Confirm nothing reads the compat field**

```bash
grep -rnE "\.mode (===|!==) '(distance|region)'" --include="*.ts" --include="*.tsx" apps packages | grep -v node_modules | grep -v worktrees
```
Expected: **no output**. The pattern catches `!==` as well as `===`, and any variable name — the quote endpoint's reader was `policy.mode !== 'distance'`, not `distance.mode`. If anything matches, it is a reader Tasks 2-9 missed; migrate it to `.enabled` before continuing.

- [ ] **Step 2: Delete it**

In `packages/shared/src/pricing.ts`, remove the `@deprecated mode` field from `interface ShopDistance` and the `mode: enabled ? 'distance' : 'region',` line from `shopDistance`'s return. Update `shopDistance`'s own doc comment: it maps a merchant row to **the express policy**, and its first line should say so.

- [ ] **Step 3: Run the full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @bitetime/backend test:db
```
Expected: all green. A missed reader shows up here as a typecheck error.

- [ ] **Step 4: Rewrite `CONTEXT.md`**

Replace the heading and opening paragraph of the *Shipping policy* section (lines 29-31) with:

```markdown
## Fulfilment methods

What a customer can choose, and what that choice costs. A shop offers one or more of **three**, and the set is closed: `pickup`, `delivery` and `express`. Each is switched on or off independently on `merchants` (`pickup_enabled` / `delivery_enabled` / `express_enabled`), and **at least one must be on** — `merchants_one_fulfilment_method` makes that a database fact rather than a UI courtesy. A method switched off keeps its configuration, dormant, the same arrangement a disabled tax keeps its `tax_rate`.

Which rule prices a delivery is a property **of the method**, not of the shop, and that is the whole point: one shop can post parcels at a flat rate and run a rider by the kilometre.

- **`pickup`** — no fee, and no address. Shows `pickup_address`, which is display-only free text.
- **`delivery`** — a flat rate per region (`WM` / `EM`), selected by the state the customer declared. See *Order pricing* above.
- **`express`** — `fee = base + rate × routed distance`. Two merchant-typed numbers and an optional `max_km`. A shop that wants pure per-km sets `base` to 0.

**`shopMethods(row) → { pickup, delivery, express }`** is the one reading of those columns, the fourth of `shopRates`' family and shared for the identical reason: the storefront renders its buttons from it and intake refuses from it (`method_not_offered`), and the two disagreeing is a refused checkout. An absent column reads as that column's own default; **all three false fails closed** — no method, no order, never a fallback to pickup.
```

Then, through the rest of that section (the *Delivery origin*, *Routed distance*, *Distance quote* and *Distance failures* paragraphs), replace "distance mode" / "distance pricing" with "express" where it names the method, and:

- **line 21** — the allowlist paragraph: `pickup` | `delivery` | `express`, and delete the sentence about `sameday` being deliberately absent (it is gone from the union entirely; say so in one clause instead).
- **line 36** — "Distance mode **cannot be switched on without one**" becomes "Express **cannot be switched on without one**".
- **line 38** — the receipt-line paragraph is the reversal. Replace "the receipt line reads `Delivery fee (25.2 km)`" and the parenthetical about the house term with:

```markdown
the receipt line reads `Express delivery fee (25.2 km)`, so the km on the line must be the km that produced the money. (The line is named after the **method**, not after a house term for "shipping": with `delivery` and `express` both selectable at one shop, a line reading `Delivery fee` on an express order names the wrong method. One order still wears one word for one charge — that word is now the method's own name, and `fulfilmentLabel.ts` is the single place that decides it.)
```

- **line 42** — "Falling back to the dormant region rate was rejected" still holds and gets sharper: say the region rate now belongs to a *different method the customer did not choose*.

- [ ] **Step 5: Note the supersession on ADR 0001**

Add immediately below ADR 0001's title:

```markdown
> **Amended by [ADR 0002](0002-fulfilment-methods-coexist.md) (2026-07-22, before either shipped).** This ADR assumed one shipping policy per shop, named by `merchants.shipping_mode`. That column never reached production and is gone: distance pricing is now the `express` method, which coexists with flat-rate `delivery`. Everything else here — the cached Google route, the 30-day TTL, rounding before the multiply, failing closed — is unchanged and current.
```

- [ ] **Step 6: Write ADR 0002**

Create `docs/adr/0002-fulfilment-methods-coexist.md`, following ADR 0001's structure (read it first for the house format — Status / Context / Decision / Consequences):

```markdown
# 2. Fulfilment methods coexist; the fee rule belongs to the method

Date: 2026-07-22
Status: Accepted. Amends [ADR 0001](0001-distance-fees-from-a-cached-google-route.md).

## Context

ADR 0001 gave a shop one shipping policy, `merchants.shipping_mode`, either `region` or `distance`. The other policy's configuration stayed stored but dormant.

Issue #103 asked for something that arrangement cannot express: a merchant choosing which methods their customers may pick, from pickup, delivery and express delivery. A shop that posts parcels at a flat rate **and** runs a rider by the kilometre has two live prices, not a dormant one.

Neither did the exclusivity earn its keep. It was never a customer-facing fact — the storefront showed one Delivery button either way — so it bought no simplicity a customer could perceive, and it cost the one thing the merchant actually wanted to say.

## Decision

Three independent boolean columns replace `shipping_mode`, with a CHECK keeping at least one on. `delivery` is priced by region and `express` by distance, and **the fee rule follows the method the customer chose**, not a policy on the shop. `priceOrder` branches on `mode === 'express'` where it used to branch on the shop's policy.

`shipping_mode` is deleted rather than deprecated, by rewriting its own migration. It had never reached a remote project.

## Consequences

- One shop can quote two shipping rules in one session, so the storefront's address form branches on the selected method: express needs a confirmed place id, delivery needs a state.
- "Which policy is live" is no longer answerable about a shop, and no code should ask. `shopMethods` answers "does this shop offer X"; `shopDistance` answers "can express price".
- A shop offering nothing is refused at three layers — a disabled checkbox, a backend refusal that can say why, and the CHECK constraint that is the actual guarantee.
- Falling back from express to the region rate is now plainly wrong rather than merely undesirable: it would charge by a method the customer did not choose.
- The receipt line is named after the method (`Express delivery fee (25.2 km)`), reversing ADR 0001's "one house term for the charge". The principle survives — one order, one word for one charge — but the word is the method's own name.
```

- [ ] **Step 7: Verify the docs match the code**

```bash
grep -rn "shipping_mode\|sameday" CONTEXT.md docs/adr/ apps packages --include="*.md" --include="*.ts" --include="*.tsx" --include="*.sql" | grep -v node_modules | grep -v worktrees | grep -v "docs/superpowers"
```
Expected: only the two historical mentions inside the ADRs (0001's amendment note and 0002's Context), which are describing what changed and are correct.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/pricing.ts CONTEXT.md docs/adr/
git commit -m "docs(fulfilment): record why the two delivery rules stopped being exclusive

ADR 0001 gave a shop one shipping policy. #103 needs two live at once,
so the fee rule moves from the shop to the method the customer chose,
and CONTEXT.md's Shipping policy becomes Fulfilment methods.

Also reverses that ADR's receipt-line rule, deliberately: with delivery
and express both selectable at one shop, a line reading 'Delivery fee'
on an express order names the wrong method. One order still wears one
word for one charge — the word is now the method's own name.

ShopDistance.mode, the compat field that let the column cascade land in
small commits, goes now that no reader is left."
```

---

## Final verification

- [ ] **Full gate, from a clean install**

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test
cd apps/backend && supabase db reset && cd ../..
pnpm --filter @bitetime/backend test:db
```
Expected: all green.

- [ ] **The issue's own acceptance criteria, in the running app**

```bash
pnpm dev
```

1. A merchant can switch each of pickup, delivery and express on and off independently. ✔ #103 (1)
2. They cannot switch all three off. ✔ #103 (2)
3. The storefront offers exactly the methods that are on, and prices each by its own rule.

- [ ] **Update the PR**

```bash
gh pr edit 104 --body "$(gh pr view 104 --json body -q .body)

Also closes #103 — merchants now choose which fulfilment methods they offer (pickup / delivery / express delivery), with at least one always enabled. \`shipping_mode\` is replaced by three independent flags; see docs/adr/0002-fulfilment-methods-coexist.md."
```
