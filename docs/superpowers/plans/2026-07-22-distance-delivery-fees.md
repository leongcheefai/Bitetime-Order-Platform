# Distance-Based Delivery Fees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant charge delivery as `base + rate × routed road km` instead of a flat per-region rate, with the distance measured once per address pair and cached, so the browser's quote and the backend's charge are the same number.

**Architecture:** A shop carries an explicit `shipping_mode` (`region` | `distance`). The fee arithmetic goes into the shared pricing module (`packages/shared/src/pricing.ts`) so both sides of the wire derive it identically. The road distance is I/O, so it enters pricing as a plain input: a backend policy module (`apps/backend/src/distance.ts`) resolves `(origin place id, destination place id) → metres` from a 30-day cache, calling Google Routes through an injected adapter only on a miss. The storefront's quote endpoint writes the cache row; order intake reads it, **before the order transaction opens**. Address capture on both sides goes through backend-proxied Google Places autocomplete, so no Maps key reaches the browser.

**Tech Stack:** TypeScript everywhere. Hono + postgres.js (backend), React 19 + Vite (frontend), Vitest, Supabase/Postgres migrations, Google Maps Platform (Routes API v2, Places API New).

## Global Constraints

Copied from issue #101, `CONTEXT.md → Shipping policy`, and `docs/adr/0001-distance-fees-from-a-cached-google-route.md`. Every task's requirements implicitly include these.

- **Region pricing is untouched and stays the default.** A shop on `shipping_mode = 'region'` must produce byte-identical money to today, and every new shop is created on `region`.
- **The fee is `base + rate × km`, and km is rounded to ONE decimal BEFORE the rate multiplies it.** Money is then rounded to 2 decimals. The acceptance pair: base `6.00`, rate `1.00`/km, a route of `25216` m → `25.2 km` → `31.20`. If an implementation cannot produce that pair, its rounding is wrong.
- **Fail closed.** No fee is ever invented for an address that could not be routed. Never fall back to the shop's dormant region rate. An unresolvable distance is a *refusal*, never a number.
- **Out-of-range and no-route are the same fact to the customer** (one message: "this shop does not deliver there"). Only a genuine lookup failure says "try again".
- **The distance is never read from the request body.** The customer supplies a *place id*; the metres come from the cache/provider.
- **The quote endpoint accepts a place id, never free text.** Free text mints unlimited billable lookups.
- **Maps credentials never reach the browser.** Autocomplete and details are proxied by the backend.
- **The routing call happens outside the order transaction.** The transaction holds the shop's `order_counters` row lock.
- **Distance cache TTL is exactly 30 days.** Contractual (Google's terms), not a tuning knob. Do not raise it.
- **Percent vouchers still discount `subtotal + shipping`; tax still excludes shipping.** Do not change either.
- **`OrderErrorCode` is a deliberate twin** across `apps/backend/src/orders.ts` and `apps/frontend/src/store.ts`. A code added on one side without a bilingual `t(en, zh)` message on the other shows "something went wrong" for a refusal whose reason is known.
- **Localisation:** every user-facing string is `t(english, chinese)`. No i18n library.
- **Backend relative imports keep `.js` specifiers** (NodeNext); frontend imports are extensionless (bundler resolution).
- **`db.ts` is RLS-exempt.** Tenancy on the backend path is a TypeScript invariant — check it in code.
- **DB-backed suites never mock the database.** `pnpm --filter @bitetime/backend test:db` needs a running local Supabase.
- **A migration file is not applied until `pnpm --filter @bitetime/backend db:migrate` runs.**
- **No new backend runtime dependency** is introduced (Google is reached with global `fetch`). If you add one anyway, you must add its `--external:` flag to the esbuild bundle command.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/backend/supabase/migrations/20260722120000_distance_shipping.sql` | Merchant policy columns + order snapshot columns + `distance_quotes` cache table |
| `apps/backend/src/maps.ts` | The ONLY place that talks to Google — Routes v2 and Places (New) adapters |
| `apps/backend/src/distance.ts` | Distance-resolution policy: cache read → provider on miss → cache write. Adapters injected |
| `apps/backend/tests/unit/distance.test.ts` | Policy unit tests with a fake adapter and a fake cache. No network, no DB |
| `apps/backend/tests/api/shippingQuote.test.ts` | Wire contract for `POST /api/shipping/quote`, against real Postgres |
| `apps/frontend/src/store/AddressAutocomplete.tsx` | The place-picker input, shared by the storefront and Shop Settings |
| `apps/frontend/src/places.ts` | Browser-side client for the proxied autocomplete/details endpoints + session token |

**Modified**

| File | Change |
|---|---|
| `packages/shared/src/pricing.ts` | `ShopDistance`, `shopDistance`, `routedKm`, `distanceFee`, `exceedsMaxKm`; `PriceInput.distance`/`.routedMetres`; `PriceBreakdown.shippingPending` |
| `packages/shared/src/index.ts` | Re-export the above |
| `packages/shared/src/pricing.test.ts` | Fee arithmetic, rounding order, mapper fallbacks, cross-driver, region regression |
| `apps/backend/src/env.ts` | `googleMapsApiKey` (optional) |
| `apps/backend/src/orders.ts` | Policy read + pre-transaction distance resolution, 3 new refusal codes, order snapshot columns |
| `apps/backend/src/app.ts` | `POST /api/shipping/quote`, `GET /api/places/suggest`, `GET /api/places/detail/:placeId`, rate limits |
| `apps/backend/src/writes.ts` | Allowlist + validation for the new merchant columns |
| `apps/backend/src/notify.ts` | Distance line and address unit in the Telegram message |
| `apps/backend/tests/rls/helpers.ts` | `seedMerchant` accepts the distance policy fields |
| `apps/backend/tests/api/orders.test.ts` | Distance intake, refusals, rollback, snapshot columns |
| `apps/backend/tests/unit/notify.test.ts` | Distance line assertions |
| `apps/backend/tests/api/writes-merchants.test.ts` | Allowlist/validation assertions |
| `apps/frontend/src/types.ts` | `AddressParts.unit`/`.place_id`, `Merchant` policy fields, `Order` distance fields |
| `apps/frontend/src/store.ts` | New `OrderErrorCode`s, `quoteDelivery`, `DeliveryQuoteError` |
| `apps/frontend/src/store/Storefront.tsx` | Distance-mode delivery flow |
| `apps/frontend/src/merchant/ShopSettings.tsx` | Shipping-policy UI (mode, origin, base, rate, max) |
| `apps/frontend/src/store/ReceiptDialog.tsx`, `apps/frontend/src/merchant/OrdersView.tsx` | Distance on the fee line |
| `apps/frontend/src/address.ts` | `formatAddress` includes the unit |
| `CONTEXT.md`, `CLAUDE.md` | Glossary already written; correct the stale pricing-module path |

---

### Task 1: Schema — merchant policy, order snapshot, distance cache

**Files:**
- Create: `apps/backend/supabase/migrations/20260722120000_distance_shipping.sql`
- Modify: `apps/backend/tests/rls/helpers.ts:70-100` (`resetMerchant`, `seedMerchant`)

**Interfaces:**
- Consumes: nothing.
- Produces: columns `merchants.shipping_mode | delivery_base_fee | delivery_rate_per_km | delivery_max_km | origin_place_id | origin_lat | origin_lng | origin_address`; columns `orders.delivery_distance_km | delivery_base_fee | delivery_rate_per_km`; table `distance_quotes(origin_place_id, destination_place_id, metres, created_at)`. `seedMerchant` gains optional `shipping_mode`, `delivery_base_fee`, `delivery_rate_per_km`, `delivery_max_km`, `origin_place_id`.

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260722120000_distance_shipping.sql`:

```sql
-- Distance-based delivery fees (#101, spec #100). See CONTEXT.md -> "Shipping policy" and
-- docs/adr/0001-distance-fees-from-a-cached-google-route.md.
--
-- Real, typed columns rather than keys in the `shipping` jsonb: a CHECK constraint is what
-- stops a half-configured distance shop from ever pricing an order, and jsonb cannot have one.
-- Same argument as merchants.tax_enabled/tax_rate (20260720140000).
--
-- Every default keeps an existing shop EXACTLY where it is: shipping_mode 'region'.

alter table merchants
  add column shipping_mode        text          not null default 'region',
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
  add constraint merchants_shipping_mode_valid
    check (shipping_mode in ('region', 'distance')),
  add constraint merchants_delivery_base_fee_nonneg
    check (delivery_base_fee >= 0),
  add constraint merchants_delivery_rate_nonneg
    check (delivery_rate_per_km >= 0),
  add constraint merchants_delivery_max_km_positive
    check (delivery_max_km is null or delivery_max_km > 0),
  -- The validation that makes "you cannot half-configure your way into quoting nothing" a
  -- database fact rather than a UI courtesy: distance mode REQUIRES an origin to route from.
  add constraint merchants_distance_requires_origin
    check (shipping_mode <> 'distance' or origin_place_id is not null);

comment on column merchants.shipping_mode is
  'Which shipping policy is live: region (flat WM/EM rates) or distance (base + rate x km). The other policy''s configuration stays stored but dormant.';
comment on column merchants.delivery_max_km is
  'Routed km beyond which this shop does not deliver. NULL = no limit.';
comment on column merchants.origin_place_id is
  'The delivery origin''s Google place id — the routing origin AND the distance cache key. A merchant who moves changes this and so invalidates their own cached distances.';

-- The order snapshot. `delivery_distance_km` LABELS the receipt line, the same reason
-- orders.tax_rate is stored rather than derived. base/rate are stored because
-- `base + rate x km` has two unknowns and one equation: without them no past order's fee is
-- reconstructable once the merchant edits their rates.
--
-- All three are NULL on a region-priced shop's orders, and NULL on every order placed before
-- this shipped. Readers must treat NULL as "no distance line", never as 0 km.
alter table orders
  add column delivery_distance_km numeric(6,1),
  add column delivery_base_fee    numeric(10,2),
  add column delivery_rate_per_km numeric(10,2);

comment on column orders.delivery_distance_km is
  'Routed km this order was charged for. NULL for region-priced orders.';

-- The distance cache: one row per (origin, destination) place-id pair.
--
-- Rows expire after 30 days. That TTL is GOOGLE''S TERMS, not a tuning knob — do not raise it.
-- Expiry is enforced by the reader (`created_at >= now() - interval '30 days'`), not by a sweep:
-- a stale row is simply a miss, and re-resolving overwrites it.
create table distance_quotes (
  origin_place_id      text        not null,
  destination_place_id text        not null,
  metres               integer     not null check (metres >= 0),
  created_at           timestamptz not null default now(),
  primary key (origin_place_id, destination_place_id)
);

-- Backend-only, like every other table since 20260718130000. db.ts connects as the database
-- owner and is RLS-exempt; RLS-with-no-policies plus zero browser grants is the backstop.
alter table distance_quotes enable row level security;
revoke all on public.distance_quotes from anon, authenticated;

-- The application path (`src/db.ts`) connects as the database owner and needs no grant. This
-- one is for the service-role REST client: the DB-backed suites seed and clear cache rows
-- through it, and a table created after 20260718130000 inherits no DML grants at all. Same
-- reason 20260720120000_merchant_feedback.sql carries an explicit grant.
grant select, insert, update, delete on table public.distance_quotes to service_role;

comment on table distance_quotes is
  'Cached (origin, destination) -> metres routes. Written by the quote endpoint, read by order intake, so the quote and the charge are the same number without asking Google twice. 30-day TTL is contractual.';
```

- [ ] **Step 2: Apply it and confirm the columns exist**

Run: `pnpm --filter @bitetime/backend db:migrate`
Expected: the migration applies with no error. Then run:

```bash
psql "$(cd apps/backend && supabase status -o env | grep DB_URL | cut -d= -f2 | tr -d '"')" \
  -c "select column_name from information_schema.columns where table_name='merchants' and column_name like '%delivery%' or column_name in ('shipping_mode','origin_place_id');"
```
Expected: `shipping_mode`, `delivery_base_fee`, `delivery_rate_per_km`, `delivery_max_km`, `origin_place_id` listed.

- [ ] **Step 3: Teach the test fixtures the new columns**

In `apps/backend/tests/rls/helpers.ts`, extend `seedMerchant`'s parameter type and insert. Add to the `fields` type, after `tax_rate?: number`:

```ts
  /** Distance policy (#101). Omitted fields keep the column defaults — i.e. a region-priced shop. */
  shipping_mode?: 'region' | 'distance'
  delivery_base_fee?: number
  delivery_rate_per_km?: number
  delivery_max_km?: number | null
  origin_place_id?: string
```

and add to the `.insert({...})` object, after the `tax_rate` spread:

```ts
      ...(fields.shipping_mode !== undefined ? { shipping_mode: fields.shipping_mode } : {}),
      ...(fields.delivery_base_fee !== undefined ? { delivery_base_fee: fields.delivery_base_fee } : {}),
      ...(fields.delivery_rate_per_km !== undefined ? { delivery_rate_per_km: fields.delivery_rate_per_km } : {}),
      ...(fields.delivery_max_km !== undefined ? { delivery_max_km: fields.delivery_max_km } : {}),
      ...(fields.origin_place_id !== undefined ? { origin_place_id: fields.origin_place_id } : {}),
```

`resetMerchant` needs no change — `distance_quotes` has no `merchant_id`; it is keyed by place ids and shared across shops by design.

- [ ] **Step 4: Prove the constraint bites**

Run:
```bash
psql "$(cd apps/backend && supabase status -o env | grep DB_URL | cut -d= -f2 | tr -d '"')" \
  -c "insert into merchants (slug, name, order_prefix, shipping_mode) values ('cx-test','cx','CX','distance');"
```
Expected: `ERROR: new row for relation "merchants" violates check constraint "merchants_distance_requires_origin"`

- [ ] **Step 5: Commit**

```bash
git add apps/backend/supabase/migrations/20260722120000_distance_shipping.sql apps/backend/tests/rls/helpers.ts
git commit -m "feat(db): distance shipping policy, order snapshot and distance cache"
```

---

### Task 2: The fee arithmetic in the shared pricing module

**Files:**
- Modify: `packages/shared/src/pricing.ts`
- Modify: `packages/shared/src/index.ts:14-22`
- Test: `packages/shared/src/pricing.test.ts`

**Interfaces:**
- Consumes: Task 1's column names (as row keys).
- Produces:
  - `interface ShopDistance { mode: 'region' | 'distance'; base: number; ratePerKm: number; maxKm: number | null; originPlaceId: string | null; usable: boolean }`
  - `shopDistance(row: unknown): ShopDistance`
  - `routedKm(metres: number): number`
  - `distanceFee(policy: ShopDistance, km: number): number`
  - `exceedsMaxKm(policy: ShopDistance, km: number): boolean`
  - `PriceInput.distance?: ShopDistance`, `PriceInput.routedMetres?: number | null`
  - `PriceBreakdown.shippingPending: boolean`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/pricing.test.ts`. Add `shopDistance, routedKm, distanceFee, exceedsMaxKm` to the existing import from `./pricing.js`, and `ShopDistance` to the type import.

```ts
const DISTANCE_ROW = {
  shipping_mode: 'distance',
  delivery_base_fee: 6,
  delivery_rate_per_km: 1,
  delivery_max_km: null,
  origin_place_id: 'ChIJorigin',
}

describe('shopDistance', () => {
  it('maps a distance-mode row and reports it usable', () => {
    expect(shopDistance(DISTANCE_ROW)).toEqual({
      mode: 'distance', base: 6, ratePerKm: 1, maxKm: null,
      originPlaceId: 'ChIJorigin', usable: true,
    })
  })

  it('maps postgres.js strings identically to PostgREST numbers', () => {
    // THE CROSS-DRIVER TRAP: postgres.js returns `numeric` as a STRING ('6.00'), PostgREST as a
    // number. The browser quotes from one and the backend charges from the other; mapping only
    // one side is a `price_changed` refusal on every distance order at that shop.
    expect(shopDistance({
      shipping_mode: 'distance',
      delivery_base_fee: '6.00',
      delivery_rate_per_km: '1.00',
      delivery_max_km: '20.0',
      origin_place_id: 'ChIJorigin',
    })).toEqual(shopDistance({ ...DISTANCE_ROW, delivery_max_km: 20 }))
  })

  it('reads a region-mode row as region and never as a broken distance shop', () => {
    const p = shopDistance({ shipping_mode: 'region', delivery_base_fee: 6, origin_place_id: null })
    expect(p.mode).toBe('region')
  })

  it('treats a missing shipping_mode as region — every shop that predates this feature', () => {
    expect(shopDistance({}).mode).toBe('region')
    expect(shopDistance(null).mode).toBe('region')
  })

  it('is UNUSABLE, never zero-rated, when a distance shop has no origin', () => {
    expect(shopDistance({ ...DISTANCE_ROW, origin_place_id: null }).usable).toBe(false)
  })

  it('is UNUSABLE when a rate is unparseable or negative', () => {
    expect(shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: null }).usable).toBe(false)
    expect(shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: -1 }).usable).toBe(false)
    expect(shopDistance({ ...DISTANCE_ROW, delivery_base_fee: -0.5 }).usable).toBe(false)
  })

  it('accepts an honest zero base and an honest zero rate', () => {
    expect(shopDistance({ ...DISTANCE_ROW, delivery_base_fee: 0 }).usable).toBe(true)
    expect(shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: 0 }).usable).toBe(true)
  })

  it('keeps a null maximum as "no limit" and rejects a non-positive one', () => {
    expect(shopDistance(DISTANCE_ROW).maxKm).toBeNull()
    expect(shopDistance({ ...DISTANCE_ROW, delivery_max_km: 0 }).usable).toBe(false)
  })
})

describe('routedKm / distanceFee', () => {
  const policy = shopDistance(DISTANCE_ROW)

  it('reproduces the reference image exactly: 25216 m at 6.00 + 1.00/km is 25.2 km and 31.20', () => {
    const km = routedKm(25216)
    expect(km).toBe(25.2)
    expect(distanceFee(policy, km)).toBe(31.2)
  })

  it('rounds the km BEFORE the rate multiplies it', () => {
    // Rounding after would give 25.22 here, printed beside a line that says 25.2 km. A receipt
    // line that does not reconcile on a calculator is a support ticket.
    const pureRate = shopDistance({ ...DISTANCE_ROW, delivery_base_fee: 0 })
    expect(distanceFee(pureRate, routedKm(25216))).toBe(25.2)
  })

  it('rounds the km half-up and half-down', () => {
    expect(routedKm(25260)).toBe(25.3)
    expect(routedKm(25240)).toBe(25.2)
    expect(routedKm(0)).toBe(0)
  })

  it('prices a zero base as pure per-km and a zero rate as a flat base', () => {
    expect(distanceFee(shopDistance({ ...DISTANCE_ROW, delivery_base_fee: 0, delivery_rate_per_km: 2 }), routedKm(3000))).toBe(6)
    expect(distanceFee(shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: 0 }), routedKm(12345))).toBe(6)
  })

  it('reports a distance beyond the shop maximum, and never with a null maximum', () => {
    const capped = shopDistance({ ...DISTANCE_ROW, delivery_max_km: 20 })
    expect(exceedsMaxKm(capped, 20)).toBe(false)   // inclusive: exactly at the cap still delivers
    expect(exceedsMaxKm(capped, 20.1)).toBe(true)
    expect(exceedsMaxKm(shopDistance(DISTANCE_ROW), 999)).toBe(false)
  })
})

describe('priceOrder under a distance policy', () => {
  const distance = shopDistance(DISTANCE_ROW)

  it('charges base + rate x rounded km for a delivery', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance, routedMetres: 25216,
    })
    expect(r.shipping).toBe(31.2)
    expect(r.shippingPending).toBe(false)
    expect(r.total).toBe(41.2)
  })

  it('ignores the shop region rates entirely — the dormant policy must never leak into a total', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Sabah', rates: { WM: 8, EM: 999 }, now: NOW,
      distance, routedMetres: 25216,
    })
    expect(r.shipping).toBe(31.2)
  })

  it('charges NOTHING and flags the fee pending when the distance is not known yet', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance, routedMetres: null,
    })
    expect(r.shipping).toBe(0)
    expect(r.shippingPending).toBe(true)
  })

  it('flags pending — never a fee — for a distance shop whose configuration cannot price', () => {
    const broken = shopDistance({ ...DISTANCE_ROW, delivery_rate_per_km: null })
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance: broken, routedMetres: 25216,
    })
    expect(r.shipping).toBe(0)
    expect(r.shippingPending).toBe(true)
  })

  it('charges no shipping on a pickup at a distance shop, and never flags it pending', () => {
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'pickup', rates: RATES, now: NOW, distance, routedMetres: null,
    })
    expect(r.shipping).toBe(0)
    expect(r.shippingPending).toBe(false)
  })

  it('discounts a percent voucher off subtotal PLUS the distance fee, unchanged', () => {
    // Deliberately unchanged (#101 "What deliberately does not change"): moving the discount
    // base would shift totals at every shop that never asked for distance pricing.
    const r = priceOrder({
      products: [product('a', 10)], cart: { a: 1 },
      mode: 'delivery', state: 'Selangor', rates: RATES, now: NOW,
      distance, routedMetres: 25216,
      voucher: { code: 'X', type: 'percent', value: 20 },
    })
    expect(r.discount).toBe(8.24) // 20% of 41.20
  })
})

describe('region pricing is untouched', () => {
  it('produces the same money with and without the distance fields present', () => {
    const base = {
      products: [product('a', 10)], cart: { a: 2 },
      mode: 'delivery' as const, state: 'Sabah', rates: RATES, now: NOW,
      tax: { enabled: true, rate: 6 },
    }
    const before = priceOrder(base)
    const after = priceOrder({ ...base, distance: shopDistance({ shipping_mode: 'region' }), routedMetres: 25216 })
    expect(after.shipping).toBe(before.shipping)
    expect(after.subtotal).toBe(before.subtotal)
    expect(after.discount).toBe(before.discount)
    expect(after.tax).toBe(before.tax)
    expect(after.total).toBe(before.total)
    expect(after.shippingPending).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bitetime/shared test`
Expected: FAIL — `shopDistance is not a function` (and TypeScript errors for the unknown `distance` / `routedMetres` / `shippingPending` fields).

- [ ] **Step 3: Implement in `packages/shared/src/pricing.ts`**

Add after the `shopTax` function (keeping `num` and `round2` where they are):

```ts
export interface ShopDistance {
  /** Which shipping policy is LIVE. The other policy's configuration stays stored but dormant. */
  mode: 'region' | 'distance'
  base: number
  ratePerKm: number
  /** null = no limit. Never 0 — a 0 would be an honest "deliver nowhere". */
  maxKm: number | null
  originPlaceId: string | null
  /**
   * Distance mode AND a configuration complete enough to price with. Meaningless in region mode.
   *
   * FALSE IS A REFUSAL, NOT A FALLBACK. A distance-mode shop whose rate is missing, negative or
   * unparseable does not quote 0 shipping and does not fall back to its dormant region rate —
   * that would charge by a formula the merchant switched off, under a receipt line that cannot
   * honestly name a distance. It quotes nothing and the caller refuses the delivery.
   */
  usable: boolean
}

/**
 * A merchant row → the distance policy `priceOrder` charges. The third of `shopRates`'
 * and `shopTax`'s family, and it exists for the identical reason: the browser quotes and the
 * backend charges, and a disagreement between them is a `price_changed` refusal for every
 * order at that shop, not a rounding gap.
 *
 * `num()` is not defensiveness — postgres.js returns `numeric` as a STRING ('6.00') while
 * PostgREST returns a number (6). These are `numeric` columns and inherit that trap exactly.
 *
 * The fallback direction is always toward REFUSAL (`usable: false`), never toward a number
 * nobody chose. That is the same direction `shopTax` fails in, for the same reason.
 */
export function shopDistance(row: unknown): ShopDistance {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const mode = r.shipping_mode === 'distance' ? 'distance' : 'region'
  const base = num(r.delivery_base_fee)
  const ratePerKm = num(r.delivery_rate_per_km)
  const maxKmRaw = num(r.delivery_max_km)
  const originPlaceId = typeof r.origin_place_id === 'string' && r.origin_place_id ? r.origin_place_id : null

  const usable =
    mode === 'distance' &&
    originPlaceId !== null &&
    base !== null && base >= 0 &&
    ratePerKm !== null && ratePerKm >= 0 &&
    (r.delivery_max_km == null || (maxKmRaw !== null && maxKmRaw > 0))

  return {
    mode,
    base: base ?? 0,
    ratePerKm: ratePerKm ?? 0,
    maxKm: maxKmRaw !== null && maxKmRaw > 0 ? maxKmRaw : null,
    originPlaceId,
    usable,
  }
}

/**
 * Routed metres → the kilometres the fee is charged on, rounded to ONE decimal.
 *
 * THE ROUNDING HAPPENS HERE, BEFORE THE RATE MULTIPLIES IT, and that order is part of the
 * customer-facing contract, not cosmetics: the receipt line reads `Delivery Fee (25.2 km)`, so
 * the km on the line must be the km that produced the money. Rounding afterwards prints 25.2 km
 * beside a fee derived from 25.216, and a line that does not reconcile on a calculator is a
 * support ticket.
 */
export function routedKm(metres: number): number {
  return parseFloat((metres / 1000).toFixed(1))
}

/** `base + rate × km`, rounded to money. `km` must already have been through `routedKm`. */
export function distanceFee(policy: ShopDistance, km: number): number {
  return round2(policy.base + policy.ratePerKm * km)
}

/** Beyond the shop's maximum? Inclusive at the cap — exactly `maxKm` still delivers. */
export function exceedsMaxKm(policy: ShopDistance, km: number): boolean {
  return policy.maxKm !== null && km > policy.maxKm
}
```

In `PriceInput`, after the `tax` field:

```ts
  /**
   * The shop's shipping policy, mapped through `shopDistance`. Absent = region pricing, which is
   * every shop today.
   */
  distance?: ShopDistance
  /**
   * The routed road distance for THIS delivery, in metres. NEVER read from a request body — it
   * is resolved from the distance cache (see the backend's `resolveDistance`).
   *
   * `null`/absent on a distance-priced delivery is NOT zero shipping: the breakdown comes back
   * with `shippingPending: true` and no fee, and the caller refuses rather than pricing.
   */
  routedMetres?: number | null
```

In `PriceBreakdown`, after `taxRate`:

```ts
  /**
   * TRUE when this shop prices by distance, the mode is delivery, and no fee could be derived —
   * either no routed distance is known yet or the shop's distance configuration cannot price.
   *
   * `shipping` is 0 in that state and IS NOT A FEE. The storefront must say the fee is not yet
   * calculated and block submission; the backend refuses before it ever prices in this state.
   * Reading the 0 as a fee is precisely the invented number this feature must never produce.
   */
  shippingPending: boolean
```

Replace the `const shipping = …` line in `priceOrder` with:

```ts
  // `resolvedShipping` still wins, and it is DELIBERATELY not the channel distance pricing uses:
  // that override exists so the storefront can show a region placeholder before a state is known,
  // and routing a real charge through it would put the fee formula back in the callers — the one
  // thing this module exists to prevent.
  const distancePriced = input.mode === 'delivery' && input.distance?.mode === 'distance'
  const canPriceDistance =
    distancePriced && input.distance!.usable && input.routedMetres != null && Number.isFinite(input.routedMetres)
  const shippingPending = distancePriced && !canPriceDistance
  const shipping = input.resolvedShipping ?? (
    canPriceDistance
      ? distanceFee(input.distance!, routedKm(input.routedMetres as number))
      : shippingPending
        ? 0
        : shippingFee(input.mode, input.state, input.rates, input.samedayFee)
  )
```

and add `shippingPending` to the returned object:

```ts
  return { lines, subtotal, shipping, discount, tax, taxRate, total, shippingPending }
```

- [ ] **Step 4: Export from the package index**

In `packages/shared/src/index.ts`, extend the pricing exports:

```ts
export {
  priceOrder, voucherError, shippingFee, voucherFromRow, shopRates, shopTax,
  promoState, promoClaims, productFromRow,
  shopDistance, routedKm, distanceFee, exceedsMaxKm,
  EM_STATES, DEFAULT_WM_RATE,
} from './pricing.js'
export type {
  PriceInput, PriceBreakdown, PriceLine,
  VoucherCtx, VoucherErrorCode,
  PricedProduct, PricedVoucher, PromoState, ShopTax, ShopDistance,
} from './pricing.js'
```

- [ ] **Step 5: Run the tests and the typechecker**

Run: `pnpm --filter @bitetime/shared test && pnpm typecheck`
Expected: all pricing tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/pricing.ts packages/shared/src/pricing.test.ts packages/shared/src/index.ts
git commit -m "feat(pricing): derive distance delivery fees in the shared module"
```

---

### Task 3: The Google adapters and the API key

**Files:**
- Create: `apps/backend/src/maps.ts`
- Modify: `apps/backend/src/env.ts:26-29`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type RouteOutcome = { status: 'ok'; metres: number } | { status: 'no_route' } | { status: 'failed' }`
  - `type RouteLookup = (originPlaceId: string, destinationPlaceId: string) => Promise<RouteOutcome>`
  - `googleRouteLookup: RouteLookup`
  - `interface PlaceSuggestion { placeId: string; text: string }`
  - `googlePlaceSuggest(input: string, sessionToken: string): Promise<PlaceSuggestion[]>`
  - `interface PlaceDetail { placeId: string; formatted: string; lat: number; lng: number; postcode: string; city: string; state: string }`
  - `googlePlaceDetail(placeId: string, sessionToken: string): Promise<PlaceDetail | null>`
  - `env.googleMapsApiKey: string`

- [ ] **Step 1: Add the key to env**

In `apps/backend/src/env.ts`, after the Resend block:

```ts
  // Google Maps Platform — Routes (distance) and Places (address autocomplete), on the
  // PLATFORM's account, never a merchant's: zero setup for a merchant is the whole point of the
  // dependency (see docs/adr/0001). Deliberately OPTIONAL, not `required()`: every existing
  // deployment, every dev machine and the DB test suites run without it, and a region-priced
  // shop never touches it. Unset simply means distance lookups fail — which is a refusal, and
  // failing closed is the house rule.
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
```

- [ ] **Step 2: Write the adapters**

Create `apps/backend/src/maps.ts`:

```ts
// The ONE place in this codebase that talks to Google Maps Platform.
//
// Everything here is an ADAPTER: I/O with no policy in it. The cache, the 30-day expiry, the
// out-of-range rule and the fee arithmetic all live elsewhere (distance.ts, @bitetime/shared)
// precisely so they can be tested without a network. Shaped like `telegramSend` in notify.ts,
// and injected the same way.
//
// The key is the PLATFORM's and never reaches the browser — the autocomplete and details calls
// are proxied through app.ts for exactly that reason (#101, story 49).
import { env } from './env.js'

/**
 * Three outcomes, and callers MUST tell them apart:
 *   * `ok`       — a road distance.
 *   * `no_route` — an answer about the world: there is no road route between these two points.
 *                  Not an error, and never worth retrying.
 *   * `failed`   — the lookup itself did not happen (no key, network, 5xx, quota). Retryable,
 *                  and the ONLY outcome that tells a customer to try again.
 */
export type RouteOutcome =
  | { status: 'ok'; metres: number }
  | { status: 'no_route' }
  | { status: 'failed' }

export type RouteLookup = (originPlaceId: string, destinationPlaceId: string) => Promise<RouteOutcome>

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'

/**
 * Routes API v2. `TRAFFIC_UNAWARE` on purpose: a fee must not change because the customer
 * quoted at 6pm and submitted at 6:05 — that is the permanent `price_changed` loop the ADR
 * rejected a second live call to avoid.
 *
 * The field mask is the billing surface: asking only for `routes.distanceMeters` keeps this on
 * the cheapest SKU. Do not widen it without meaning to.
 *
 * Google answers a routable-but-unreachable pair with HTTP 200 and an EMPTY `routes` array —
 * which is `no_route`, not `failed`. Collapsing the two would tell a customer in Sabah to keep
 * retrying a route to Kuala Lumpur that will never exist.
 */
export const googleRouteLookup: RouteLookup = async (originPlaceId, destinationPlaceId) => {
  if (!env.googleMapsApiKey) {
    console.error('Route lookup skipped: GOOGLE_MAPS_API_KEY is not set')
    return { status: 'failed' }
  }
  try {
    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.googleMapsApiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: { placeId: originPlaceId },
        destination: { placeId: destinationPlaceId },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
      }),
    })
    if (!res.ok) {
      console.error(`Route lookup failed: ${res.status}`)
      return { status: 'failed' }
    }
    const body = (await res.json()) as { routes?: { distanceMeters?: number }[] }
    const metres = body.routes?.[0]?.distanceMeters
    if (typeof metres !== 'number' || !Number.isFinite(metres)) return { status: 'no_route' }
    return { status: 'ok', metres }
  } catch (err) {
    console.error('Route lookup threw:', err instanceof Error ? err.message : String(err))
    return { status: 'failed' }
  }
}

export interface PlaceSuggestion {
  placeId: string
  /** What the customer reads in the dropdown. */
  text: string
}

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete'

/**
 * Places (New) Autocomplete, proxied.
 *
 * `sessionToken` is money, not hygiene: a burst of keystrokes carrying one token bills as ONE
 * lookup when it ends in a details call. The caller mints it and passes the same one through to
 * `googlePlaceDetail`.
 *
 * Failure returns an EMPTY LIST rather than throwing: a dead autocomplete must degrade to "no
 * suggestions", never to a broken checkout screen.
 */
export async function googlePlaceSuggest(input: string, sessionToken: string): Promise<PlaceSuggestion[]> {
  if (!env.googleMapsApiKey || !input.trim()) return []
  try {
    const res = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.googleMapsApiKey },
      body: JSON.stringify({
        input,
        sessionToken,
        includedRegionCodes: ['my'],
      }),
    })
    if (!res.ok) {
      console.error(`Place autocomplete failed: ${res.status}`)
      return []
    }
    const body = (await res.json()) as {
      suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[]
    }
    return (body.suggestions ?? [])
      .map(s => s.placePrediction)
      .filter((p): p is { placeId: string; text: { text: string } } => !!p?.placeId && !!p?.text?.text)
      .map(p => ({ placeId: p.placeId, text: p.text.text }))
  } catch (err) {
    console.error('Place autocomplete threw:', err instanceof Error ? err.message : String(err))
    return []
  }
}

export interface PlaceDetail {
  placeId: string
  formatted: string
  lat: number
  lng: number
  postcode: string
  city: string
  state: string
}

/**
 * Places (New) Details. Returns the printable address parts alongside the coordinates, so the
 * customer never types a postcode, city or state that the selected place already knows.
 *
 * The field mask is again the billing surface — `addressComponents` is what keeps this off the
 * most expensive SKU while still filling the form.
 */
export async function googlePlaceDetail(placeId: string, sessionToken: string): Promise<PlaceDetail | null> {
  if (!env.googleMapsApiKey || !placeId) return null
  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`
    const res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': env.googleMapsApiKey,
        'X-Goog-FieldMask': 'id,formattedAddress,location,addressComponents',
      },
    })
    if (!res.ok) {
      console.error(`Place details failed: ${res.status}`)
      return null
    }
    const body = (await res.json()) as {
      id?: string
      formattedAddress?: string
      location?: { latitude?: number; longitude?: number }
      addressComponents?: { longText?: string; shortText?: string; types?: string[] }[]
    }
    const lat = body.location?.latitude
    const lng = body.location?.longitude
    if (!body.id || typeof lat !== 'number' || typeof lng !== 'number') return null

    const part = (type: string) =>
      body.addressComponents?.find(c => c.types?.includes(type))?.longText ?? ''

    return {
      placeId: body.id,
      formatted: body.formattedAddress ?? '',
      lat,
      lng,
      postcode: part('postal_code'),
      // `locality` is the city for most Malaysian addresses; some rural ones only carry the
      // administrative level below the state. Falling back beats handing back a blank field the
      // customer then has to fill in themselves.
      city: part('locality') || part('administrative_area_level_2'),
      state: part('administrative_area_level_1'),
    }
  } catch (err) {
    console.error('Place details threw:', err instanceof Error ? err.message : String(err))
    return null
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Document the new env var**

Add `GOOGLE_MAPS_API_KEY=` to `apps/backend/.env.example` if that file exists (`ls apps/backend/.env*`); if it does not, skip this step.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/maps.ts apps/backend/src/env.ts
git commit -m "feat(backend): Google Routes and Places adapters behind one module"
```

---

### Task 4: The distance-resolution policy

**Files:**
- Create: `apps/backend/src/distance.ts`
- Test: `apps/backend/tests/unit/distance.test.ts`

**Interfaces:**
- Consumes: `RouteLookup`, `RouteOutcome` (Task 3).
- Produces:
  - `type DistanceOutcome = { status: 'ok'; metres: number } | { status: 'no_route' } | { status: 'failed' }`
  - `interface DistanceDeps { lookup: RouteLookup; readCache: (o: string, d: string, notBefore: Date) => Promise<number | null>; writeCache: (o: string, d: string, metres: number) => Promise<void> }`
  - `CACHE_TTL_MS`
  - `resolveDistance(deps: DistanceDeps, input: { originPlaceId: string; destinationPlaceId: string }, now?: Date): Promise<DistanceOutcome>`
  - `sqlDistanceCache: Pick<DistanceDeps, 'readCache' | 'writeCache'>`

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/tests/unit/distance.test.ts`:

```ts
// The distance-resolution policy, tested with a fake adapter and a fake cache — exactly the
// shape tests/unit/notify.test.ts uses for the Telegram send. NO NETWORK IN ANY TEST HERE.
//
// These assert externally observable behaviour: which distance comes back, and whether the
// provider was reached at all (which is money, not an internal detail).
import { describe, it, expect } from 'vitest'
import { resolveDistance, CACHE_TTL_MS, type DistanceDeps } from '../../src/distance.js'
import type { RouteOutcome } from '../../src/maps.js'

const NOW = new Date('2026-07-22T10:00:00Z')
const PAIR = { originPlaceId: 'ChIJorigin', destinationPlaceId: 'ChIJdest' }

/** A fake cache + a fake router, with the two things worth asserting: was the provider reached,
 *  and what got written back. Reaching the provider is MONEY, not an internal detail. */
function tracked(over: { cached?: number | null; cachedAt?: Date; route?: RouteOutcome }) {
  let calls = 0
  const written: number[] = []
  const d: DistanceDeps = {
    readCache: async (_o, _d2, notBefore) => {
      if (over.cached == null) return null
      return (over.cachedAt ?? NOW) >= notBefore ? over.cached : null
    },
    writeCache: async (_o, _d2, metres) => { written.push(metres) },
    lookup: async () => { calls++; return over.route ?? { status: 'failed' } },
  }
  return { deps: d, calls: () => calls, written }
}

describe('resolveDistance', () => {
  it('returns the cached distance and never reaches the provider', async () => {
    const t = tracked({ cached: 25216 })
    expect(await resolveDistance(t.deps, PAIR, NOW)).toEqual({ status: 'ok', metres: 25216 })
    expect(t.calls()).toBe(0)
  })

  it('calls the provider exactly once on a miss and writes the answer back', async () => {
    const t = tracked({ cached: null, route: { status: 'ok', metres: 25216 } })
    expect(await resolveDistance(t.deps, PAIR, NOW)).toEqual({ status: 'ok', metres: 25216 })
    expect(t.calls()).toBe(1)
    expect(t.written).toEqual([25216])
  })

  it('treats a row older than the 30-day TTL as a miss', async () => {
    const stale = new Date(NOW.getTime() - CACHE_TTL_MS - 1)
    const t = tracked({ cached: 111, cachedAt: stale, route: { status: 'ok', metres: 222 } })
    expect(await resolveDistance(t.deps, PAIR, NOW)).toEqual({ status: 'ok', metres: 222 })
    expect(t.calls()).toBe(1)
  })

  it('keeps a row that is one millisecond inside the TTL', async () => {
    const fresh = new Date(NOW.getTime() - CACHE_TTL_MS + 1)
    const t = tracked({ cached: 111, cachedAt: fresh })
    expect(await resolveDistance(t.deps, PAIR, NOW)).toEqual({ status: 'ok', metres: 111 })
    expect(t.calls()).toBe(0)
  })

  it('reports no_route and lookup failure as DISTINCT outcomes, and caches neither', async () => {
    const noRoute = tracked({ cached: null, route: { status: 'no_route' } })
    expect(await resolveDistance(noRoute.deps, PAIR, NOW)).toEqual({ status: 'no_route' })
    expect(noRoute.written).toEqual([])

    const failed = tracked({ cached: null, route: { status: 'failed' } })
    expect(await resolveDistance(failed.deps, PAIR, NOW)).toEqual({ status: 'failed' })
    expect(failed.written).toEqual([])
  })

  it('fails rather than routing when either place id is missing', async () => {
    const t = tracked({ cached: null, route: { status: 'ok', metres: 1 } })
    expect(await resolveDistance(t.deps, { originPlaceId: '', destinationPlaceId: 'x' }, NOW)).toEqual({ status: 'failed' })
    expect(await resolveDistance(t.deps, { originPlaceId: 'x', destinationPlaceId: '' }, NOW)).toEqual({ status: 'failed' })
    expect(t.calls()).toBe(0)
  })

  it('still returns the distance when writing the cache throws', async () => {
    // A cache that cannot be written is a cost problem, not a customer problem.
    let calls = 0
    const d: DistanceDeps = {
      readCache: async () => null,
      writeCache: async () => { throw new Error('disk on fire') },
      lookup: async () => { calls++; return { status: 'ok', metres: 500 } },
    }
    expect(await resolveDistance(d, PAIR, NOW)).toEqual({ status: 'ok', metres: 500 })
    expect(calls).toBe(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bitetime/backend test`
Expected: FAIL — `Cannot find module '../../src/distance.js'`.

- [ ] **Step 3: Implement `apps/backend/src/distance.ts`**

```ts
// Resolving an (origin, destination) pair to a road distance: read the cache, and on a miss ask
// the routing provider and write the cache.
//
// This is POLICY, not I/O. The provider call and the two cache statements are injected
// adapters — the same shape as `telegramSend` in notify.ts — so every rule here (the 30-day
// expiry, what is cached, which outcomes are distinct) is unit-testable without a network or a
// database.
//
// The three outcomes must stay distinct all the way to the customer: `no_route` is an answer
// about the world and is refused permanently; `failed` is our problem and is the ONLY one worth
// retrying. See CONTEXT.md -> "Shipping policy".
import { sql } from './db.js'
import { googleRouteLookup, type RouteLookup } from './maps.js'

export type DistanceOutcome =
  | { status: 'ok'; metres: number }
  | { status: 'no_route' }
  | { status: 'failed' }

export interface DistanceDeps {
  lookup: RouteLookup
  /** A cached distance for this pair written at or after `notBefore`, or null. */
  readCache: (originPlaceId: string, destinationPlaceId: string, notBefore: Date) => Promise<number | null>
  writeCache: (originPlaceId: string, destinationPlaceId: string, metres: number) => Promise<void>
}

/**
 * 30 days. This is GOOGLE'S TERMS — the maximum they allow this data to be retained — not a
 * performance knob. Do not raise it.
 */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export async function resolveDistance(
  deps: DistanceDeps,
  input: { originPlaceId: string; destinationPlaceId: string },
  now = new Date(),
): Promise<DistanceOutcome> {
  const { originPlaceId, destinationPlaceId } = input
  // A missing id cannot name a place, and asking Google about `''` is a billable nothing.
  if (!originPlaceId || !destinationPlaceId) return { status: 'failed' }

  const notBefore = new Date(now.getTime() - CACHE_TTL_MS)
  const cached = await deps.readCache(originPlaceId, destinationPlaceId, notBefore)
  if (cached !== null) return { status: 'ok', metres: cached }

  const outcome = await deps.lookup(originPlaceId, destinationPlaceId)
  if (outcome.status !== 'ok') return outcome

  // Only a real distance is cached. Caching `no_route` would be tempting and wrong: roads are
  // built, and a permanent negative is not ours to store. Caching `failed` would freeze OUR
  // outage into the customer's address for a month.
  try {
    await deps.writeCache(originPlaceId, destinationPlaceId, outcome.metres)
  } catch (err) {
    // A cache we could not write is a cost problem, not a customer problem. The distance we
    // already paid for still gets used.
    console.error('Distance cache write failed:', err instanceof Error ? err.message : String(err))
  }
  return outcome
}

/**
 * The real cache, on the RLS-exempt `db.ts` connection.
 *
 * `distance_quotes` is keyed by the two place ids and by nothing else — no `merchant_id`. That
 * is deliberate: two shops with the same origin are the same route, and a merchant who moves
 * changes their `origin_place_id` and so invalidates their own rows with no sweep to run.
 */
export const sqlDistanceCache: Pick<DistanceDeps, 'readCache' | 'writeCache'> = {
  readCache: async (originPlaceId, destinationPlaceId, notBefore) => {
    const rows = await sql<{ metres: number }[]>`
      select metres from distance_quotes
      where origin_place_id = ${originPlaceId}
        and destination_place_id = ${destinationPlaceId}
        and created_at >= ${notBefore}
    `
    return rows[0]?.metres ?? null
  },
  writeCache: async (originPlaceId, destinationPlaceId, metres) => {
    // Upsert, so re-resolving an EXPIRED row refreshes its timestamp rather than colliding on
    // the primary key.
    await sql`
      insert into distance_quotes (origin_place_id, destination_place_id, metres, created_at)
      values (${originPlaceId}, ${destinationPlaceId}, ${metres}, now())
      on conflict (origin_place_id, destination_place_id)
        do update set metres = excluded.metres, created_at = excluded.created_at
    `
  },
}

/** The wiring the app uses: the real cache plus the real provider. */
export const liveDistanceDeps: DistanceDeps = { ...sqlDistanceCache, lookup: googleRouteLookup }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @bitetime/backend test`
Expected: PASS (all `resolveDistance` tests green, no network).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/distance.ts apps/backend/tests/unit/distance.test.ts
git commit -m "feat(backend): cache-backed distance resolution with an injected router"
```

---

### Task 5: The quote endpoint

**Files:**
- Modify: `apps/backend/src/app.ts` (new route + windows near the other `createSlidingWindow` declarations, ~line 680)
- Test: Create `apps/backend/tests/api/shippingQuote.test.ts`

**Interfaces:**
- Consumes: `resolveDistance`, `liveDistanceDeps`, `DistanceDeps` (Task 4); `shopDistance`, `routedKm`, `distanceFee`, `exceedsMaxKm` (Task 2).
- Produces: `POST /api/shipping/quote` with body `{ merchantId: string, placeId: string }` → `200 { km: number, fee: number, currency: string }`, or `409 { error: 'out_of_range' | 'lookup_failed' | 'not_distance_priced' }`, `400 { error: 'invalid_body' }`, `404 { error: 'merchant_not_found' }`, `429 { error: 'rate_limited' | 'quota_exceeded' }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/tests/api/shippingQuote.test.ts`:

```ts
// tests/api/shippingQuote.test.ts
// POST /api/shipping/quote — the wire contract for a distance quote, driven in-process against
// real Postgres.
//
// Every case here is priced from a SEEDED CACHE ROW. That is what keeps Google out of this
// suite entirely: the endpoint's own rule is "cache first", so a seeded row is a complete,
// honest exercise of the path a real customer takes a second after their address resolves.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../../src/app.js'
import { makeUser, resetMerchant, seedMerchant, serviceClient } from '../rls/helpers.js'

const SLUGS = ['q-distance', 'q-region']
const ORIGIN = 'ChIJq-origin'
const DEST = 'ChIJq-dest'
const FAR = 'ChIJq-far'
const UNKNOWN = 'ChIJq-unknown'

const svc = () => serviceClient()

let distanceId = ''
let regionId = ''

function post(payload: unknown) {
  return app.request('/api/shipping/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function seedQuote(destination: string, metres: number) {
  await svc().from('distance_quotes').upsert({
    origin_place_id: ORIGIN,
    destination_place_id: destination,
    metres,
    created_at: new Date().toISOString(),
  })
}

beforeAll(async () => {
  const owner = await makeUser('quote-owner@test.local')
  distanceId = await seedMerchant({
    slug: 'q-distance', owner_id: owner.id, order_prefix: 'QD',
    shipping_mode: 'distance', delivery_base_fee: 6, delivery_rate_per_km: 1,
    delivery_max_km: 30, origin_place_id: ORIGIN,
  })
  regionId = await seedMerchant({ slug: 'q-region', owner_id: owner.id, order_prefix: 'QR' })
  await seedQuote(DEST, 25216)
  await seedQuote(FAR, 45000)
})

afterAll(async () => {
  for (const slug of SLUGS) await resetMerchant(slug)
  for (const d of [DEST, FAR, UNKNOWN]) {
    await svc().from('distance_quotes').delete()
      .eq('origin_place_id', ORIGIN).eq('destination_place_id', d)
  }
})

describe('POST /api/shipping/quote', () => {
  it('returns the routed km and the fee for a cached pair', async () => {
    const res = await post({ merchantId: distanceId, placeId: DEST })
    expect(res.status).toBe(200)
    // The reference pair: 25216 m at 6.00 + 1.00/km.
    expect(await res.json()).toMatchObject({ km: 25.2, fee: 31.2 })
  })

  it('refuses a free-text destination — a place id is the only accepted input', async () => {
    // Free text would let a caller mint unlimited DISTINCT destinations, and every distinct
    // destination is a billable lookup on the platform's own Maps account.
    const res = await post({ merchantId: distanceId, address: '12 Jalan Example, Kuala Lumpur' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
  })

  it('refuses a destination beyond the shop maximum, with the out-of-range reason', async () => {
    const res = await post({ merchantId: distanceId, placeId: FAR })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'out_of_range' })
  })

  it('refuses a quote at a region-priced shop', async () => {
    const res = await post({ merchantId: regionId, placeId: DEST })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_distance_priced' })
  })

  it('404s an unknown shop', async () => {
    const res = await post({ merchantId: '00000000-0000-0000-0000-000000000000', placeId: DEST })
    expect(res.status).toBe(404)
  })

  it('reports a lookup failure as retryable, distinct from out-of-range', async () => {
    // No cache row and no Maps key in the test env, so the adapter reports `failed`.
    const res = await post({ merchantId: distanceId, placeId: UNKNOWN })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'lookup_failed' })
  })
})
```

- [ ] **Step 2: Pin the DB suites away from the network**

The `lookup_failed` case above must be a *decision*, not a real call to Google. Add to
`apps/backend/vitest.db.config.ts`, inside `loadSupabaseEnv()` beside the Stripe stubs:

```ts
  // FORCED EMPTY, not merely defaulted: these suites must never reach Google. A developer with
  // a real key in their shell would otherwise turn the cache-miss cases below into live,
  // billable, flaky network calls. Same argument as the Stripe stubs above — a real credential
  // in a test process is a liability, not an asset — but stronger, because this one spends money
  // per call. Everything distance-related in tests/api is exercised through SEEDED CACHE ROWS.
  process.env.GOOGLE_MAPS_API_KEY = ''
```

Note this is an assignment, not the `if (!process.env[name])` guard the Stripe stubs use: an
already-set key is exactly the case being defended against.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @bitetime/backend test:db -- shippingQuote`
Expected: FAIL — every case 404s (route does not exist).

- [ ] **Step 4: Implement the route in `apps/backend/src/app.ts`**

Add imports near the existing ones:

```ts
import { resolveDistance, liveDistanceDeps } from './distance.js'
import { shopDistance, routedKm, distanceFee, exceedsMaxKm } from '@bitetime/shared'
```

(`shopDistance` etc. join the existing `@bitetime/shared` import line rather than duplicating it.)

Add the limiters beside the signup ones (~line 680):

```ts
// The quote endpoint SPENDS MONEY per cache miss (see docs/adr/0001), so it is bounded twice
// over, and the two bounds guard different things:
//
//   * `quoteIpWindow` bounds REQUESTS by caller IP — cheap flood protection, applied to hits
//     and misses alike.
//   * `quoteMerchantWindow` bounds PROVIDER CALLS per shop per day — the runaway stop. It is
//     checked only when the cache missed, because a cache hit costs nothing and must never eat
//     a shop's ceiling.
//
// Both inherit the in-memory limiter's known weaknesses KNOWINGLY, exactly as customer signup
// does: they reset on redeploy and stop protecting anything past one backend instance. Fixing
// that is its own piece of work (#101 Out of Scope).
const quoteIpWindow = createSlidingWindow({ limit: 60, windowMs: 60 * 60_000, now: () => Date.now() })
const quoteMerchantWindow = createSlidingWindow({ limit: 500, windowMs: 24 * 60 * 60_000, now: () => Date.now() })
const placesIpWindow = createSlidingWindow({ limit: 300, windowMs: 60 * 60_000, now: () => Date.now() })
```

Add a shared IP helper next to them (the signup route inlines this today; lifting it avoids a third copy):

```ts
/** The caller's IP, from the proxy headers with the socket as the local-dev fallback. */
function ipOf(c: { req: { header: (n: string) => string | undefined }; env: unknown }): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return clientIp(
    { 'x-forwarded-for': c.req.header('x-forwarded-for'), 'cf-connecting-ip': c.req.header('cf-connecting-ip') },
    incoming?.socket?.remoteAddress,
  )
}
```

Then the route, placed after `/api/orders/track`:

```ts
// ── Distance delivery quote ───────────────────────────────────────────────────
// Unauthenticated on purpose: a guest checkout must be able to see its delivery fee, and guest
// checkout is a first-class path.
//
// It takes a PLACE ID AND NEVER FREE TEXT. That is not input hygiene — free text would let a
// caller mint unlimited distinct destinations, and every distinct destination is a billable
// lookup on the platform's own Maps account (docs/adr/0001).
//
// A hit on `distance_quotes` is the normal case and costs nothing; the same row is what order
// intake reads a moment later, which is what makes the quote and the charge the same number.
app.post('/api/shipping/quote', async (c) => {
  const body = await c.req.json().catch(() => null)
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.merchantId !== 'string' || !b.merchantId || typeof b.placeId !== 'string' || !b.placeId) {
    return c.json({ error: 'invalid_body' }, 400)
  }

  if (!quoteIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, currency, status, shipping_mode, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id')
    .eq('id', b.merchantId)
    .maybeSingle()
  if (!merchant) return c.json({ error: 'merchant_not_found' }, 404)
  if (merchant.status !== 'active') return c.json({ error: 'merchant_inactive' }, 409)

  // `shopDistance`, not a local read of these columns: the storefront quotes from this exact
  // function and order intake charges from it, and a third reading here is a third rule the
  // customer meets as a `price_changed` refusal.
  const policy = shopDistance(merchant)
  if (policy.mode !== 'distance' || !policy.usable) return c.json({ error: 'not_distance_priced' }, 409)

  // The ceiling is checked against PROVIDER CALLS, so a cache hit is free. Peek at the cache
  // first for exactly that reason.
  const cached = await liveDistanceDeps.readCache(
    policy.originPlaceId!, b.placeId, new Date(Date.now() - CACHE_TTL_MS),
  )
  if (cached === null && !quoteMerchantWindow.allow(merchant.id)) {
    return c.json({ error: 'quota_exceeded' }, 429)
  }

  const outcome = cached !== null
    ? ({ status: 'ok', metres: cached } as const)
    : await resolveDistance(liveDistanceDeps, {
        originPlaceId: policy.originPlaceId!,
        destinationPlaceId: b.placeId,
      })

  // NO ROUTE AND OUT-OF-RANGE ARE THE SAME ANSWER to the customer — "this shop does not deliver
  // there" — because they are the same fact. Only `failed` invites a retry.
  if (outcome.status === 'no_route') return c.json({ error: 'out_of_range' }, 409)
  if (outcome.status === 'failed') return c.json({ error: 'lookup_failed' }, 409)

  const km = routedKm(outcome.metres)
  if (exceedsMaxKm(policy, km)) return c.json({ error: 'out_of_range' }, 409)

  return c.json({ km, fee: distanceFee(policy, km), currency: merchant.currency ?? 'MYR' })
})
```

Add `CACHE_TTL_MS` to the `./distance.js` import.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @bitetime/backend test:db -- shippingQuote`
Expected: PASS — all six cases.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/app.ts apps/backend/tests/api/shippingQuote.test.ts
git commit -m "feat(backend): distance quote endpoint, place-id only and doubly bounded"
```

---

### Task 6: The Places proxy endpoints

**Files:**
- Modify: `apps/backend/src/app.ts` (after the quote route)

**Interfaces:**
- Consumes: `googlePlaceSuggest`, `googlePlaceDetail` (Task 3), `placesIpWindow`, `ipOf` (Task 5).
- Produces: `GET /api/places/suggest?input=&session=` → `{ suggestions: { placeId, text }[] }`; `GET /api/places/detail/:placeId?session=` → `{ placeId, formatted, lat, lng, postcode, city, state }` or `404 { error: 'place_not_found' }`.

- [ ] **Step 1: Implement the two routes**

Add the import:

```ts
import { googlePlaceSuggest, googlePlaceDetail } from './maps.js'
```

and the routes, after `/api/shipping/quote`:

```ts
// ── Address autocomplete proxy ────────────────────────────────────────────────
// Proxied for ONE reason above all: the Maps credential must never reach the browser, where a
// key can be lifted off a page and spent elsewhere (#101, story 49).
//
// `session` is money, not hygiene: a burst of keystrokes carrying one token bills as a single
// lookup when it ends in a details call. The browser mints it and passes the SAME one to
// /api/places/detail.
//
// Unauthenticated, because a guest picking a delivery address has no session. Bounded by IP for
// the same reason the quote endpoint is: these calls cost the platform money.
app.get('/api/places/suggest', async (c) => {
  if (!placesIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)
  const input = c.req.query('input') ?? ''
  const session = c.req.query('session') ?? ''
  // A short prefix is noise that still bills. Empty results, no call.
  if (input.trim().length < 3) return c.json({ suggestions: [] })
  return c.json({ suggestions: await googlePlaceSuggest(input, session) })
})

app.get('/api/places/detail/:placeId', async (c) => {
  if (!placesIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)
  const detail = await googlePlaceDetail(c.req.param('placeId'), c.req.query('session') ?? '')
  if (!detail) return c.json({ error: 'place_not_found' }, 404)
  return c.json(detail)
})
```

- [ ] **Step 2: Verify the shape by hand**

Run (backend dev server must be up: `pnpm --filter @bitetime/backend dev`):
```bash
curl -s 'http://localhost:8787/api/places/suggest?input=ab&session=t1'
```
Expected: `{"suggestions":[]}` (below the 3-character floor, so no billable call is made).

```bash
curl -s 'http://localhost:8787/api/places/suggest?input=Jalan%20Ampang&session=t1'
```
Expected without a `GOOGLE_MAPS_API_KEY`: `{"suggestions":[]}`. With a key: a list of `{placeId, text}`.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/app.ts
git commit -m "feat(backend): proxy Places autocomplete so no Maps key reaches the browser"
```

---

### Task 7: Order intake prices by distance

**Files:**
- Modify: `apps/backend/src/orders.ts`
- Modify: `apps/backend/src/app.ts` (pass the distance deps / place id through)
- Test: `apps/backend/tests/api/orders.test.ts`

**Interfaces:**
- Consumes: `resolveDistance`, `liveDistanceDeps` (Task 4); `shopDistance`, `routedKm` (Task 2).
- Produces: `OrderErrorCode` gains `'delivery_place_required' | 'delivery_out_of_range' | 'distance_lookup_failed'`; `orders` rows carry `delivery_distance_km`, `delivery_base_fee`, `delivery_rate_per_km`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/tests/api/orders.test.ts`. Add `'ord-distance'` to the `SLUGS` array, then:

```ts
describe('distance-priced intake', () => {
  const ORIGIN = 'ChIJord-origin'
  const NEAR = 'ChIJord-near'
  const FAR = 'ChIJord-far'
  let distanceId = ''
  let distanceProductId = ''

  const deliveryBody = (extra: Record<string, unknown> = {}) => ({
    merchantId: distanceId,
    customerName: 'Ah Meng',
    customerWa: '60123456789',
    mode: 'delivery',
    address: { line1: '12 Jalan Test', unit: 'A-3-2', postcode: '50000', city: 'Kuala Lumpur', state: 'Selangor', place_id: NEAR },
    cart: { [distanceProductId]: 2 },
    // 2 x 13 = 26 subtotal, plus 6.00 + 1.00 x 25.2 = 31.20 shipping.
    quotedTotal: 57.2,
    fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()),
    ...extra,
  })

  beforeAll(async () => {
    const owner = await makeUser('ord-distance-owner@test.local')
    distanceId = await seedMerchant({
      slug: 'ord-distance', owner_id: owner.id, order_prefix: 'OD',
      shipping_mode: 'distance', delivery_base_fee: 6, delivery_rate_per_km: 1,
      delivery_max_km: 30, origin_place_id: ORIGIN,
    })
    distanceProductId = await seedProduct({ merchant_id: distanceId, price: 13 })
    for (const [dest, metres] of [[NEAR, 25216], [FAR, 45000]] as const) {
      await svc().from('distance_quotes').upsert({
        origin_place_id: ORIGIN, destination_place_id: dest, metres,
        created_at: new Date().toISOString(),
      })
    }
  })

  it('prices a delivery from the seeded cache row and snapshots the rule on the order', async () => {
    const res = await post(deliveryBody())
    expect(res.status).toBe(200)
    const { orderNumber } = (await res.json()) as { orderNumber: string }
    const rows = await ordersOf(distanceId)
    const order = rows.find(o => o.order_number === orderNumber)!
    expect(Number(order.shipping_fee)).toBe(31.2)
    expect(Number(order.total)).toBe(57.2)
    expect(Number(order.delivery_distance_km)).toBe(25.2)
    expect(Number(order.delivery_base_fee)).toBe(6)
    expect(Number(order.delivery_rate_per_km)).toBe(1)
    // The unit rides along on the address so the rider can complete the drop, and it never
    // touched the fee.
    expect(order.address.unit).toBe('A-3-2')
  })

  it('refuses a delivery whose destination cannot be resolved, and writes nothing', async () => {
    const before = (await ordersOf(distanceId)).length
    const res = await post(deliveryBody({ address: { line1: '12 Jalan Test', postcode: '50000', city: 'KL', state: 'Selangor' } }))
    expect(res.status).toBe(409)
    expect(await errorOf(res)).toBe('delivery_place_required')
    expect((await ordersOf(distanceId)).length).toBe(before)
  })

  it('refuses a destination beyond the shop maximum', async () => {
    const res = await post(deliveryBody({
      address: { line1: 'Far away', postcode: '86000', city: 'Kluang', state: 'Johor', place_id: FAR },
      quotedTotal: 77,
    }))
    expect(res.status).toBe(409)
    expect(await errorOf(res)).toBe('delivery_out_of_range')
  })

  it('rolls the whole transaction back when the derived distance disagrees with the quote', async () => {
    const before = (await ordersOf(distanceId)).length
    const counterBefore = await counterOf(distanceId)
    const res = await post(deliveryBody({ quotedTotal: 40 }))
    expect(res.status).toBe(409)
    expect(await errorOf(res)).toBe('price_changed')
    expect((await ordersOf(distanceId)).length).toBe(before)
    // Not even a counter slot is burnt — the same rollback assertion the voucher cases make.
    expect(await counterOf(distanceId)).toEqual(counterBefore)
  })

  it('leaves the distance columns null on a region-priced shop', async () => {
    const res = await post(body(merchantId, productId, { fulfilDate: todayInZone(DEFAULT_TIMEZONE, new Date()) }))
    expect(res.status).toBe(200)
    const rows = await ordersOf(merchantId)
    expect(rows[rows.length - 1].delivery_distance_km).toBeNull()
    expect(rows[rows.length - 1].delivery_base_fee).toBeNull()
  })
})
```

(`merchantId` / `productId` are the suite's existing region-shop fixtures; keep whatever names the file already uses for them.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bitetime/backend test:db -- orders`
Expected: FAIL — the distance shop prices shipping at the WM region rate, and `delivery_distance_km` does not appear on the row.

- [ ] **Step 3: Implement in `apps/backend/src/orders.ts`**

Add to the imports:

```ts
import { priceOrder, voucherFromRow, shopRates, shopTax, shopDistance, routedKm, exceedsMaxKm, productFromRow, promoClaims, fulfilmentConfig, isDateSelectable, DEFAULT_TIMEZONE } from '@bitetime/shared'
import type { PricedProduct, PricedVoucher, FulfilmentConfig, ShopTax, ShopDistance } from '@bitetime/shared'
import { sql } from './db.js'
import { resolveDistance, liveDistanceDeps, type DistanceDeps } from './distance.js'
```

Extend `OrderErrorCode`:

```ts
  | 'fulfil_date_required'
  /**
   * A distance-priced shop was handed a delivery with no destination place id. The same rule as
   * `delivery_state_required` one policy over: an unresolvable destination is REFUSED, never
   * priced — with no distance, `shippingFee` would fall through to 0 and the shop would drive
   * 40 km for free.
   */
  | 'delivery_place_required'
  /**
   * Beyond the shop's `max_km`, OR no road route exists. ONE code, because to the customer they
   * are the same fact: this shop does not deliver there. Only `distance_lookup_failed` is worth
   * retrying.
   */
  | 'delivery_out_of_range'
  /** The routing lookup itself did not happen. Retryable — and the ONLY distance failure that is. */
  | 'distance_lookup_failed'
```

Add to `PlaceOrderInput`, after `fulfilDate`:

```ts
  /**
   * The destination's stable place identifier, lifted off the address the customer submitted.
   *
   * The DESTINATION is a fact only the customer can supply, so it arrives in the request — but
   * as an identifier, and the DISTANCE is never taken from the body. That is the same shape as
   * the region rule one policy over: the customer declares where the parcel goes, the shop's own
   * rows decide what that costs. A body-supplied distance is the `total: 0` hole with extra steps.
   */
  destinationPlaceId?: string | null
```

Replace `placeOrder`'s signature and opening so the routing happens **before** the transaction:

```ts
export async function placeOrder(
  input: PlaceOrderInput,
  now = new Date(),
  distanceDeps: DistanceDeps = liveDistanceDeps,
): Promise<{ orderNumber: string }> {
  // THE ROUTING CALL HAPPENS HERE, OUTSIDE THE TRANSACTION, and that placement is the whole
  // reason this function is no longer a bare `withTransaction(...)`. Inside, the transaction
  // holds this shop's single `order_counters` row lock; a third party's network round-trip under
  // that lock would serialise every checkout at the shop behind Google's latency.
  //
  // A cache HIT is the normal case — the customer quoted moments ago, and that quote wrote the
  // row. A miss re-resolves. A distance that MOVED in the meantime does not need a new failure
  // path: the derived total disagrees with the quoted total and the existing `price_changed`
  // refusal fires, which the storefront already knows how to recover from.
  const routedMetres = await resolveRoutedMetres(input, distanceDeps, now)

  return withTransaction(async (tx) => {
    ...
```

Add the resolver below `placeOrder`:

```ts
/**
 * The routed distance for this order, or a refusal. `null` for any shop that is not
 * distance-priced and for any pickup — those price by the region rule and never route.
 *
 * Reads the shop's policy on a NON-transactional connection: the authoritative read is still
 * the one inside `assertOrderableMerchant`, and the price is still derived in there. This read
 * exists only to know whether to route at all, and what origin to route from.
 */
async function resolveRoutedMetres(
  input: PlaceOrderInput,
  deps: DistanceDeps,
  now: Date,
): Promise<number | null> {
  if (input.mode !== 'delivery') return null

  const rows = await sql<Record<string, unknown>[]>`
    select shipping_mode, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id
    from merchants where id = ${input.merchantId}
  `
  // A missing shop is the transaction's refusal to make (`merchant_not_found`), not ours.
  if (!rows[0]) return null
  const policy = shopDistance(rows[0])
  if (policy.mode !== 'distance') return null
  // A distance shop that cannot price does not fall back to its dormant region rate — that
  // charges by a formula the merchant switched off. It refuses.
  if (!policy.usable) throw new OrderError('distance_lookup_failed')

  const destination = (input.destinationPlaceId ?? '').trim()
  if (!destination) throw new OrderError('delivery_place_required')

  const outcome = await resolveDistance(
    deps,
    { originPlaceId: policy.originPlaceId!, destinationPlaceId: destination },
    now,
  )
  // No route and beyond-the-maximum are ONE refusal: same fact, same message.
  if (outcome.status === 'no_route') throw new OrderError('delivery_out_of_range')
  if (outcome.status === 'failed') throw new OrderError('distance_lookup_failed')
  if (exceedsMaxKm(policy, routedKm(outcome.metres))) throw new OrderError('delivery_out_of_range')
  return outcome.metres
}
```

Inside the transaction, replace the `delivery_state_required` guard with one that only applies to region shops, and price with the distance. First, extend `OrderableMerchant`:

```ts
interface OrderableMerchant {
  order_prefix: string
  rates: { WM: number; EM: number }
  currency: string
  fulfilment: FulfilmentConfig
  timezone: string
  tax: ShopTax
  distance: ShopDistance
}
```

In `assertOrderableMerchant`, widen the select and the return:

```ts
  const rows = await tx<Record<string, unknown>[]>`
    select order_prefix, status::text, shipping, currency, config, timezone, tax_enabled, tax_rate,
           shipping_mode, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id
    from merchants where id = ${merchantId}
  `
```

and add to the returned object:

```ts
    // shopDistance, for the same reason as shopRates and shopTax above: the storefront quotes
    // from this exact function and the quote endpoint quotes from it, and a disagreement is a
    // REFUSAL, not a rounding gap. postgres.js hands these numerics back as strings.
    distance: shopDistance(merchant),
```

(The row type becomes `Record<string, unknown>[]`; keep the `merchant.status !== 'active'` and `order_prefix` reads, casting them where TypeScript needs it: `merchant.status as string`, `merchant.order_prefix as string`, `(merchant.currency as string | null) ?? 'MYR'`.)

Then in the transaction body, replace the state guard:

```ts
    // A REGION-priced delivery with no state prices at ZERO — `shippingFee` reads the region off
    // the state, and with none it falls through to `return 0`. Refused, never priced.
    //
    // A DISTANCE-priced shop has no such input: its destination was already resolved (or
    // refused) before this transaction opened, and the state is only ever printed on the parcel.
    const distancePriced = merchantRowIsDistance
    if (input.mode === 'delivery' && !distancePriced && deliveryState(input.mode, input.address) === null) {
      throw new OrderError('delivery_state_required')
    }
```

which requires the merchant to be loaded first. Move the `assertOrderableMerchant` call above this guard and write it as:

```ts
    const merchant = await assertOrderableMerchant(tx, input.merchantId)
    const distancePriced = merchant.distance.mode === 'distance'

    if (input.mode === 'delivery' && !distancePriced && deliveryState(input.mode, input.address) === null) {
      throw new OrderError('delivery_state_required')
    }
    // The pre-transaction resolution and the authoritative row disagree only if the merchant
    // flipped their policy mid-checkout. Fail closed rather than price by the wrong rule.
    if (input.mode === 'delivery' && distancePriced && routedMetres === null) {
      throw new OrderError('distance_lookup_failed')
    }
```

Pass the distance into `priceOrder`:

```ts
    const bd = priceOrder({
      products,
      cart: input.cart,
      mode: input.mode,
      state: deliveryState(input.mode, input.address),
      rates: merchant.rates,
      distance: merchant.distance,
      routedMetres,
      voucher,
      tax: merchant.tax,
      now,
    })

    // A pending fee is never committed. Unreachable — the refusals above cover every route to
    // it — and asserted anyway, because the one thing this feature must never do is charge a
    // delivery fee of 0 that nobody chose.
    if (bd.shippingPending) throw new OrderError('distance_lookup_failed')
```

Snapshot the rule onto the row. Above the insert:

```ts
    // The snapshot. `delivery_distance_km` LABELS the receipt line; base/rate exist because
    // `base + rate × km` has two unknowns and one equation, and without them no past order's fee
    // is reconstructable once the merchant edits their rates. Null for a region-priced shop.
    const distanceKm = distancePriced && routedMetres !== null ? routedKm(routedMetres) : null
    const distanceBase = distanceKm === null ? null : merchant.distance.base
    const distanceRate = distanceKm === null ? null : merchant.distance.ratePerKm
```

and extend the insert's column list and values:

```sql
        shipping_fee, items, total, currency, discount, tax, tax_rate, voucher_code, fulfil_date, order_number, status,
        delivery_distance_km, delivery_base_fee, delivery_rate_per_km
```

with, after `'new'`:

```ts
        ,${distanceKm},
        ${distanceBase},
        ${distanceRate}
```

- [ ] **Step 4: Pass the place id through the route**

In `apps/backend/src/app.ts`'s `POST /api/orders` handler, add to the `placeOrder({...})` call, after `fulfilDate`:

```ts
      // Lifted off the ADDRESS, not a sibling body field: it is a property of where the parcel
      // goes, and keeping the two together is what stops an address and a place id from
      // disagreeing. The distance itself is never read from the body — see placeOrder.
      destinationPlaceId: typeof (b.address as Record<string, unknown> | null)?.place_id === 'string'
        ? ((b.address as Record<string, unknown>).place_id as string)
        : null,
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @bitetime/backend test:db -- orders`
Expected: PASS, including every pre-existing region-shop case (those are the regression that matters most).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/orders.ts apps/backend/src/app.ts apps/backend/tests/api/orders.test.ts
git commit -m "feat(orders): price distance deliveries, resolving the route before the transaction"
```

---

### Task 8: The merchant sees the distance

**Files:**
- Modify: `apps/backend/src/notify.ts:37-71`
- Test: `apps/backend/tests/unit/notify.test.ts`

**Interfaces:**
- Consumes: `orders.delivery_distance_km` (Task 1), `address.unit` (Task 7).
- Produces: no new exports; `buildOrderMessage` and `formatAddress` behaviour changes.

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/tests/unit/notify.test.ts`, inside the `buildOrderMessage` describe:

```ts
  it('carries the delivery distance so a rider can be dispatched without opening the dashboard', () => {
    const msg = buildOrderMessage({ ...ORDER, delivery_distance_km: 25.2, shipping_fee: 31.2 }, 'Cookie Corner')
    expect(msg).toContain('*Distance:* 25.2 km')
    expect(msg).toContain('*Shipping:* RM 31.20')
  })

  it('omits the distance line entirely for a region-priced order', () => {
    expect(buildOrderMessage(ORDER, 'Cookie Corner')).not.toContain('Distance')
  })

  it('carries the unit/floor so the rider can complete the drop', () => {
    const msg = buildOrderMessage({
      ...ORDER,
      address: { line1: '12 Jalan Test', unit: 'A-3-2', postcode: '50000', city: 'Kuala Lumpur', state: 'Selangor' },
    })
    expect(msg).toContain('A-3-2')
    expect(msg).toContain('12 Jalan Test')
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bitetime/backend test -- notify`
Expected: FAIL — `expected '…' to contain '*Distance:* 25.2 km'`.

- [ ] **Step 3: Implement**

In `apps/backend/src/notify.ts`, update `formatAddress`:

```ts
export function formatAddress(addr: unknown): string {
  if (!addr) return ''
  if (typeof addr === 'string') return addr
  const a = addr as { line1?: string; unit?: string; postcode?: string; city?: string; state?: string }
  const cityLine = [a.postcode, a.city].filter(Boolean).join(' ')
  // The unit/floor/landmark rides in front of the street line, where a rider reads it first. It
  // is never routed and never moved the fee — it exists so the drop can actually be completed.
  return [a.unit, a.line1, cityLine, a.state].filter(Boolean).join(', ')
}
```

and in `buildOrderMessage`, after the `if (order.address)` line:

```ts
  // Distance-priced orders only; a region-priced order has no distance and must not print an
  // empty label. `delivery_distance_km` is null for every order placed before #101.
  if (order.delivery_distance_km != null) msg += `*Distance:* ${Number(order.delivery_distance_km).toFixed(1)} km\n`
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @bitetime/backend test -- notify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/notify.ts apps/backend/tests/unit/notify.test.ts
git commit -m "feat(notify): put the delivery distance and unit in the Telegram message"
```

---

### Task 9: The merchant can save the policy

**Files:**
- Modify: `apps/backend/src/writes.ts:15-20` and `pickMerchantConfig`
- Test: `apps/backend/tests/api/writes-merchants.test.ts`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces: `MERCHANT_CONFIG_FIELDS` gains `shipping_mode`, `delivery_base_fee`, `delivery_rate_per_km`, `delivery_max_km`, `origin_place_id`, `origin_lat`, `origin_lng`, `origin_address`; `pickMerchantConfig` refuses invalid values with `{ ok: false, error }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/tests/api/writes-merchants.test.ts` (follow the file's existing PATCH helper and fixtures):

```ts
describe('shipping policy fields', () => {
  it('saves a complete distance policy', async () => {
    const res = await patchMerchant(merchantId, ownerToken, {
      shipping_mode: 'distance',
      delivery_base_fee: 6,
      delivery_rate_per_km: 1,
      delivery_max_km: 30,
      origin_place_id: 'ChIJorigin',
      origin_lat: 3.139003,
      origin_lng: 101.686855,
      origin_address: '12 Jalan Example, 50000 Kuala Lumpur',
    })
    expect(res.status).toBe(200)
  })

  it('refuses a negative base fee, rate or maximum — a typo must not make a delivery pay the customer', async () => {
    for (const patch of [{ delivery_base_fee: -1 }, { delivery_rate_per_km: -0.5 }, { delivery_max_km: -3 }]) {
      const res = await patchMerchant(merchantId, ownerToken, patch)
      expect(res.status).toBe(400)
    }
  })

  it('refuses a maximum of zero, which is not "no limit"', async () => {
    const res = await patchMerchant(merchantId, ownerToken, { delivery_max_km: 0 })
    expect(res.status).toBe(400)
  })

  it('accepts a null maximum as "deliver anywhere with a road"', async () => {
    const res = await patchMerchant(merchantId, ownerToken, { delivery_max_km: null })
    expect(res.status).toBe(200)
  })

  it('refuses an unknown shipping mode', async () => {
    const res = await patchMerchant(merchantId, ownerToken, { shipping_mode: 'carrier_pigeon' })
    expect(res.status).toBe(400)
  })

  it('refuses switching to distance mode with no origin set', async () => {
    // Story 5: a merchant must not be able to half-configure their shop into quoting nothing.
    await patchMerchant(merchantId, ownerToken, { origin_place_id: null, shipping_mode: 'region' })
    const res = await patchMerchant(merchantId, ownerToken, { shipping_mode: 'distance' })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bitetime/backend test:db -- writes-merchants`
Expected: FAIL — the fields are silently dropped by the allowlist, so every case 200s.

- [ ] **Step 3: Implement in `apps/backend/src/writes.ts`**

Extend the allowlist:

```ts
const MERCHANT_CONFIG_FIELDS = [
  'currency', 'shipping', 'pickup_address', 'payment_bank', 'payment_note', 'config', 'timezone',
  'tax_enabled', 'tax_rate',
  // Distance pricing (#101). `pickup_address` deliberately stays a SEPARATE, free-text field:
  // it is the merchant's own directions for pickup customers and is never routed, so an
  // autocomplete result must never overwrite it.
  'shipping_mode', 'delivery_base_fee', 'delivery_rate_per_km', 'delivery_max_km',
  'origin_place_id', 'origin_lat', 'origin_lng', 'origin_address',
] as const
```

and add validation inside `pickMerchantConfig`, after the `tax_rate` block:

```ts
  if (out.shipping_mode !== undefined && out.shipping_mode !== 'region' && out.shipping_mode !== 'distance') {
    return { ok: false, error: "shipping_mode must be 'region' or 'distance'" }
  }

  // A negative fee is a delivery that PAYS the customer. Refused at the door, where the merchant
  // is present to see it, rather than as a bare 500 out of the column's own CHECK.
  for (const key of ['delivery_base_fee', 'delivery_rate_per_km'] as const) {
    if (out[key] === undefined) continue
    const n = typeof out[key] === 'string' ? Number(out[key]) : out[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return { ok: false, error: `${key} must be a number of 0 or more` }
    }
    out[key] = n
  }

  // null is the ONLY way to say "no limit". A 0 is an honest "deliver nowhere" and the two must
  // not collide, so 0 is refused rather than quietly read as unlimited.
  if (out.delivery_max_km !== undefined && out.delivery_max_km !== null) {
    const n = typeof out.delivery_max_km === 'string' ? Number(out.delivery_max_km) : out.delivery_max_km
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'delivery_max_km must be a positive number, or null for no limit' }
    }
    out.delivery_max_km = n
  }
```

Then enforce the origin requirement in the route. In `apps/backend/src/app.ts`'s `PATCH /api/merchants/:id`, after the pick succeeds and before the update:

```ts
  // Distance mode REQUIRES an origin, and the check has to see the row's CURRENT origin as well
  // as the patch's: a merchant switching mode in one save and setting their origin in another
  // must not be able to land in a state where the shop quotes nothing. The column's own CHECK
  // constraint is the backstop; this is the one that can say WHY.
  if (patch.shipping_mode === 'distance') {
    const origin = patch.origin_place_id !== undefined
      ? patch.origin_place_id
      : (await admin.from('merchants').select('origin_place_id').eq('id', c.req.param('id')).maybeSingle()).data?.origin_place_id
    if (!origin) {
      return c.json({ error: 'Set your delivery origin before switching on distance pricing' }, 400)
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @bitetime/backend test:db -- writes-merchants`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/writes.ts apps/backend/src/app.ts apps/backend/tests/api/writes-merchants.test.ts
git commit -m "feat(backend): allowlist and validate the distance shipping policy"
```

---

### Task 10: Frontend types and API clients

**Files:**
- Modify: `apps/frontend/src/types.ts:96-121` (`AddressParts`, `Order`), `:20-37` (`Merchant`)
- Modify: `apps/frontend/src/store.ts:540-551` (`OrderErrorCode`) and add the quote client
- Create: `apps/frontend/src/places.ts`
- Modify: `apps/frontend/src/address.ts`

**Interfaces:**
- Consumes: Tasks 5–7's wire contracts.
- Produces:
  - `AddressParts` gains `unit?: string`, `place_id?: string`
  - `Merchant` gains `shipping_mode?: 'region' | 'distance'`, `delivery_base_fee?`, `delivery_rate_per_km?`, `delivery_max_km?`, `origin_place_id?`, `origin_address?`
  - `Order` gains `delivery_distance_km?: number | null`
  - `OrderErrorCode` gains the three new codes
  - `quoteDelivery(merchantId: string, placeId: string): Promise<{ km: number; fee: number }>` throwing `DeliveryQuoteError`
  - `class DeliveryQuoteError extends Error { code: 'out_of_range' | 'lookup_failed' | 'not_distance_priced' | 'rate_limited' | 'network' }`
  - `newPlaceSession(): string`, `suggestPlaces(input, session)`, `placeDetail(placeId, session)`

- [ ] **Step 1: Extend the types**

In `apps/frontend/src/types.ts`, replace `AddressParts`:

```ts
export interface AddressParts {
  line1: string
  postcode: string
  city: string
  state: string
  /**
   * Unit, floor or landmark. Carried on the order and shown to the merchant, and DELIBERATELY
   * never routed: it must not be able to move the fee, so adding delivery instructions can
   * never cost the customer money.
   */
  unit?: string
  /**
   * The selected place's stable identifier — the distance cache key, and the reason free-text
   * resolution was rejected: a re-resolved string can drift between quote and charge. Absent on
   * every address saved before #101 and on every region-priced shop's addresses.
   */
  place_id?: string
}
```

Add to `Merchant`, after `tax_rate`:

```ts
  /** Which shipping policy is live. Absent = region, which is every shop that predates #101. */
  shipping_mode?: 'region' | 'distance'
  /** Read these through `shopDistance`, never directly — they arrive as strings or numbers. */
  delivery_base_fee?: number | string
  delivery_rate_per_km?: number | string
  delivery_max_km?: number | string | null
  origin_place_id?: string | null
  origin_address?: string | null
```

Add to `Order`, after `tax_rate`:

```ts
  /** Routed km this order was charged for. Null for region-priced orders and everything before #101. */
  delivery_distance_km?: number | null
```

- [ ] **Step 2: Extend `formatAddress`**

In `apps/frontend/src/address.ts`:

```ts
export function formatAddress(addr: AddressParts | string | null | undefined): string {
  if (!addr) return ''
  if (typeof addr === 'string') return addr
  const cityLine = [addr.postcode, addr.city].filter(Boolean).join(' ')
  // The unit leads, where a rider reads it first. Never routed — see AddressParts.unit.
  return [addr.unit, addr.line1, cityLine, addr.state].filter(Boolean).join(', ')
}
```

Add a case to `apps/frontend/src/address.test.ts` mirroring the backend twin:

```ts
it('puts the unit in front of the street line', () => {
  expect(formatAddress({ line1: '12 Jalan Test', unit: 'A-3-2', postcode: '50000', city: 'KL', state: 'Selangor' }))
    .toBe('A-3-2, 12 Jalan Test, 50000 KL, Selangor')
})
```

- [ ] **Step 3: Add the new refusal codes and the quote client**

In `apps/frontend/src/store.ts`, extend `OrderErrorCode`:

```ts
  | 'fulfil_date_required'
  | 'delivery_place_required'
  | 'delivery_out_of_range'
  | 'distance_lookup_failed'
```

and add, after `placeOrder`:

```ts
/**
 * Why a delivery could not be quoted. `out_of_range` covers "beyond this shop's maximum" AND
 * "no road route exists" — the same fact to the customer, and the same message. Only
 * `lookup_failed` is worth retrying.
 */
export class DeliveryQuoteError extends Error {
  constructor(readonly code: 'out_of_range' | 'lookup_failed' | 'not_distance_priced' | 'rate_limited' | 'network') {
    super(code)
    this.name = 'DeliveryQuoteError'
  }
}

/**
 * Ask what this delivery costs. Sends a PLACE ID and never a typed address: free text would let
 * a caller mint unlimited billable lookups on the platform's Maps account (docs/adr/0001).
 *
 * The row this writes is the same row order intake reads a moment later, which is what makes the
 * quote and the charge the same number.
 */
export async function quoteDelivery(merchantId: string, placeId: string): Promise<{ km: number; fee: number }> {
  const res = await fetch(`${API_URL}/api/shipping/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId, placeId }),
  }).catch(() => null)
  if (!res) throw new DeliveryQuoteError('network')
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    const code = payload.error
    throw new DeliveryQuoteError(
      code === 'out_of_range' || code === 'not_distance_priced' || code === 'rate_limited' ? code : 'lookup_failed',
    )
  }
  return (await res.json()) as { km: number; fee: number }
}
```

- [ ] **Step 4: Create the places client**

Create `apps/frontend/src/places.ts`:

```ts
// Address autocomplete, through the backend proxy. No Maps key is ever present in this bundle —
// that is the point of the proxy (#101, story 49).
import { API_URL } from './api'

export interface PlaceSuggestion { placeId: string; text: string }

export interface PlaceDetail {
  placeId: string
  formatted: string
  lat: number
  lng: number
  postcode: string
  city: string
  state: string
}

/**
 * A session token groups a burst of keystrokes and the details call that ends them into ONE
 * billable lookup. Mint one when the field is focused, pass the same one to every suggest call
 * AND to the details call, then throw it away — a reused token bills as a second session.
 */
export function newPlaceSession(): string {
  return crypto.randomUUID()
}

/** Never throws: a dead autocomplete degrades to "no suggestions", not a broken checkout. */
export async function suggestPlaces(input: string, session: string): Promise<PlaceSuggestion[]> {
  try {
    const res = await fetch(`${API_URL}/api/places/suggest?input=${encodeURIComponent(input)}&session=${encodeURIComponent(session)}`)
    if (!res.ok) return []
    return ((await res.json()) as { suggestions?: PlaceSuggestion[] }).suggestions ?? []
  } catch {
    return []
  }
}

/** `null` when the place could not be read — the caller must not fabricate an address from it. */
export async function placeDetail(placeId: string, session: string): Promise<PlaceDetail | null> {
  try {
    const res = await fetch(`${API_URL}/api/places/detail/${encodeURIComponent(placeId)}?session=${encodeURIComponent(session)}`)
    if (!res.ok) return null
    return (await res.json()) as PlaceDetail
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Run the frontend tests and typecheck**

Run: `pnpm --filter @bitetime/frontend test && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/types.ts apps/frontend/src/address.ts apps/frontend/src/address.test.ts apps/frontend/src/store.ts apps/frontend/src/places.ts
git commit -m "feat(frontend): distance types, quote client and Places proxy client"
```

---

### Task 11: The address picker

**Files:**
- Create: `apps/frontend/src/store/AddressAutocomplete.tsx`

**Interfaces:**
- Consumes: `suggestPlaces`, `placeDetail`, `newPlaceSession`, `PlaceDetail` (Task 10).
- Produces: `export default function AddressAutocomplete(props: { id: string; label: string; value: string; placeholder?: string; disabled?: boolean; onPick: (detail: PlaceDetail) => void; onTextChange?: (text: string) => void; t: (en: string, zh: string) => string })`

- [ ] **Step 1: Write the component**

Create `apps/frontend/src/store/AddressAutocomplete.tsx`:

```tsx
// One place-picker, used by BOTH sides of distance pricing: the merchant choosing their
// delivery origin in Shop Settings, and the customer choosing their destination at checkout.
//
// One component because the rule is one rule — an address that will be ROUTED must come from a
// selected place, never from typed text. A typed string can be re-resolved differently between
// the quote and the charge, which is precisely the drift the place id exists to remove.
import { useEffect, useRef, useState } from 'react'
import { suggestPlaces, placeDetail, newPlaceSession, type PlaceSuggestion, type PlaceDetail } from '../places'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

interface Props {
  id: string
  label: string
  /** What to show in the box — the caller owns it, so a confirmed pick can display its own text. */
  value: string
  placeholder?: string
  disabled?: boolean
  /** Fired only on a real selection. A keystroke NEVER produces one. */
  onPick: (detail: PlaceDetail) => void
  /** Fired on every keystroke, so the caller can clear a stale confirmed pick. */
  onTextChange?: (text: string) => void
  t: (en: string, zh: string) => string
}

export default function AddressAutocomplete({ id, label, value, placeholder, disabled, onPick, onTextChange, t }: Props) {
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // One token per burst of typing, reset after a pick: it is what makes a burst of keystrokes
  // bill as a single lookup.
  const session = useRef(newPlaceSession())

  useEffect(() => {
    if (!open || value.trim().length < 3) { setSuggestions([]); return }
    // Debounced: every keystroke that reaches the proxy is a request the platform pays for.
    let live = true
    const timer = setTimeout(async () => {
      const hits = await suggestPlaces(value, session.current)
      if (live) setSuggestions(hits)
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [value, open])

  async function pick(s: PlaceSuggestion) {
    setBusy(true)
    // The SAME session token as the suggests — that is what closes the billable session.
    const detail = await placeDetail(s.placeId, session.current)
    setBusy(false)
    setOpen(false)
    setSuggestions([])
    session.current = newPlaceSession()
    // A details call that failed must NOT be turned into an address: the caller would then hold
    // a place the fee cannot be measured to.
    if (detail) onPick(detail)
  }

  return (
    <div className="flex flex-col gap-[6px] relative">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        disabled={disabled || busy}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={e => { setOpen(true); onTextChange?.(e.target.value) }}
        // A blur that closes immediately eats the click on a suggestion.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute top-full left-0 right-0 z-20 mt-1 max-h-[240px] overflow-y-auto rounded-xl border-[1.5px] border-rose-border bg-surface-raised shadow-lg">
          {suggestions.map(s => (
            <li key={s.placeId}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-[14px] text-ink hover:bg-rose-50"
                onMouseDown={e => e.preventDefault()}
                onClick={() => pick(s)}
              >
                {s.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      {busy && <p className="text-[12px] text-rose-muted">{t('Looking up that address…', '正在查询地址…')}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/store/AddressAutocomplete.tsx
git commit -m "feat(frontend): one place picker for the origin and the destination"
```

---

### Task 12: Shop Settings — choosing the policy

**Files:**
- Modify: `apps/frontend/src/merchant/ShopSettings.tsx` (`ShippingTab`, lines 100-287)

**Interfaces:**
- Consumes: `AddressAutocomplete` (Task 11), `shopDistance` (Task 2), `updateMerchantConfig` (existing).
- Produces: no exports; the tab writes `shipping_mode`, `delivery_base_fee`, `delivery_rate_per_km`, `delivery_max_km`, `origin_place_id`, `origin_lat`, `origin_lng`, `origin_address`.

- [ ] **Step 1: Extend the tab's state**

In `ShippingTab`, add to the imports at the top of the file: `shopDistance` from `@bitetime/shared`, and `AddressAutocomplete from '../store/AddressAutocomplete'`.

Replace the `useState<SettingsFields>` initialiser's return object with:

```ts
    const distance = shopDistance(merchant!)
    return {
      currency: merchant!.currency ?? DEFAULT_CURRENCY,
      wm: String(rates.WM),
      em: String(rates.EM),
      pickupAddress: merchant!.pickup_address ?? '',
      taxEnabled: tax.enabled,
      taxRate: tax.rate ? String(tax.rate) : '',
      // shopDistance, not a local read of these columns, for exactly the reason shopRates and
      // shopTax are used above: this form shows the merchant what their shop CHARGES, and the
      // charge is decided by that one function on both sides of the wire.
      shippingMode: distance.mode,
      baseFee: String(distance.base),
      ratePerKm: String(distance.ratePerKm),
      maxKm: distance.maxKm === null ? '' : String(distance.maxKm),
      originPlaceId: merchant!.origin_place_id ?? '',
      originAddress: merchant!.origin_address ?? '',
      originLat: merchant!.origin_lat ?? null,
      originLng: merchant!.origin_lng ?? null,
    }
```

- [ ] **Step 2: Save the policy**

In `ShippingTab`'s `save`, extend the `updateMerchantConfig` payload:

```ts
      await updateMerchantConfig(merchant!.id, {
        ...(currencyLocked ? {} : { currency: fields.currency }),
        shipping,
        pickup_address: (fields.pickupAddress ?? '').trim() || null,
        tax_enabled: fields.taxEnabled,
        tax_rate: Number(fields.taxRate) || 0,
        // The REGION rates above are written on every save, distance mode or not: the dormant
        // policy's configuration is kept so switching back does not mean retyping it (story 10).
        shipping_mode: fields.shippingMode,
        delivery_base_fee: Number(fields.baseFee) || 0,
        delivery_rate_per_km: Number(fields.ratePerKm) || 0,
        // A BLANK maximum is "deliver anywhere with a road" — null, not 0. A typed 0 would be
        // "deliver nowhere", and the backend refuses it rather than guessing which was meant.
        delivery_max_km: fields.maxKm.trim() === '' ? null : Number(fields.maxKm),
        origin_place_id: fields.originPlaceId || null,
        origin_lat: fields.originLat,
        origin_lng: fields.originLng,
        origin_address: fields.originAddress || null,
      })
```

- [ ] **Step 3: Render the policy chooser**

Replace the `Shipping rates` card's contents with a policy switch and the two configurations. Insert before the existing rates card:

```tsx
      <div className={CARD}>
        <h3 className={HEADING}>{t('How you charge for delivery', '运费计算方式')}</h3>
        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-[14px] text-ink">
            <input type="radio" name="shipping-mode" className="mt-1"
              checked={fields.shippingMode === 'region'}
              onChange={() => setFields(f => ({ ...f, shippingMode: 'region' }))} />
            <span>
              {t('By region — one flat rate for West Malaysia, one for East Malaysia.',
                 '按区域 — 西马一个统一运费，东马一个。')}
            </span>
          </label>
          <label className="flex items-start gap-2 text-[14px] text-ink">
            <input type="radio" name="shipping-mode" className="mt-1"
              checked={fields.shippingMode === 'distance'}
              disabled={!fields.originPlaceId}
              onChange={() => setFields(f => ({ ...f, shippingMode: 'distance' }))} />
            <span>
              {t('By distance — a base fee plus a rate for every kilometre your rider drives.',
                 '按距离 — 基本运费加上每公里费率。')}
            </span>
          </label>
          {!fields.originPlaceId && (
            /* Says WHY the option is disabled. Without an origin there is nowhere to measure
               from, and a shop that switched over anyway would quote nothing at all. */
            <p className="text-[12px] text-rose-muted leading-[1.5]">
              {t('Set your delivery origin below before you can charge by distance.',
                 '请先在下方设置配送起点，才能按距离收费。')}
            </p>
          )}
        </div>
      </div>

      <div className={CARD}>
        <h3 className={HEADING}>{t('Delivery origin', '配送起点')}</h3>
        <AddressAutocomplete
          id="shop-origin"
          t={t}
          label={t('Where your rider starts from', '骑手出发的地址')}
          value={fields.originAddress}
          placeholder={t('Start typing your shop address…', '输入店铺地址…')}
          onTextChange={text => setFields(f => ({ ...f, originAddress: text, originPlaceId: '', shippingMode: 'region' }))}
          onPick={d => setFields(f => ({
            ...f,
            originPlaceId: d.placeId,
            originAddress: d.formatted,
            originLat: d.lat,
            originLng: d.lng,
          }))}
        />
        {fields.originPlaceId && (
          /* Show back what was MATCHED, not what was typed: it is the only way a merchant can
             tell the pin landed on the wrong shoplot (story 4). */
          <p className="text-[12px] text-rose-muted mt-2 leading-[1.5]">
            {t('Routes are measured from: ', '距离从此地址起算：')}<strong>{fields.originAddress}</strong>
          </p>
        )}
        <p className="text-[12px] text-rose-muted mt-2 leading-[1.5]">
          {t('This is separate from your pickup address below, which is free text and is only shown to pickup customers.',
             '此地址与下方的自取地址不同 — 自取地址是纯文字，仅显示给自取顾客。')}
        </p>
      </div>
```

and gate the two configuration cards:

```tsx
      {fields.shippingMode === 'region' ? (
        /* the EXISTING "Shipping rates" card, unchanged */
      ) : (
        <div className={CARD}>
          <h3 className={HEADING}>{t('Distance rates', '距离费率')}</h3>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="shop-base-fee">{t(`Base fee (${symbol})`, `基本运费 (${symbol})`)}</Label>
              <Input id="shop-base-fee" type="number" step="0.01" min="0" value={fields.baseFee}
                onChange={e => setFields(f => ({ ...f, baseFee: e.target.value }))} variant="compact" />
              <p className="text-[12px] text-rose-muted leading-[1.5]">
                {t('Charged on every delivery, before distance. Enter 0 to charge purely per kilometre.',
                   '每单固定收取，与距离无关。填 0 则纯按公里收费。')}
              </p>
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="shop-rate-km">{t(`Per kilometre (${symbol})`, `每公里 (${symbol})`)}</Label>
              <Input id="shop-rate-km" type="number" step="0.01" min="0" value={fields.ratePerKm}
                onChange={e => setFields(f => ({ ...f, ratePerKm: e.target.value }))} variant="compact" />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="shop-max-km">{t('Maximum distance (km)', '最远配送距离 (公里)')}</Label>
              <Input id="shop-max-km" type="number" step="0.1" min="0" value={fields.maxKm}
                onChange={e => setFields(f => ({ ...f, maxKm: e.target.value }))} variant="compact" />
              {/* Says what a blank field DOES, the same reason the East-Malaysia hint does. */}
              <p className="text-[12px] text-rose-muted leading-[1.5]">
                {t('Leave blank to deliver anywhere with a road. Customers past this distance are told you do not deliver to them.',
                   '留空表示只要有路就送。超过此距离的顾客会被告知不在配送范围。')}
              </p>
            </div>
            <p className="text-[12px] text-rose-muted leading-[1.5]">
              {t(`Example: ${symbol}${fields.baseFee || 0} + ${symbol}${fields.ratePerKm || 0}/km means a 10 km delivery costs ${symbol}${(Number(fields.baseFee || 0) + Number(fields.ratePerKm || 0) * 10).toFixed(2)}.`,
                 `例如：${symbol}${fields.baseFee || 0} + ${symbol}${fields.ratePerKm || 0}/公里，10 公里配送为 ${symbol}${(Number(fields.baseFee || 0) + Number(fields.ratePerKm || 0) * 10).toFixed(2)}。`)}
            </p>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Verify by running the app**

Run: `pnpm dev`, sign in as a merchant, open Shop Settings → Shipping.
Expected: the distance radio is disabled until an origin is picked; picking one from the dropdown shows the matched address back; saving with base `6`, rate `1`, max `30` persists and survives a reload; switching back to region shows the WM/EM rates still filled in.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/ShopSettings.tsx
git commit -m "feat(settings): choose a shipping policy and set a delivery origin"
```

---

### Task 13: The storefront quotes by distance

**Files:**
- Modify: `apps/frontend/src/store/Storefront.tsx`

**Interfaces:**
- Consumes: `shopDistance` (Task 2), `quoteDelivery`/`DeliveryQuoteError` (Task 10), `AddressAutocomplete` (Task 11).
- Produces: no exports.

- [ ] **Step 1: Wire the policy and the quote state**

Add to the imports: `shopDistance` on the `@bitetime/shared` line, `quoteDelivery, DeliveryQuoteError` on the `../store` line, `AddressAutocomplete from './AddressAutocomplete'`.

After the `const tax = shopTax(merchant)` line:

```tsx
  // The SAME mapper the order transaction charges with — a second reading of these columns here
  // is a second rule, and the customer meets it as a refused checkout.
  const distance = shopDistance(merchant)
  const distancePriced = distance.mode === 'distance' && distance.usable

  // The quote for the address currently selected. `null` means "not calculated" — which is a
  // state the UI must SAY, never a 0 it can show as a fee.
  const [quote, setQuote] = useState<{ placeId: string; km: number; fee: number } | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoting, setQuoting] = useState(false)

  // A saved address that predates #101 has no place id and cannot be routed. It still PREFILLS,
  // and the fee simply stays uncalculated until the customer picks it from the list once — the
  // identifier is then saved back with the order, so this costs each customer once, ever.
  // Silently geocoding an old string into a fee they never confirmed was rejected.
  const routedPlaceId = address.place_id ?? ''
  const quotedForThisAddress = quote !== null && quote.placeId === routedPlaceId && routedPlaceId !== ''
```

- [ ] **Step 2: Quote when a place is picked**

Add below `patchAddress`:

```tsx
  // Fires on a SELECTION, never on a keystroke: every quote is a request the platform pays for,
  // and a free-text address cannot be routed anyway.
  async function pickDestination(detail: { placeId: string; formatted: string; postcode: string; city: string; state: string }) {
    patchAddress({
      line1: detail.formatted,
      postcode: detail.postcode,
      city: detail.city,
      state: detail.state,
      place_id: detail.placeId,
    })
    if (!distancePriced) return
    setQuoting(true)
    setQuoteError(null)
    try {
      const q = await quoteDelivery(merchant.id, detail.placeId)
      setQuote({ placeId: detail.placeId, ...q })
    } catch (err) {
      setQuote(null)
      const code = err instanceof DeliveryQuoteError ? err.code : 'lookup_failed'
      setQuoteError(
        // Out-of-range and no-route are ONE message because they are one fact. Only a lookup
        // failure invites a retry, and pickup is offered either way so the shop does not lose
        // the order over a fee it could not calculate.
        code === 'out_of_range'
          ? t('Sorry, this shop does not deliver to that address. You can still choose pickup.',
              '抱歉，本店不配送到该地址。您仍可选择自取。')
          : code === 'rate_limited'
            ? t('Too many address lookups just now. Please wait a moment and try again.',
                '地址查询过于频繁，请稍候再试。')
            : t('We could not work out the delivery fee just now. Please try again, or choose pickup.',
                '暂时无法计算运费，请重试或选择自取。'),
      )
    } finally {
      setQuoting(false)
    }
  }
```

- [ ] **Step 3: Feed the price and the gate**

In the `priceOrder({...})` call, replace the `resolvedShipping` line and add the distance inputs:

```tsx
    // The region placeholder is for REGION shops only. A distance shop shows no fee at all until
    // one is calculated: an estimate the customer might mistake for their fee is the invented
    // number this feature exists to never produce.
    resolvedShipping: !distancePriced && mode === 'delivery' && !address.state ? baseDeliveryFee : undefined,
    distance,
    routedMetres: quotedForThisAddress ? quote!.km * 1000 : null,
```

Note the km round-trip: `quote.km` is already the rounded km the backend derived, so `km × 1000` re-enters `routedKm` unchanged (`routedKm(25200) === 25.2`) and reproduces the same fee. Add that as a comment on the line.

Replace `deliveryReady` with:

```tsx
  const deliveryReady =
    mode !== 'delivery' ||
    (distancePriced
      // At a distance shop the address must have been SELECTED (so it has a place id) and a fee
      // must have come back. This gate is load-bearing for the PRICE, not just form validity:
      // it is the only thing stopping an order the shop would have to cancel (story 38).
      ? quotedForThisAddress && address.line1.trim() !== ''
      : address.line1.trim() !== '' &&
        address.postcode.length === 5 &&
        address.city.trim() !== '' &&
        address.state.trim() !== '')
```

- [ ] **Step 4: Render the distance-mode address form and fee line**

In the delivery block, render the picker instead of the free-text `line1` + postcode lookup when `distancePriced` (the region form stays EXACTLY as it is — story 23):

```tsx
                {distancePriced ? (
                  <>
                    <AddressAutocomplete
                      id="sf-address"
                      t={t}
                      label={t('Delivery address', '配送地址')}
                      value={address.line1}
                      placeholder={t('Start typing your address…', '输入您的地址…')}
                      onTextChange={text => { patchAddress({ line1: text, place_id: undefined }); setQuote(null); setQuoteError(null) }}
                      onPick={pickDestination}
                    />
                    <div className="flex flex-col gap-[6px]">
                      <Label htmlFor="sf-unit">{t('Unit / floor / landmark (optional)', '单位 / 楼层 / 地标（选填）')}</Label>
                      <Input id="sf-unit" value={address.unit ?? ''}
                        onChange={e => patchAddress({ unit: e.target.value })}
                        placeholder={t('e.g. A-3-2, next to the surau', '例如：A-3-2，祈祷室旁')} />
                      {/* Says it plainly, because the customer's worry is that it will cost them
                          money: it is passed to the rider and never routed (story 21). */}
                      <p className="text-[12px] text-rose-muted leading-[1.5]">
                        {t('Passed to the rider. It does not change your delivery fee.',
                           '仅提供给骑手，不影响运费。')}
                      </p>
                    </div>
                    {quoting && <p className="text-[13px] text-rose-muted">{t('Calculating delivery fee…', '正在计算运费…')}</p>}
                    {quoteError && <p className="text-[13px] text-oxblood">{quoteError}</p>}
                  </>
                ) : (
                  /* the EXISTING region address fields — line1, postcode, city, state — unchanged */
                )}
```

For the fee line in the summary, replace the shipping row's label/amount with:

```tsx
                {/* The distance LABELS the line, and the two reconcile on a calculator: the km
                    shown is the km the fee was derived from. */}
                <MoneyLine
                  label={
                    bd.shippingPending
                      ? t('Delivery Fee (not calculated yet)', '运费（尚未计算）')
                      : quotedForThisAddress
                        ? t(`Delivery Fee (${quote!.km.toFixed(1)} km)`, `运费（${quote!.km.toFixed(1)} 公里）`)
                        : t('Delivery Fee', '运费')
                  }
                  value={bd.shippingPending ? t('—', '—') : formatMoney(fee, currency)}
                />
```

and, when `bd.shippingPending`, show under the total:

```tsx
                {bd.shippingPending && (
                  <p className="text-[12px] text-rose-muted leading-[1.5]">
                    {t('This total does not include delivery yet. Pick your address to see the fee.',
                       '此金额尚未包含运费。请选择地址以查看运费。')}
                  </p>
                )}
```

Change the Delivery toggle's label so the rule is stated before any typing (story 14):

```tsx
              {distancePriced
                ? t(`Delivery — ${formatMoney(distance.base, currency)} + ${formatMoney(distance.ratePerKm, currency)}/km`,
                     `配送 — ${formatMoney(distance.base, currency)} + ${formatMoney(distance.ratePerKm, currency)}/公里`)
                : t(`Delivery — ${formatMoney(baseDeliveryFee, currency)}`, `配送 — ${formatMoney(baseDeliveryFee, currency)}`)}
```

- [ ] **Step 5: Handle the new refusal codes**

In `handleSubmit`'s catch block, beside the existing `delivery_state_required` branch:

```tsx
      } else if (code === 'delivery_out_of_range') {
        setError(t('Sorry, this shop does not deliver to that address. Please choose pickup instead.',
                   '抱歉，本店不配送到该地址，请改选自取。'))
      } else if (code === 'distance_lookup_failed') {
        setError(t('We could not work out the delivery fee just now. Please try again in a moment.',
                   '暂时无法计算运费，请稍后再试。'))
      } else if (code === 'delivery_place_required') {
        // Unreachable from this form — `deliveryReady` will not let an unselected address be
        // submitted — and messaged anyway, because the alternative is the customer reading the
        // literal string `delivery_place_required` on the checkout screen.
        setError(t('Please pick your delivery address from the suggestions.',
                   '请从建议列表中选择您的配送地址。'))
```

Also drop the stale quote when the address is edited after a `price_changed` retry: in the existing `price_changed` branch, add `setQuote(null)` so the customer re-picks and re-quotes rather than resubmitting a distance that moved.

- [ ] **Step 6: Save the place id back**

`savedDetailsFromOrder` already stores the whole `AddressParts`, so `place_id` and `unit` ride along with no change — verify by reading `apps/frontend/src/savedDetails.ts`'s `isCompleteAddress` (it checks four required parts and ignores the optional two, which is correct). No edit needed; confirm and move on.

- [ ] **Step 7: Verify by running the app**

Run: `pnpm dev`. Walk deliberately, per the spec's run-and-verify list:
1. A **region-priced** shop's storefront — the address form and fee must look exactly as today.
2. A distance shop: the Delivery toggle reads `RM 6.00 + RM 1.00/km` before any address.
3. Before an address: the summary says the fee is not calculated, and Place Order is disabled.
4. Pick an address: `Delivery Fee (25.2 km) — RM 31.20` appears, and 6 + 25.2 reconciles.
5. Type in the unit field: the fee does not move.
6. An address beyond `max_km`: the out-of-range message, pickup still offered.
7. Switch to pickup mid-flow: the fee disappears and the order can be placed.
8. As a signed-in returning customer: the saved address prefills, the fee stays uncalculated until it is picked from the list once, and after that order the next checkout quotes immediately.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/store/Storefront.tsx
git commit -m "feat(storefront): quote delivery by distance, and refuse rather than invent a fee"
```

---

### Task 14: The distance on the record, and the docs

**Files:**
- Modify: `apps/frontend/src/store/ReceiptDialog.tsx`
- Modify: `apps/frontend/src/merchant/OrdersView.tsx`
- Modify: `apps/frontend/src/receipt.ts` (if it owns the fee line's label — check first)
- Modify: `CLAUDE.md`
- Modify: `CONTEXT.md` (only if a term drifted from what was built)

**Interfaces:**
- Consumes: `Order.delivery_distance_km` (Task 10).
- Produces: no exports.

- [ ] **Step 1: Label the fee line on the receipt and in the dashboard**

In `apps/frontend/src/store/ReceiptDialog.tsx` and `apps/frontend/src/merchant/OrdersView.tsx`, wherever the shipping fee row is rendered, replace its label with:

```tsx
  order.delivery_distance_km != null
    ? t(`Delivery Fee (${Number(order.delivery_distance_km).toFixed(1)} km)`,
        `运费（${Number(order.delivery_distance_km).toFixed(1)} 公里）`)
    : t('Delivery Fee', '运费')
```

Null (every region-priced order, and every order placed before this shipped) prints the plain label — never `0.0 km`.

- [ ] **Step 2: Correct the stale CLAUDE.md claim**

In `CLAUDE.md`, the *Shipping / pricing* section already names `packages/shared/src/pricing.ts` — verify with:

```bash
grep -n "pricing.ts" CLAUDE.md
```

If any line still locates the pricing module under the frontend workspace, correct it to `packages/shared/src/pricing.ts`. Then add to that section:

```markdown
A shop's **shipping policy** is `merchants.shipping_mode` (`region` | `distance`). Distance pricing is `base + rate × routed km`, with the km rounded to one decimal **before** the rate multiplies it; the road distance comes from `distance_quotes`, a 30-day cache keyed by `(origin place id, destination place id)` that the quote endpoint writes and order intake reads. The routing call happens **outside** the order transaction. See `CONTEXT.md → Shipping policy` and `docs/adr/0001-distance-fees-from-a-cached-google-route.md`.
```

Add the new env var to the Commands/Backend notes:

```markdown
`GOOGLE_MAPS_API_KEY` is optional: unset, distance lookups fail closed (a refusal, never a fee) and region-priced shops are unaffected.
```

- [ ] **Step 3: Run everything**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

Run: `pnpm --filter @bitetime/backend test:db`
Expected: all green, including `tests/rls` (tenant isolation must be untouched).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/store/ReceiptDialog.tsx apps/frontend/src/merchant/OrdersView.tsx CLAUDE.md
git commit -m "feat(receipt): name the distance on the fee line, and refresh the docs"
```

---

## Self-Review Notes

**Spec coverage.** Stories 1–13 (merchant config) → Tasks 9, 12; 14–23 (customer, pre-address and address) → Task 13, with 20–21 (unit field) also in Tasks 7, 8, 10; 24–27 (returning customer, guest) → Task 13 Step 1's `routedPlaceId` rule; 28–32 (the fee itself) → Tasks 2, 7, 14; 33–38 (failures) → Tasks 4, 5, 7, 13; 39–40 (price_changed) → Task 7; 41–44 (merchant receiving) → Tasks 1, 7, 8; 45–51 (platform) → Tasks 1, 3, 4, 5, 6.

**Known deferrals inside this plan.** The per-merchant daily ceiling is an in-memory sliding window, not a table — the same instrument, and the same knowingly-inherited weaknesses, as customer signup (spec: "Fixing the in-memory rate limiter's multi-instance weakness" is Out of Scope). If a durable ceiling is wanted, that is a follow-up issue, not a change to this plan.

**The one number to check first if anything looks wrong:** base `6.00`, rate `1.00`/km, `25216` m → `25.2 km` → `31.20`. It is asserted in Task 2's unit tests, Task 5's endpoint test and Task 7's intake test. If those three disagree, the rounding order is the bug.
