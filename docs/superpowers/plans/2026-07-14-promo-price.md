# Promo Price Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merchant can set a promo price with an optional end date and an optional quantity cap, and the cap actually binds — enforced inside the order transaction, under a row lock.

**Architecture:** Four promo columns on `products`; the promo rule lives in `@bitetime/shared`'s `priceOrder` and runs on **both** sides of the wire; the cap is a counter incremented under `select … for update` inside `placeOrder`'s transaction; the browser prices against the **server's clock**, published by a new `GET /api/time`.

**Tech Stack:** Postgres (Supabase migrations), TypeScript, Hono, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-14-promo-price-design.md`

## Global Constraints

- **A promo exists iff `promo_price is not null`** — never `> 0` / truthiness. `promo_price: 0` (a free item) is a valid, active promo. Truthiness silently drops it.
- **`promo_end` is a `timestamptz` — an absolute instant.** Never `new Date(str + 'T23:59:59')`; that parses as local time and puts a UTC server eight hours away from a UTC+8 customer.
- **The browser never prices a promo against its own clock.** Every `priceOrder` call in the Storefront gets the server-synced time.
- **`promo_sold` is not writable from the browser.** A DB trigger pins it for the `authenticated`/`anon` roles. Only the backend's owner connection, under the row lock, moves it.
- **The cap binds per unit.** A cart of 10 with 3 promo units left is 3 promo lines + 7 base lines — two `PriceLine`s for one product id.
- **Two lines can share a product id.** Any React list rendering `bd.lines` / `cartItems` must key by **index**, not by `item.id`.
- **postgres.js returns `numeric` as a STRING** (`'8.00'`); PostgREST returns it as a number. Both sides map rows through `productFromRow` or they price differently and every promo checkout is refused.
- Localisation: every customer- or merchant-facing string is `t(english, chinese)`.
- Backend relative imports keep `.js` specifiers (NodeNext). Frontend is extensionless (bundler).
- DB-backed tests use real Postgres and are **never** mocked.
- After any backend source edit, the dev server on :8787 must be killed and restarted — `--watch` has silently served stale code twice on this project.

---

### Task 1: The schema — promo columns and the counter's guard

**Files:**
- Create: `apps/backend/supabase/migrations/20260714200000_product_promo.sql`
- Test: `apps/backend/tests/rls/promo.test.ts` (create)

**Interfaces:**
- Produces: `products.promo_price` (numeric, null = no promo), `products.promo_limit` (int, null = uncapped), `products.promo_end` (timestamptz, null = no end date), `products.promo_sold` (int not null default 0).

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260714200000_product_promo.sql`:

```sql
-- A promo price on a product, with an optional end date and an optional quantity cap.
--
-- promo_end is a timestamptz — an ABSOLUTE INSTANT, never a local date. The pricing rule runs on
-- BOTH sides of the wire (the browser quotes, the backend charges, and a disagreement is refused
-- outright), and `new Date('2026-07-20' + 'T23:59:59')` parses as LOCAL time: a UTC server and a
-- UTC+8 customer would resolve one stored string to instants eight hours apart, and refuse every
-- promo checkout on the promo's last day. See #69.

alter table public.products
  add column promo_price numeric,      -- null = no promo. 0 is a VALID promo (a free item).
  add column promo_limit int,          -- null = uncapped
  add column promo_end   timestamptz,  -- null = no end date
  add column promo_sold  int not null default 0;

alter table public.products
  add constraint products_promo_price_nonneg
    check (promo_price is null or promo_price >= 0),
  -- A "promo" above the base price is not a promo. The dashboard checks this too; the dashboard
  -- is not the only thing that can write this row.
  add constraint products_promo_below_price
    check (promo_price is null or promo_price < price),
  add constraint products_promo_limit_positive
    check (promo_limit is null or promo_limit > 0);

create or replace function public.products_promo_sold_guard() returns trigger
language plpgsql as $$
begin
  -- A counter the client can write is not a counter — the same rule that governs orders.user_id
  -- and the voucher's one-per-customer key.
  --
  -- The dashboard upserts the WHOLE product row. A merchant editing a product's NAME while a
  -- customer is checking out would write back a promo_sold it read before the sale, silently
  -- rewinding the cap. The browser's roles cannot move this column at all; only the backend's
  -- owner connection, holding the row lock, can. Pinned silently rather than raised: this is a
  -- backstop against a race, not a dashboard bug to report.
  if current_user in ('authenticated', 'anon') then
    new.promo_sold := coalesce(old.promo_sold, 0);
  end if;

  -- A new promo PRICE is a new promo, and its cap starts empty. Raising the cap of a RUNNING
  -- promo does not reset it: 10 sold against a cap of 10, cap raised to 20, means ten more units
  -- — not twenty. The number the merchant types is the number that sells, ever.
  if tg_op = 'UPDATE' and new.promo_price is distinct from old.promo_price then
    new.promo_sold := 0;
  end if;

  return new;
end $$;

drop trigger if exists products_promo_sold_guard on public.products;
create trigger products_promo_sold_guard
  before insert or update on public.products
  for each row execute function public.products_promo_sold_guard();

-- Without this, PostgREST 404s on the new columns until it restarts.
notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply it**

```bash
pnpm --filter @bitetime/backend db:migrate
```

Expected: the migration applies with no error. Confirm the columns exist:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:55322/postgres" -c "\d public.products"
```

Expected: `promo_price`, `promo_limit`, `promo_end`, `promo_sold` listed, and the trigger `products_promo_sold_guard` under "Triggers:".

- [ ] **Step 3: Write the RLS test for the counter's guard**

Read an existing suite in `apps/backend/tests/rls/` first and follow its setup helpers (how it builds a merchant-scoped `authenticated` client, how it seeds a merchant + product). Create `apps/backend/tests/rls/promo.test.ts` with three cases:

```ts
// The merchant owns the promo. They do NOT own the count of what it has sold.
it('a merchant cannot move promo_sold on their own product', async () => {
  // seed: a product of this merchant with promo_price 5, promo_limit 10, promo_sold 4
  //       (seed promo_sold via the SERVICE-ROLE / owner client, which the guard does not pin)
  await merchantClient.from('products').update({ promo_sold: 0 }).eq('id', productId)
  const { data } = await adminClient.from('products').select('promo_sold').eq('id', productId).single()
  expect(data!.promo_sold).toBe(4)   // pinned, not zeroed
})

it('changing the promo PRICE resets the count', async () => {
  await merchantClient.from('products').update({ promo_price: 6 }).eq('id', productId)
  const { data } = await adminClient.from('products').select('promo_sold').eq('id', productId).single()
  expect(data!.promo_sold).toBe(0)
})

it('raising the CAP does not reset the count', async () => {
  await merchantClient.from('products').update({ promo_limit: 20 }).eq('id', productId)
  const { data } = await adminClient.from('products').select('promo_sold').eq('id', productId).single()
  expect(data!.promo_sold).toBe(4)   // ten more units, not twenty
})
```

Each test needs its own freshly seeded product (they mutate it). Assert through the **admin** client, never the merchant one — the assertion must read what is *stored*.

- [ ] **Step 4: Run it**

```bash
pnpm --filter @bitetime/backend test:db
```

Expected: the three new cases pass, and every pre-existing suite still passes.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/supabase/migrations apps/backend/tests/rls
git commit -m "feat(products): a promo price, a cap, and a counter the browser cannot write"
```

---

### Task 2: The promo rule in `@bitetime/shared`

**Files:**
- Modify: `packages/shared/src/pricing.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/pricing.test.ts:110-140` (the existing promo tests use the dead shape and must be rewritten)

**Interfaces:**
- Consumes: the column names from Task 1.
- Produces:
  - `PricedProduct` with `promoPrice?: number | null`, `promoLimit?: number | null`, `promoEnd?: string | null`, `promoSold?: number`
  - `productFromRow(row: Record<string, unknown>): PricedProduct`
  - `promoState(p: PricedProduct, now: Date): { price: number; remaining: number } | null`
  - `promoClaims(bd: PriceBreakdown): Record<string, number>`
  - `priceOrder` splitting a capped line
  - **Deleted:** `effectivePrice`, `PriceInput.promoSold`

- [ ] **Step 1: Write the failing tests**

Replace the three promo cases at `packages/shared/src/pricing.test.ts:110-140` with these. (Read the file's existing `product()` helper first and reuse it.)

```ts
const FUTURE = '2027-01-01T00:00:00.000Z'
const PAST = '2020-01-01T00:00:00.000Z'

describe('promo', () => {
  it('prices at the promo price while the promo runs', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoEnd: FUTURE })],
      cart: { a: 2 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines).toEqual([
      { id: 'a', name: 'a', qty: 2, unitPrice: 80, lineTotal: 160, promo: true },
    ])
    expect(bd.subtotal).toBe(160)
  })

  it('a promo with no cap and no end date runs anyway', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 80 })],
      cart: { a: 1 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines[0].unitPrice).toBe(80)
    expect(bd.lines[0].promo).toBe(true)
  })

  it('a promo price of 0 is a promo, not a falsy nothing', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 0 })],
      cart: { a: 3 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines[0].unitPrice).toBe(0)
    expect(bd.lines[0].promo).toBe(true)
    expect(bd.subtotal).toBe(0)
  })

  it('an elapsed promo does not apply', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoEnd: PAST })],
      cart: { a: 1 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines[0].unitPrice).toBe(100)
    expect(bd.lines[0].promo).toBe(false)
  })

  // THE CAP. A cart of 10 against 3 remaining units is 3 promo + 7 base — not 10 of either.
  it('splits the line at the cap', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoLimit: 5, promoSold: 2 })],
      cart: { a: 10 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines).toEqual([
      { id: 'a', name: 'a', qty: 3, unitPrice: 80, lineTotal: 240, promo: true },
      { id: 'a', name: 'a', qty: 7, unitPrice: 100, lineTotal: 700, promo: false },
    ])
    expect(bd.subtotal).toBe(940)
    expect(promoClaims(bd)).toEqual({ a: 3 })
  })

  it('a sold-out cap prices the whole line at base, and claims nothing', () => {
    const bd = priceOrder({
      products: [product('a', 100, { promoPrice: 80, promoLimit: 5, promoSold: 5 })],
      cart: { a: 2 }, mode: 'pickup', rates: { WM: 8, EM: 18 },
    })
    expect(bd.lines).toEqual([
      { id: 'a', name: 'a', qty: 2, unitPrice: 100, lineTotal: 200, promo: false },
    ])
    expect(promoClaims(bd)).toEqual({})
  })
})

describe('productFromRow', () => {
  // postgres.js hands back `numeric` as a STRING. Unmapped, '80.00' reaches round2's .toFixed()
  // and throws — and the two sides of the wire price differently, which is a refused checkout.
  it('coerces postgres.js numerics and maps the promo columns', () => {
    const p = productFromRow({
      id: 'a', name: 'Nasi', price: '100.00',
      promo_price: '80.00', promo_limit: 5, promo_sold: 2,
      promo_end: '2027-01-01T00:00:00.000Z',
    })
    expect(p.price).toBe(100)
    expect(p.promoPrice).toBe(80)
    expect(p.promoLimit).toBe(5)
    expect(p.promoSold).toBe(2)
    expect(p.promoEnd).toBe('2027-01-01T00:00:00.000Z')
  })

  it('a row with no promo maps to no promo, and 0 survives', () => {
    expect(productFromRow({ id: 'a', name: 'a', price: 10, promo_price: null }).promoPrice).toBeNull()
    expect(productFromRow({ id: 'a', name: 'a', price: 10, promo_price: '0' }).promoPrice).toBe(0)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @bitetime/shared test
```

Expected: FAIL — `promoClaims` / `productFromRow` are not exported.

- [ ] **Step 3: Implement**

In `packages/shared/src/pricing.ts`:

Rename the private `rate` helper to `num` (it already does the right thing: `null`/`undefined`/`''`/non-finite → `null`, and `0` → `0`) and keep `shopRates` calling it.

Replace the `PricedProduct` interface and its comment:

```ts
/**
 * Only the fields the pricing rule reads. Declared here rather than imported because this package
 * is the boundary between the two workspaces: a frontend `Product` row and a backend `products`
 * row must both satisfy it, and neither owns it.
 *
 * The promo fields are DECLARED, not reached through the index signature: they are real columns
 * now (#69), and a typo'd `promoPrice` silently pricing at base is exactly what the index
 * signature used to hide.
 */
export interface PricedProduct {
  id: string
  name: string
  price: number
  /** null = no promo. **0 is a valid promo** (a free item) — test for null, never truthiness. */
  promoPrice?: number | null
  /** null = uncapped. */
  promoLimit?: number | null
  /** An ISO INSTANT, never a local date string. See the migration's comment. */
  promoEnd?: string | null
  promoSold?: number
  [key: string]: unknown
}
```

Delete `promoSold?: Record<string, number>` from `PriceInput` and add this comment where it was:

```ts
  // NO promoSold input. The count is a column on the product row, and a second channel for it is
  // a second thing to diverge — the browser quotes and the backend charges from the same row.
```

Replace `effectivePrice` and `promoActive` with:

```ts
/** A promo that is currently running, and how many units of it are left. */
export interface PromoState {
  price: number
  /** Infinity when the promo is uncapped. */
  remaining: number
}

/**
 * Is this product's promo running, and for how many more units?
 *
 * The null checks are load-bearing and are not defensiveness: a promo of `0.00` is a FREE ITEM,
 * and a truthiness test (`if (!p.promoPrice)`) would silently price it at the base price. A promo
 * exists iff the column is not null.
 */
export function promoState(p: PricedProduct, now: Date): PromoState | null {
  const price = num(p.promoPrice)
  if (price === null) return null
  if (p.promoEnd && now > new Date(p.promoEnd)) return null

  const limit = num(p.promoLimit)
  if (limit === null) return { price, remaining: Infinity }   // uncapped, and that is a choice

  const remaining = Math.max(0, limit - (num(p.promoSold) ?? 0))
  return remaining > 0 ? { price, remaining } : null
}

/**
 * How many units of each product this breakdown claims at the promo price — what the backend
 * increments `promo_sold` by, and nothing else. The units claimed are exactly the units priced.
 */
export function promoClaims(bd: PriceBreakdown): Record<string, number> {
  const claims: Record<string, number> = {}
  for (const l of bd.lines) if (l.promo) claims[l.id] = (claims[l.id] ?? 0) + l.qty
  return claims
}

/**
 * A `products` row → the shape the pricing rule reads. Both sides of the wire go through here.
 *
 * `num()` is not defensive: postgres.js returns `numeric` as a STRING to preserve precision, so on
 * the backend `price` arrives as '13.00' and `promo_price` as '8.00', while PostgREST hands the
 * browser real numbers. Two sides mapping differently is not a rounding gap — it is a refused
 * checkout (`price_changed`) for every promo order.
 *
 * The row is spread through, so the caller keeps the fields pricing does not read (`image_urls`,
 * `unit`, `active`, …).
 */
export function productFromRow(row: Record<string, unknown>): PricedProduct {
  const end = row.promo_end
  return {
    ...row,
    id: row.id as string,
    name: row.name as string,
    price: num(row.price) ?? 0,
    promoPrice: num(row.promo_price),
    promoLimit: num(row.promo_limit),
    // postgres.js hands back a Date; PostgREST hands back an ISO string. `new Date` takes both.
    promoEnd: end ? new Date(end as string | Date).toISOString() : null,
    promoSold: num(row.promo_sold) ?? 0,
  }
}
```

Replace the line-building loop in `priceOrder`:

```ts
  const lines: PriceLine[] = []
  for (const id of Object.keys(input.cart)) {
    const qty = input.cart[id] || 0
    if (qty <= 0) continue
    const product = input.products.find(p => p.id === id)
    if (!product) continue

    // THE CAP BINDS PER UNIT, so one cart product can produce TWO lines at two prices. A cart of
    // 10 against 3 remaining promo units is 3 + 7 — all-or-nothing would let a cap of 3 sell 100
    // promo units to a single order, which is not a cap. Two lines share a product id: any list
    // rendering these must key by INDEX.
    const promo = promoState(product, now)
    const promoQty = promo ? Math.min(qty, promo.remaining) : 0

    if (promo && promoQty > 0) {
      lines.push({
        id, name: product.name, qty: promoQty,
        unitPrice: promo.price, lineTotal: round2(promo.price * promoQty), promo: true,
      })
    }
    const baseQty = qty - promoQty
    if (baseQty > 0) {
      lines.push({
        id, name: product.name, qty: baseQty,
        unitPrice: product.price, lineTotal: round2(product.price * baseQty), promo: false,
      })
    }
  }
```

In `packages/shared/src/index.ts`: drop `effectivePrice` from the value exports, add `promoState`, `promoClaims`, `productFromRow`; add `PromoState` to the type exports.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @bitetime/shared test && pnpm typecheck
```

Expected: all shared tests PASS. `pnpm typecheck` will FAIL in `apps/backend`/`apps/frontend` if anything still imports `effectivePrice` — it does not (grep confirmed only `pricing.ts` and `index.ts` reference it), so typecheck should be clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(pricing): a promo price, and a cap that splits the line when it runs out"
```

---

### Task 3: The backend charges it, under the lock

**Files:**
- Modify: `apps/backend/src/orders.ts` (`cartProducts`, `placeOrder`)
- Modify: `apps/backend/src/app.ts` (add `GET /api/time`)
- Test: `apps/backend/tests/api/orders.test.ts` (or the promo cases' own file alongside it — follow the directory's convention)

**Interfaces:**
- Consumes: `productFromRow`, `promoClaims` from Task 2; the columns from Task 1.
- Produces: `GET /api/time` → `{ now: <ISO string> }`.

- [ ] **Step 1: Write the failing API tests**

Read `apps/backend/tests/api/` first — in particular the existing **voucher concurrency** test, which is the model for the race case here (two `app.request()` calls issued concurrently against real Postgres). Seed a product with a promo through the admin/owner client.

Cases:

```ts
it('commits at the promo price and moves the counter', async () => {
  // product: price 10, promo_price 8, no cap. cart { p: 2 }, quotedTotal 16 (pickup)
  // → 200; orders row total 16; items = [{ id, name, qty: 2, price: 8 }]; promo_sold = 2
})

it('the Nth+1 unit does not get the promo price', async () => {
  // product: price 10, promo_price 8, promo_limit 3, promo_sold 0. cart { p: 5 }
  // quotedTotal = 3*8 + 2*10 = 44
  // → 200; items has TWO entries for the same product id (3 @ 8, 2 @ 10); promo_sold = 3, not 5
})

it('two checkouts race the last promo unit and exactly one wins', async () => {
  // product: price 10, promo_price 8, promo_limit 1, promo_sold 0.
  // TWO concurrent POSTs, each cart { p: 1 }, each quotedTotal 8 (both quoted the promo).
  // Exactly one 200 and one 400 with code 'price_changed' — the loser's quote named a promo
  // price that no longer exists. promo_sold ends at 1, never 2. Exactly one order row exists.
  //
  // This is the acceptance criterion, and it is what `select … for update` buys: without the
  // lock both transactions read promo_sold = 0, both take the last unit, and the cap is a
  // decoration.
})

it('an elapsed promo does not apply', async () => {
  // product: price 10, promo_price 8, promo_end in the past.
  // A POST quoting 8 → 400 price_changed. A POST quoting 10 → 200, promo_sold stays 0.
})

it('GET /api/time returns a parseable instant', async () => {
  const res = await app.request('/api/time')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(Number.isFinite(Date.parse(body.now))).toBe(true)
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @bitetime/backend test:db
```

Expected: FAIL — the promo columns are not selected, so nothing prices at the promo; `/api/time` 404s.

- [ ] **Step 3: Implement**

`apps/backend/src/app.ts` — beside `/health`:

```ts
/**
 * The server's clock, published.
 *
 * `priceOrder` runs on both sides of the wire and the promo window reads a clock, so the CLOCK is
 * a price input — and a browser minutes off ours, on the promo's last day, would quote the promo,
 * be refused (`price_changed`), re-quote with the same skewed clock, and be refused again: a
 * permanent refusal loop for a legitimate customer. The storefront syncs against this and prices
 * against the corrected time, so the clock it quotes with is the clock we charge with. See #69.
 */
app.get('/api/time', (c) => c.json({ now: new Date().toISOString() }))
```

`apps/backend/src/orders.ts` — import `productFromRow` and `promoClaims` from `@bitetime/shared`, then rewrite `cartProducts`:

```ts
/**
 * The cart's products, scoped to this merchant, on sale, and LOCKED.
 *
 * … (keep the existing comment about refusal-not-dropping and the uuid shape check) …
 *
 * `for update` is the promo cap. Without it two concurrent checkouts both read the last promo unit
 * and both take it — the same reason `claimVoucher` holds a lock, and a cap that only holds when
 * nobody is racing it is not a cap. The lock is held until the transaction ends, so the loser reads
 * the winner's write.
 *
 * `order by id` so two carts holding the same products in a different order cannot deadlock against
 * each other. (Nothing else could anyway — every intake takes the merchant's single `order_counters`
 * row first, which serialises the shop's intake — but the ordering costs nothing and does not depend
 * on that staying true.)
 *
 * Rows go through `productFromRow`: postgres.js returns `numeric` as a STRING, and the browser
 * quoted from PostgREST's numbers. Two mappings would refuse every promo order.
 */
async function cartProducts(
  tx: postgres.TransactionSql,
  merchantId: string,
  cart: Record<string, number>,
): Promise<PricedProduct[]> {
  const ids = Object.keys(cart).filter(id => (cart[id] ?? 0) > 0)
  if (ids.length === 0) throw new OrderError('product_unavailable')
  if (!ids.every(id => UUID.test(id))) throw new OrderError('product_unavailable')

  const rows = await tx<Record<string, unknown>[]>`
    select id, name, price, promo_price, promo_limit, promo_end, promo_sold
    from products
    where merchant_id = ${merchantId} and id = any(${ids}::uuid[]) and active
    order by id
    for update
  `
  if (rows.length !== ids.length) throw new OrderError('product_unavailable')

  return rows.map(productFromRow)
}
```

In `placeOrder`, **move the `cartProducts` call** so it runs *after* the counter and the voucher (it now takes locks, and the counter is the per-merchant mutex that makes the lock order trivially safe), and bump the counter after `assertQuoteHolds`:

```ts
    const merchant = await assertOrderableMerchant(tx, input.merchantId)
    const day = orderDay(now)

    // Lock order is counter → voucher → products, and every intake takes it. `order_counters` is
    // ONE row per merchant, so it serialises the shop's intake before any product row is touched.
    const orderNumber = formatOrderNumber(merchant.order_prefix, day, await nextCounterValue(tx, input.merchantId, day))

    const voucher = input.voucherCode
      ? await claimVoucher(tx, input.merchantId, input.voucherCode, input.userEmail)
      : null

    // Scoped to this merchant — the ONLY thing keeping a stranger's product out of this cart, since
    // no RLS runs on this connection — and LOCKED, which is what makes the promo cap real.
    const products = await cartProducts(tx, input.merchantId, input.cart)

    const bd = priceOrder({ /* …unchanged… */ })

    assertQuoteHolds(bd.total, input.quotedTotal)

    // Claim the promo units, under the lock we are already holding. A promo that sold out between
    // the customer's quote and this moment has already surfaced as `price_changed` above — they are
    // shown the new total and confirm it, rather than being quietly charged more.
    for (const [id, qty] of Object.entries(promoClaims(bd))) {
      await tx`update products set promo_sold = promo_sold + ${qty} where id = ${id}`
    }
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @bitetime/backend test:db && pnpm typecheck && pnpm lint
```

Expected: all DB tests PASS (including every pre-existing suite — the lock reorder must not break the voucher concurrency test).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src apps/backend/tests
git commit -m "feat(orders): charge the promo price, and claim its units under the row lock"
```

---

### Task 4: The two pure frontend modules — the clock and the date

**Files:**
- Create: `apps/frontend/src/serverClock.ts`, `apps/frontend/src/serverClock.test.ts`
- Create: `apps/frontend/src/promoEnd.ts`, `apps/frontend/src/promoEnd.test.ts`
- Modify: `apps/frontend/src/store.ts` (add `fetchServerNow`, next to the other `API_URL` callers)

**Interfaces:**
- Consumes: `GET /api/time` from Task 3.
- Produces:
  - `clockOffset(serverNowMs: number, sentAt: number, receivedAt: number): number`
  - `useServerClock(): { now: () => Date; resync: () => Promise<void> }`
  - `promoEndFromDate(date: string): string | null` — `'2026-07-20'` → the ISO instant of local 23:59:59.999
  - `promoEndToDate(iso: string | null | undefined): string` — the inverse, `''` when there is none
  - `fetchServerNow(): Promise<{ now: number; sentAt: number; receivedAt: number } | null>`

- [ ] **Step 1: Write the failing tests**

`apps/frontend/src/serverClock.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { clockOffset } from './serverClock'

describe('clockOffset', () => {
  // Half the round trip is OUR latency, not the server's lead. Charging it all to the offset would
  // push the browser's clock ahead of the server's by the network delay.
  it('halves the round trip out of the estimate', () => {
    // sent at 1000, answer read at 1200 → our midpoint is 1100. Server said 1600.
    expect(clockOffset(1600, 1000, 1200)).toBe(500)
  })

  it('is zero when the clocks agree', () => {
    expect(clockOffset(1100, 1000, 1200)).toBe(0)
  })

  it('goes negative when the browser runs fast', () => {
    expect(clockOffset(900, 1000, 1200)).toBe(-200)
  })
})
```

`apps/frontend/src/promoEnd.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { promoEndFromDate, promoEndToDate } from './promoEnd'

describe('promoEnd', () => {
  it('a date becomes the last instant of that day, locally', () => {
    const iso = promoEndFromDate('2026-07-20')!
    const d = new Date(iso)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6)      // July
    expect(d.getDate()).toBe(20)
    expect(d.getHours()).toBe(23)
    expect(d.getMinutes()).toBe(59)
  })

  it('round-trips', () => {
    expect(promoEndToDate(promoEndFromDate('2026-07-20'))).toBe('2026-07-20')
  })

  it('no date is no promo end', () => {
    expect(promoEndFromDate('')).toBeNull()
    expect(promoEndToDate(null)).toBe('')
    expect(promoEndToDate(undefined)).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter @bitetime/frontend test
```

Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Implement**

`apps/frontend/src/store.ts`, beside the other `API_URL` callers:

```ts
/**
 * The backend's clock, and the two browser timestamps that bracket it.
 *
 * `null` on any failure — the caller falls back to the browser's own clock, which is exactly
 * today's behaviour, degraded but no worse.
 */
export async function fetchServerNow(): Promise<{ now: number; sentAt: number; receivedAt: number } | null> {
  const sentAt = Date.now()
  try {
    const res = await fetch(`${API_URL}/api/time`)
    const receivedAt = Date.now()
    if (!res.ok) return null
    const body = await res.json()
    const now = Date.parse(body?.now)
    return Number.isFinite(now) ? { now, sentAt, receivedAt } : null
  } catch {
    return null
  }
}
```

`apps/frontend/src/serverClock.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'
import { fetchServerNow } from './store'

/**
 * How far the SERVER's clock is ahead of ours, in ms.
 *
 * The midpoint of the two local timestamps is our best guess at what our clock read when the server
 * stamped its answer — charging the whole round trip to the offset would push us ahead of the server
 * by the network delay.
 */
export function clockOffset(serverNowMs: number, sentAt: number, receivedAt: number): number {
  return serverNowMs - (sentAt + receivedAt) / 2
}

/**
 * The clock the storefront prices with — the SERVER's, not the device's.
 *
 * Since #68 the browser quotes and the backend charges, and a disagreement is a hard refusal. The
 * promo window is the first rule that reads a clock, which makes the clock a PRICE INPUT: a device
 * minutes off ours, on the promo's last day, would quote the promo price, be refused, re-quote with
 * the same skewed clock, and be refused again — a permanent refusal loop for a legitimate customer,
 * on the busiest day of the promo. Refreshing the menu cannot fix a clock; only this can.
 *
 * A failed sync leaves the offset at 0 — the device's own clock, i.e. the old behaviour. The
 * storefront re-syncs on a `price_changed` recovery, and a backend that can refuse an order can
 * answer `/api/time`.
 */
export function useServerClock() {
  const [offset, setOffset] = useState(0)

  const resync = useCallback(async () => {
    const s = await fetchServerNow()
    if (s) setOffset(clockOffset(s.now, s.sentAt, s.receivedAt))
  }, [])

  useEffect(() => { void resync() }, [resync])

  // Depends on `offset` so a sync that lands after the first paint RE-PRICES. A ref here would
  // leave the promo quoted against the device's clock forever.
  const now = useCallback(() => new Date(Date.now() + offset), [offset])

  return { now, resync }
}
```

`apps/frontend/src/promoEnd.ts`:

```ts
/**
 * The merchant picks a DATE; the column stores an INSTANT.
 *
 * The instant is the end of that day in the timezone of the browser that set it. That is a real
 * limitation, and it is the honest one available: the shop has no timezone of its own (that is
 * separate work). What it buys is that the promo's end is an absolute instant on the wire, so the
 * customer's browser and the server cannot resolve it eight hours apart — which is exactly what
 * `new Date(dateString + 'T23:59:59')` did, because that parses as LOCAL time on both sides.
 */
export function promoEndFromDate(date: string): string | null {
  if (!date) return null
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return null
  const end = new Date(y, m - 1, d, 23, 59, 59, 999)   // local end-of-day
  return Number.isNaN(end.getTime()) ? null : end.toISOString()
}

/** The inverse, for the dashboard's `<input type="date">`. */
export function promoEndToDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @bitetime/frontend test && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/serverClock.ts apps/frontend/src/serverClock.test.ts apps/frontend/src/promoEnd.ts apps/frontend/src/promoEnd.test.ts apps/frontend/src/store.ts
git commit -m "feat(storefront): price against the server's clock, and store a promo's end as an instant"
```

---

### Task 5: The storefront shows the promo and quotes it against the server's clock

**Files:**
- Modify: `apps/frontend/src/store/Storefront.tsx`

**Interfaces:**
- Consumes: `useServerClock` (Task 4), `productFromRow` / `promoState` (Task 2).

- [ ] **Step 1: Wire the clock into every quote**

In `Storefront.tsx`:

```ts
import { priceOrder, voucherError, shopRates, productFromRow, promoState, MAX_CART_QTY, MAX_CART_LINES } from '@bitetime/shared'
import { useServerClock } from '../serverClock'
```

In the component body, above the `priceOrder` call at line ~249:

```ts
  // The SERVER's clock, not the device's — the promo window is priced on both sides of the wire and
  // a disagreement is a refusal. See serverClock.ts.
  const { now: serverNow, resync: resyncClock } = useServerClock()
  const now = serverNow()

  // The menu, mapped once for the pricing rule: the rows arrive snake_cased from PostgREST and
  // `priceOrder` reads `promoPrice`. Unmapped, every promo silently prices at the base price here
  // and at the promo price on the backend — which is a refused checkout for every promo order.
  const pricedProducts = activeProducts.map(productFromRow)
  const promoById = new Map(pricedProducts.map(p => [p.id, promoState(p, now)]))
```

Pass `products: pricedProducts` and `now` to the `priceOrder` call (replacing `products: activeProducts`):

```ts
  const bd = priceOrder({
    products: pricedProducts,
    cart,
    now,
    // …the rest unchanged…
  })
```

Pass `now` to the `voucherError` call in `applyVoucher` too (it currently reads `new Date()`), so one clock governs the page.

- [ ] **Step 2: Re-sync the clock on a refusal recovery**

In `refreshQuoteSources` (line ~388), add the clock to what it re-reads — a stale offset is a quote input like any other, and it is the one input a menu refetch cannot fix:

```ts
  const refreshQuoteSources = async () => {
    const [freshProducts, freshVoucher] = await Promise.all([
      lookupProducts(merchant.id).catch(() => null),
      /* …the existing voucher lookup… */
    ])
    // The clock is a quote input too, and the only one a menu refetch cannot repair: if the initial
    // sync failed we are pricing the promo window against the device's clock, and re-sending the
    // same quote would be refused identically, forever. A backend that can refuse an order can
    // answer /api/time.
    void resyncClock()
    // …the rest unchanged…
  }
```

- [ ] **Step 3: Show the promo on the product card**

In the `activeProducts.map(p => …)` card at line ~703, replace the price line (line ~732):

```tsx
                      {(() => {
                        const promo = promoById.get(p.id)
                        const unit = formatUnit(p.unit_quantity, p.unit || t('unit', '个'))
                        if (!promo) {
                          return (
                            <div className="text-[13px] font-medium text-oxblood mt-[5px]">
                              {formatMoney(p.price, currency)} / {unit}
                            </div>
                          )
                        }
                        return (
                          <div className="flex items-center gap-2 mt-[5px] flex-wrap">
                            <span className="text-[13px] font-medium text-oxblood">
                              {formatMoney(promo.price, currency)} / {unit}
                            </span>
                            <span className="text-[12px] text-rose-muted line-through">
                              {formatMoney(p.price, currency)}
                            </span>
                            <span className="px-1.5 py-0.5 rounded-full bg-oxblood text-white text-[10px] leading-[14px] font-medium">
                              {t('Promo', '优惠')}
                            </span>
                            {Number.isFinite(promo.remaining) && (
                              <span className="text-[11px] text-rose-muted">
                                {t(`${promo.remaining} left at this price`, `此价格剩 ${promo.remaining} 件`)}
                              </span>
                            )}
                          </div>
                        )
                      })()}
```

- [ ] **Step 4: Key the summary lines by index, not by product id**

**This is a correctness fix, not styling.** A capped promo splits one cart product into TWO lines with the SAME id. Keyed by id, React renders one of them and drops the other from the screen — while the customer is charged for both.

Two places render `cartItems` (which is `bd.lines`): line ~603 and line ~970. Both use `key={item.id}`. Change both to `key={i}` (adding the index parameter to the `.map`). Line ~971's `activeProducts.find(p => p.id === item.id)` lookup stays as it is — it is looking up the product, and both lines share one.

Check `SuccessView`'s `items: CartLine[]` rendering for the same pattern and fix it the same way if present.

- [ ] **Step 5: Verify by running the app**

Use the `verify` skill. Bring up Supabase, the frontend and the backend (kill :8787 first — `--watch` has served stale code on this project twice). Seed a shop with a product at RM 10 and a promo at RM 8, cap 3.

Confirm:
1. The storefront card shows **RM 8.00**, RM 10.00 struck through, a "Promo" badge and "3 left at this price".
2. Adding 5 to the cart shows the summary as **two lines** — 3 × RM 8.00 and 2 × RM 10.00 — and both are on screen.
3. The order commits, the success screen shows both lines, and `select promo_sold from products` reads **3**.
4. Reloading the storefront now shows the base price with no badge (the cap is spent).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/store/Storefront.tsx
git commit -m "feat(storefront): show the promo, and quote it against the server's clock"
```

---

### Task 6: The merchant sets the promo

**Files:**
- Modify: `apps/frontend/src/merchant/ProductsManager.tsx`

**Interfaces:**
- Consumes: `promoEndFromDate` / `promoEndToDate` (Task 4).

- [ ] **Step 1: Add the fields to the form's state**

`BLANK` (line 38) gains `promo_price: '', promo_limit: '', promo_end: ''`.

The edit path (line ~158, where the form is filled from a row) gains:

```ts
      promo_price: p.promo_price === null || p.promo_price === undefined ? '' : String(p.promo_price),
      promo_limit: p.promo_limit === null || p.promo_limit === undefined ? '' : String(p.promo_limit),
      promo_end: promoEndToDate(p.promo_end),
```

- [ ] **Step 2: Build the promo half of the upsert payload, and validate it**

Add above the save handler:

```ts
  /**
   * The promo columns, from the three form fields. An empty field is NULL — no promo / no cap / no
   * end date — and `promo_price: 0` is a real promo (a free item), so this tests for '' and never
   * for falsiness.
   *
   * `promo_sold` is deliberately absent: the browser cannot write it (a DB trigger pins it), and it
   * is the backend's counter. The whole-row spread below still carries it back unchanged; the
   * trigger is what makes that harmless.
   */
  const promoFields = (f: any) => ({
    promo_price: f.promo_price === '' ? null : Number(f.promo_price),
    promo_limit: f.promo_limit === '' ? null : Number(f.promo_limit),
    promo_end: promoEndFromDate(f.promo_end),
  })

  /** Returns a message to show, or null. The DB has the same check — this is the one with words. */
  const promoProblem = (f: any): string | null => {
    if (f.promo_price === '') return null
    const promo = Number(f.promo_price)
    const price = Number(f.price) || 0
    if (!Number.isFinite(promo) || promo < 0) {
      return t('The promo price must be a number, and not negative.', '优惠价必须是非负数字。')
    }
    if (promo >= price) {
      return t('The promo price must be below the normal price.', '优惠价必须低于原价。')
    }
    if (f.promo_limit !== '' && (!Number.isInteger(Number(f.promo_limit)) || Number(f.promo_limit) < 1)) {
      return t('The promo limit must be a whole number of at least 1.', '优惠数量上限必须是不小于 1 的整数。')
    }
    return null
  }
```

In the save handler (line ~169), refuse before writing, and spread the promo fields **last** so they win over the raw form strings:

```ts
    const problem = promoProblem(form)
    if (problem) { setMsg(problem); return }   // follow the file's existing error-message pattern

    if (editingProduct) {
      await upsertProduct({
        ...editingProduct, ...form, ...promoFields(form),
        image_urls: images,
        price: Number(form.price) || 0,
        unit_quantity: coerceQuantity(form.unit_quantity),
      })
    } else {
      await upsertProduct({
        /* …existing fields… */
        ...promoFields(form),
        price: Number(form.price) || 0,
        unit_quantity: coerceQuantity(form.unit_quantity),
      })
    }
```

- [ ] **Step 3: Render the three inputs, and the count**

Below the price/unit inputs (line ~295-315), following the file's existing field markup exactly:

- `promo_price` — a number input, label `t('Promo price', '优惠价')`, helper text `t('Leave empty for no promo.', '留空表示无优惠。')`
- `promo_limit` — a number input, label `t('Promo limit', '优惠数量上限')`, helper `t('How many units sell at this price. Leave empty for no limit.', '以此价格出售的数量。留空表示不限。')`
- `promo_end` — `<input type="date">`, label `t('Promo ends', '优惠结束日期')`, helper `t('The promo runs to the end of this day. Leave empty for no end date.', '优惠持续到当天结束。留空表示无结束日期。')`

And, when editing a product that already has a promo, a read-only count:

```tsx
                {editingProduct && editingProduct.promo_price !== null && editingProduct.promo_price !== undefined && (
                  <p className="text-[12px] text-rose-muted">
                    {editingProduct.promo_limit
                      ? t(`${editingProduct.promo_sold ?? 0} of ${editingProduct.promo_limit} sold at the promo price.`,
                          `已以优惠价售出 ${editingProduct.promo_sold ?? 0} / ${editingProduct.promo_limit} 件。`)
                      : t(`${editingProduct.promo_sold ?? 0} sold at the promo price.`,
                          `已以优惠价售出 ${editingProduct.promo_sold ?? 0} 件。`)}
                    {' '}
                    {t('Changing the promo price starts the count again.', '更改优惠价将重新计数。')}
                  </p>
                )}
```

- [ ] **Step 4: Verify by running the app**

Use the `verify` skill.

1. Set a promo of RM 8 on a RM 10 product with a cap of 3 and an end date of today. Save. Reopen — the three fields round-trip, and the count reads "0 of 3 sold".
2. Try a promo price of RM 12 on a RM 10 product → the form refuses with "The promo price must be below the normal price."
3. Buy one unit from the storefront, reopen the product → "1 of 3 sold".
4. Change the product's **name** and save → the count still reads "1 of 3 sold" (the trigger pinned it).
5. Raise the cap to 5 and save → "1 of 5 sold" (the count survived).
6. Change the promo **price** to RM 7 and save → "0 of 5 sold" (a new price is a new promo).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/ProductsManager.tsx
git commit -m "feat(dashboard): set a promo price, an end date and a cap"
```

---

### Task 7: The docs say what is true

**Files:**
- Modify: `CONTEXT.md` (the *Order pricing* section)

- [ ] **Step 1: Rewrite the promo half of Order pricing**

Delete the promo half of the "Promo is **unbuilt**, not unwired" paragraph at `CONTEXT.md:21` — keep the `referral` half (that is still #70). Replace `effectivePrice` in the bullet list (line 17) and add the promo's rules to the section:

- Promo resolution is **live**: `promo_price` (null = no promo, and **0 is a valid promo**), `promo_limit` (null = uncapped), `promo_end` (a **timestamptz**, an absolute instant — never a local date), `promo_sold` (a counter).
- **The cap binds per unit** and splits the line: a cart of 10 with 3 left is 3 promo + 7 base, so two `items` entries share a product id and any list rendering them keys by index.
- **The cap is claimed under `select … for update`**, inside the order transaction, alongside the voucher and for the same reason. A promo that sells out between quote and submit surfaces as `price_changed`.
- **`promo_sold` is not writable from the browser** — a trigger pins it for `authenticated`/`anon`. It resets only when the promo *price* changes; raising the cap does not reset it.
- **The browser prices the promo window against the SERVER's clock** (`GET /api/time`, `serverClock.ts`), because `priceOrder` runs on both sides and a clock disagreement is a refused checkout that a menu refetch cannot repair. The promo's end-of-day is in the timezone of the browser the *merchant* set it from — a shop has no timezone of its own, and that is out of scope.
- A cancelled order **does not return its units** to the cap.

- [ ] **Step 2: Full suite, clean tree**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @bitetime/backend test:db
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "docs: promo pricing is live, and what its cap does and does not promise"
```
