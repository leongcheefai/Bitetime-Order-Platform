# Backend Price Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The backend derives every number on an order from Postgres; the browser's total becomes a confirmation to check, not an input to trust.

**Architecture:** `pricing.ts` moves to `@bitetime/shared` so the browser's quote and the backend's charge come from one module and cannot drift. `POST /api/orders` stops accepting `items`, `total`, `shippingFee`, `discount` and `currency`, and takes a cart plus the total the customer saw (`quotedTotal`). Inside the existing order transaction, `placeOrder` loads the cart's products, the merchant's shipping rates and currency, claims the voucher, prices the order with a server clock, and refuses with `price_changed` if its total disagrees with the quote.

**Tech Stack:** pnpm + Turborepo, TypeScript (strict), Hono, postgres.js, Supabase/Postgres, Vitest.

**Issue:** #68. **Spec:** `docs/superpowers/specs/2026-07-14-backend-price-authority-design.md`.

## Global Constraints

- Run commands from the repo root; `--filter` targets one workspace.
- Every workspace is TypeScript, `strict: true`, `noEmit: true`.
- **Backend uses `moduleResolution: NodeNext`** — relative imports keep `.js` specifiers that resolve to the `.ts` source. Leave them as `.js`. `@bitetime/shared`'s internal imports do the same (`./password.js`).
- **Frontend uses `moduleResolution: bundler`** — extensionless relative imports.
- `@bitetime/shared` ships **TypeScript source, no build step** (`exports: "./src/index.ts"`). Adding a backend **runtime** dependency means adding its `--external:` flag to the backend's esbuild command. This plan adds none.
- **Never mock the database** in `tests/api` or `tests/rls`. They exist to prove properties of real Postgres. `test:db` needs a running local Supabase (`supabase start` from `apps/backend`).
- **`db.ts` is RLS-exempt** — it connects as the database owner and no policy runs on it. Every tenancy check on this path is a TypeScript invariant. The `merchant_id = $1` predicate in Task 3 is load-bearing.
- **postgres.js returns `numeric` columns as JavaScript strings.** `products.price` arrives as `'13.00'`, not `13`. Coerce with `Number(...)` at the row boundary or `round2`'s `.toFixed()` throws on a string.
- Order numbers, the counter start (50) and the `<PREFIX>-YYMMDD-XXXX` format are customer-visible and pinned. Do not touch `orderNumber.ts`.
- Commit after each task.

---

### Task 1: Move the pricing rule into `@bitetime/shared`

A pure move. No behaviour changes, no signature changes. The one edit is to the types: `pricing.ts` currently imports `Product` and `Voucher` from the frontend's `src/types.ts`, which the shared package cannot see. It gets its own minimal structural types instead — a frontend `Product` still satisfies them, because it declares every field they require.

**Files:**
- Create: `packages/shared/src/pricing.ts`
- Create: `packages/shared/src/pricing.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/frontend/src/store/Storefront.tsx:9`
- Delete: `apps/frontend/src/pricing.ts`, `apps/frontend/src/pricing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: from `@bitetime/shared` — `priceOrder(input: PriceInput): PriceBreakdown`, `voucherError(voucher, ctx): VoucherErrorCode | null`, `effectivePrice(product, now, sold?)`, `shippingFee(mode, state, rates, samedayFee?)`, `EM_STATES: string[]`, and the types `PriceInput`, `PriceBreakdown`, `PriceLine`, `VoucherErrorCode`, `VoucherCtx`, `PricedProduct`, `PricedVoucher`.

- [ ] **Step 1: Create the shared module**

Copy `apps/frontend/src/pricing.ts` verbatim to `packages/shared/src/pricing.ts`, then replace **only** its import line and the two type references. Delete this line:

```ts
import type { Product, Voucher } from './types'
```

and put these two declarations in its place, directly under the file's header comment:

```ts
/**
 * Only the fields the pricing rule actually reads. Declared here rather than imported
 * because this package is the boundary between the two workspaces: a frontend `Product`
 * row and a backend `products` row must both satisfy it, and neither owns it.
 *
 * The index signature is what lets `promoActive` reach `promoPrice`/`promoLimit`/`promoEnd`.
 * Those columns DO NOT EXIST yet — the promo feature is #69 — so that branch is inert. It is
 * carried over unchanged rather than deleted, because #69 is the ticket that makes it real.
 */
export interface PricedProduct {
  id: string
  name: string
  price: number
  [key: string]: unknown
}

/**
 * A voucher as the discount math needs it — `type` and `value` are the mapped names, NOT the
 * `kind`/`amount` columns. `voucherFromRow` (Task 2) is what maps one to the other, and both
 * sides of the wire must go through it or the discount diverges on shape alone.
 *
 * `minOrder`, `expiresAt` and `email` have no columns behind them, so `voucherError`'s
 * `min_order`, `expired` and `not_assigned` branches can never fire. That is #71, deliberately
 * deferred: this task moves the module as-is. The backend never calls `voucherError`, so
 * nothing new starts depending on the dead branches here.
 */
export interface PricedVoucher {
  code?: string
  type?: string
  value?: number
  maxUses?: number | string | null
  usedBy?: string[]
  [key: string]: unknown
}
```

Then in the same file change the two type references — `products: Product[]` becomes `products: PricedProduct[]`, `voucher?: Voucher | null` becomes `voucher?: PricedVoucher | null`, `voucherError(voucher: Voucher | null | undefined, …)` becomes `voucherError(voucher: PricedVoucher | null | undefined, …)`, `voucherDiscount(voucher: Voucher | null | undefined, …)` becomes `voucherDiscount(voucher: PricedVoucher | null | undefined, …)`, and `effectivePrice(product: Product, …)` becomes `effectivePrice(product: PricedProduct, …)`. Every function body stays byte-for-byte as it is, `as any` casts included.

Update the file's header comment's cross-reference, which points at a path that no longer exists:

```ts
// Order pricing — the one pure module that turns a cart + context into a money
// breakdown. THE single source of truth for every total the app shows AND every
// total the backend charges: the browser prices to quote, the backend prices to
// commit, and two copies would drift into charging a customer a number they never
// saw. No I/O: the clock, the loaded voucher and the resolved referral are passed in.
// See CONTEXT.md → "Order pricing".
```

- [ ] **Step 2: Move the tests**

Copy `apps/frontend/src/pricing.test.ts` to `packages/shared/src/pricing.test.ts` and change its two import lines:

```ts
import { describe, it, expect } from 'vitest'
import { priceOrder, voucherError } from './pricing.js'
import type { PricedProduct } from './pricing.js'

const RATES = { WM: 8, EM: 12 }
const NOW = new Date('2026-06-29T12:00:00')

function product(id: string, price: number, extra: Partial<PricedProduct> = {}): PricedProduct {
  return { id, name: id, price, ...extra }
}
```

The rest of the file is unchanged.

- [ ] **Step 3: Export from the package index**

`packages/shared/src/index.ts`:

```ts
// Rules that must hold identically in the frontend and the backend. Source-only: both
// workspaces compile TypeScript themselves (Vite/esbuild/Vitest), so there is no build
// step and no dist — the consumers bundle this source directly.
export { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from './password.js'
export { priceOrder, voucherError, effectivePrice, shippingFee, EM_STATES } from './pricing.js'
export type {
  PriceInput, PriceBreakdown, PriceLine,
  VoucherCtx, VoucherErrorCode,
  PricedProduct, PricedVoucher,
} from './pricing.js'
```

- [ ] **Step 4: Delete the frontend copies and repoint its only importer**

```bash
git rm apps/frontend/src/pricing.ts apps/frontend/src/pricing.test.ts
```

`apps/frontend/src/store/Storefront.tsx:9` — it is the only importer:

```ts
import { priceOrder, voucherError } from '@bitetime/shared'
```

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass. The moved `pricing.test.ts` now runs under `@bitetime/shared`. If typecheck complains that a `Product` is not assignable to `PricedProduct`, the cause is a missing required field on `PricedProduct` — not a reason to widen the frontend's type.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move the pricing rule into @bitetime/shared

The browser prices to quote and the backend is about to price to charge. Two
copies of the rounding, the discount order and the shipping-region selection
would drift, and the drift would surface as a customer charged a number they
never saw. Pure move: no behaviour change."
```

---

### Task 2: Move `voucherFromRow` into `@bitetime/shared`

Reading a `vouchers` row into the shape the discount math wants is part of the rule, not a frontend detail. The backend is about to need it (Task 3) and must read a row **identically** or the discount diverges on shape alone.

**Files:**
- Modify: `packages/shared/src/pricing.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/frontend/src/store.ts:432-441` (delete the local copy, re-export for its existing callers)
- Test: `packages/shared/src/pricing.test.ts`

**Interfaces:**
- Consumes: `PricedVoucher` from Task 1.
- Produces: `voucherFromRow(row: Record<string, unknown>): PricedVoucher`, exported from `@bitetime/shared`.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/pricing.test.ts`:

```ts
describe('voucherFromRow', () => {
  it('maps the vouchers row columns onto the names the discount math reads', () => {
    const v = voucherFromRow({
      id: 'v1', code: 'SAVE10', kind: 'percent', amount: '10',
      max_uses: 50, used_by: ['a@b.com'],
    })
    expect(v).toMatchObject({
      id: 'v1', code: 'SAVE10', type: 'percent', value: 10,
      maxUses: 50, usedBy: ['a@b.com'],
    })
  })

  // postgres.js hands back `numeric` as a string; supabase-js hands back a number. The
  // discount math multiplies and rounds, so a string `amount` would reach `.toFixed` and
  // throw. Both sides of the wire go through this mapper precisely so neither has to know.
  it('coerces a numeric amount to a number, whichever driver produced it', () => {
    expect(voucherFromRow({ code: 'X', kind: 'fixed', amount: '5.50' }).value).toBe(5.5)
    expect(voucherFromRow({ code: 'X', kind: 'fixed', amount: 5.5 }).value).toBe(5.5)
  })

  it('defaults a missing used_by to an empty list, never undefined', () => {
    expect(voucherFromRow({ code: 'X', kind: 'fixed', amount: 5 }).usedBy).toEqual([])
  })
})
```

Add `voucherFromRow` to the test file's import from `./pricing.js`.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @bitetime/shared test
```

Expected: FAIL — `voucherFromRow is not a function`.

- [ ] **Step 3: Implement it in the shared module**

Append to `packages/shared/src/pricing.ts`:

```ts
/**
 * A `vouchers` row → the shape the discount math reads. The column names (`kind`, `amount`,
 * `max_uses`, `used_by`) and the field names (`type`, `value`, `maxUses`, `usedBy`) are not
 * the same, and BOTH sides of the wire go through here so neither has to know that.
 *
 * `Number(row.amount)` is not defensive: postgres.js returns `numeric` as a STRING to keep
 * precision, so on the backend `amount` arrives as '10.00'. Unmapped, it reaches `round2`'s
 * `.toFixed()` and throws.
 */
export function voucherFromRow(row: Record<string, unknown>): PricedVoucher {
  return {
    id: row.id as string | undefined,
    code: row.code as string,
    type: row.kind as string,               // 'percent' | 'fixed'
    value: Number(row.amount),
    maxUses: (row.max_uses ?? null) as number | null,
    usedBy: Array.isArray(row.used_by) ? (row.used_by as string[]) : [],
  }
}
```

Export it from `packages/shared/src/index.ts`, alongside the other pricing exports:

```ts
export { priceOrder, voucherError, effectivePrice, shippingFee, voucherFromRow, EM_STATES } from './pricing.js'
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
pnpm --filter @bitetime/shared test
```

Expected: PASS.

- [ ] **Step 5: Delete the frontend's copy**

In `apps/frontend/src/store.ts`, delete the `voucherFromRow` function (lines 432-441) and re-export the shared one in its place, so its existing callers (`fetchMerchantVouchers`, `fetchMerchantVoucher`) and any importer elsewhere keep working unchanged:

```ts
// The row → domain mapping now lives in @bitetime/shared: the backend prices orders from the
// same voucher rows, and a second copy of this mapping is a second way for the two sides to
// disagree about what a voucher is worth.
export { voucherFromRow } from '@bitetime/shared'
```

Add `voucherFromRow` to the file's existing `@bitetime/shared` import if it already has one; otherwise this re-export line stands alone.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass.

```bash
git add -A
git commit -m "refactor: move voucherFromRow into @bitetime/shared

The backend is about to price orders from the same voucher rows. Reading a row is
part of the rule: two copies of the kind→type, amount→value mapping are two ways to
disagree about what a voucher is worth. Coerces the amount, which postgres.js returns
as a string."
```

---

### Task 3: The backend prices the order

The heart of the change. `placeOrder` stops being handed prices and starts deriving them, inside the transaction it already opens.

**Files:**
- Modify: `apps/backend/src/orders.ts`
- Modify: `apps/backend/src/app.ts:467-527`
- Modify: `apps/backend/tests/rls/helpers.ts` (add `seedProduct`)
- Test: `apps/backend/tests/api/orders.test.ts`

**Interfaces:**
- Consumes: `priceOrder`, `voucherFromRow`, `PricedProduct` from `@bitetime/shared` (Tasks 1-2). Import them with a **bare specifier** — `import { priceOrder, voucherFromRow } from '@bitetime/shared'` — never a relative path.
- Produces: `PlaceOrderInput` with `cart: Record<string, number>` and `quotedTotal: number`, replacing `items`, `total`, `shippingFee`, `discount` and `currency`. `OrderErrorCode` gains `'price_changed'` and `'product_unavailable'`.

- [ ] **Step 1: Add a product seeder to the test helpers**

The API suite currently posts cart lines with invented ids (`p1`) and no `products` row behind them. After this task the backend looks those ids up, so the suite needs real rows.

Append to `apps/backend/tests/rls/helpers.ts`:

```ts
/** Seed one product for a merchant. Returns its id. */
export async function seedProduct(fields: {
  merchant_id: string
  name?: string
  price: number
  active?: boolean
}) {
  const { data, error } = await serviceClient()
    .from('products')
    .insert({
      merchant_id: fields.merchant_id,
      name: fields.name ?? 'Matcha Cookie',
      price: fields.price,
      active: fields.active ?? true,
    })
    .select('id')
    .single()
  if (error) throw new Error(`seeding product: ${error.message}`)
  return data!.id as string
}
```

`resetMerchant` already deletes `products` for the merchant, so no teardown change is needed.

- [ ] **Step 2: Write the failing tests**

In `apps/backend/tests/api/orders.test.ts`, replace the `body()` helper. It sends a cart and a quote instead of prices, and takes the seeded product's id (the suite's merchant fixture is called `shop`):

```ts
/** A cart of 2 × RM13 = 26, shaped like the one the storefront now sends. */
function body(merchantId: string, productId: string, extra: Record<string, unknown> = {}) {
  return {
    merchantId,
    customerName: 'Ah Meng',
    customerWa: '60123456789',
    mode: 'pickup',
    cart: { [productId]: 2 },
    quotedTotal: 26,
    ...extra,
  }
}
```

Declare `let productId: string` alongside the suite's existing `let shop: string`, and seed it in the existing `beforeEach` — **not** `beforeAll`. One of the new tests edits the product's price, so each test needs a fresh one, and `beforeEach` currently does not clear `products`:

```ts
  beforeEach(async () => {
    await svc().from('orders').delete().eq('merchant_id', shop)
    await svc().from('order_counters').delete().eq('merchant_id', shop)
    await svc().from('vouchers').delete().eq('merchant_id', shop)
    await svc().from('products').delete().eq('merchant_id', shop)
    productId = await seedProduct({ merchant_id: shop, price: 13 })
  })
```

Import `seedProduct` from `../rls/helpers.js` alongside the existing helpers, and update every existing call site from `body(shop)` to `body(shop, productId)`. **Every existing assertion about rollback, concurrency, attribution and the intake gate stays exactly as it is** — they are the reason this suite exists, and this task must not weaken one of them.

Then add the new cases:

```ts
describe('the backend is the price authority', () => {
  it('refuses a body that names its own total, and writes nothing', async () => {
    // THE HOLE THIS TASK CLOSES. Before it, this committed an order at zero.
    const res = await post(body(shop, productId, { quotedTotal: 0 }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('price_changed')
    expect(await ordersOf(shop)).toHaveLength(0)
  })

  it('commits the server-derived total and items, not anything the body said', async () => {
    const res = await post(body(shop, productId))
    expect(res.status).toBe(200)

    const [order] = await ordersOf(shop)
    expect(Number(order.total)).toBe(26)
    expect(Number(order.shipping_fee)).toBe(0)
    // Built from the products rows, so the name and the unit price are the shop's own — not
    // whatever the browser felt like calling them.
    expect(order.items).toEqual([
      { id: productId, name: 'Matcha Cookie', qty: 2, price: 13 },
    ])
  })

  it('refuses with price_changed when the price moves between quote and submit', async () => {
    await svc().from('products').update({ price: 15 }).eq('id', productId)

    const res = await post(body(shop, productId))  // still quoting the old 26
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('price_changed')
    expect(await ordersOf(shop)).toHaveLength(0)
    // Rolled back WHOLE: not even a burnt counter slot.
    expect(await counterOf(shop)).toBeNull()
  })

  it("refuses a product belonging to another shop", async () => {
    // The order goes to `shop`, which is active and orderable; the product is `suspendedShop`'s.
    // Nothing but the merchant_id predicate in cartProducts stands between them — db.ts is
    // RLS-exempt, so this is the test that the TypeScript invariant actually holds.
    const strangersProduct = await seedProduct({ merchant_id: suspendedShop, price: 13 })

    const res = await post(body(shop, strangersProduct))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('product_unavailable')
    expect(await ordersOf(shop)).toHaveLength(0)
  })

  it('refuses a product that is not active', async () => {
    const hidden = await seedProduct({ merchant_id: shop, price: 13, active: false })

    const res = await post(body(shop, hidden))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('product_unavailable')
    expect(await ordersOf(shop)).toHaveLength(0)
  })

  it('refuses a cart id that is not a product id, as a refusal and not a 500', async () => {
    const res = await post(body(shop, productId, { cart: { 'not-a-uuid': 1 } }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('product_unavailable')
  })

  it('derives the shipping fee from the shop rates and the delivery region', async () => {
    await svc().from('merchants').update({ shipping: { WM: 8, EM: 18 } }).eq('id', shop)

    const res = await post(body(shop, productId, {
      mode: 'delivery',
      address: { line1: '1 Jalan Besar', postcode: '88000', city: 'Kota Kinabalu', state: 'Sabah' },
      quotedTotal: 44,   // 26 + EM 18
    }))
    expect(res.status).toBe(200)

    const [order] = await ordersOf(shop)
    expect(Number(order.shipping_fee)).toBe(18)
    expect(Number(order.total)).toBe(44)
  })

  it('derives the voucher discount, and records it against the order', async () => {
    await svc().from('vouchers').insert({
      merchant_id: shop, code: 'SAVE10', kind: 'percent', amount: 10, used_by: [],
    })

    const res = await post(body(shop, productId, {
      voucherCode: 'SAVE10',
      voucherEntry: 'ah@meng.com',
      quotedTotal: 23.4,   // 26 − 10%
    }))
    expect(res.status).toBe(200)

    const [order] = await ordersOf(shop)
    expect(Number(order.discount)).toBe(2.6)
    expect(Number(order.total)).toBe(23.4)
    expect(order.voucher_code).toBe('SAVE10')
  })
})
```

The cross-tenant case reuses the suite's existing `suspendedShop` fixture, so no new merchant and no change to `SLUGS`. `afterAll` already resets it, and `resetMerchant` already deletes `products`.

- [ ] **Step 3: Run them and watch them fail**

```bash
pnpm --filter @bitetime/backend test:db -- orders
```

Expected: FAIL. The new cases fail because the backend still trusts the body; the rewritten existing cases fail because `PlaceOrderInput` has no `cart`.

(A running local Supabase is required: `cd apps/backend && supabase start`.)

- [ ] **Step 4: Rewrite `orders.ts`**

Replace the imports, the error codes and `PlaceOrderInput`:

```ts
import type postgres from 'postgres'
import { priceOrder, voucherFromRow } from '@bitetime/shared'
import type { PricedProduct, PricedVoucher } from '@bitetime/shared'
import { withTransaction } from './db.js'
import { COUNTER_START, formatOrderNumber, orderDay } from './orderNumber.js'

export type OrderErrorCode =
  | 'merchant_not_found'
  | 'merchant_inactive'
  | 'voucher_not_found'
  | 'voucher_already_used'
  | 'voucher_fully_used'
  | 'voucher_entry_required'
  | 'price_changed'
  | 'product_unavailable'

export interface PlaceOrderInput {
  merchantId: string
  /** From the verified JWT, or null for a guest. NEVER from the request body — see below. */
  userId: string | null
  customerName: string
  customerWa: string
  mode: string
  address?: unknown
  /** What they want, not what it costs. `{ [productId]: qty }`. */
  cart: Record<string, number>
  /**
   * The total the customer SAW. A confirmation to check, not an input to trust: the order
   * commits at the price this function derives, and only when the two agree.
   */
  quotedTotal: number
  voucherCode?: string | null
  voucherEntry?: string | null
}
```

Keep the existing `OrderError` class as it is. Extend `placeOrder`'s docstring with the new invariant and replace its body:

```ts
/**
 * Take an order: bump the shop's daily counter, claim the voucher, PRICE THE ORDER and insert
 * it — all in ONE transaction, so they commit together or not at all.
 *
 * [… keep the existing paragraphs about the three-calls-and-a-swallowed-error history …]
 *
 * THREE INVARIANTS ARE ENFORCED HERE AND NOWHERE ELSE, because db.ts connects as the database
 * owner and no RLS policy runs on it:
 *
 *   * The CHECKOUT GATE — the shop exists and is active, asserted before anything is written.
 *   * ATTRIBUTION — `userId` comes from the verified JWT. [… keep the existing paragraph …]
 *   * THE PRICE — every number on the order row is derived HERE, from the products, the shop's
 *     shipping rates and the claimed voucher. The body carries a cart and the total the
 *     customer saw; it carries no prices. It used to carry `total`, and a client could simply
 *     POST `total: 0` and have the order commit at zero. A price the caller can state is not a
 *     price. The quote is checked, never trusted: disagree with it and the order is REFUSED
 *     (`price_changed`), never silently re-priced upward — a customer must not be charged a
 *     number they did not see.
 */
export function placeOrder(input: PlaceOrderInput, now = new Date()): Promise<{ orderNumber: string }> {
  return withTransaction(async (tx) => {
    const merchant = await assertOrderableMerchant(tx, input.merchantId)
    const day = orderDay(now)

    // Scoped to this merchant, and that predicate is the ONLY thing keeping a stranger's
    // product out of this cart: no RLS runs on this connection.
    const products = await cartProducts(tx, input.merchantId, input.cart)

    // Order matters for deadlock-freedom, not for correctness: every transaction takes the
    // counter row before the voucher row, so two concurrent orders can never hold one and
    // wait on the other.
    const orderNumber = formatOrderNumber(merchant.order_prefix, day, await nextCounterValue(tx, input.merchantId, day))

    // The claim and the discount read the same locked row, so the voucher that is spent is
    // exactly the voucher that was priced.
    const voucher = input.voucherCode
      ? await claimVoucher(tx, input.merchantId, input.voucherCode, input.voucherEntry ?? '')
      : null

    const bd = priceOrder({
      products,
      cart: input.cart,
      mode: input.mode as 'pickup' | 'delivery' | 'sameday',
      // Read off the address that is actually being shipped to, so the region that sets the
      // rate and the region on the parcel cannot disagree.
      state: deliveryState(input.mode, input.address),
      rates: merchant.rates,
      voucher,
      now,
    })

    assertQuoteHolds(bd.total, input.quotedTotal)

    const items = bd.lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, price: l.unitPrice }))
    const discount = bd.discount > 0 ? bd.discount : null

    await tx`
      insert into orders (
        merchant_id, user_id, customer_name, customer_wa, mode, address,
        shipping_fee, items, total, currency, discount, voucher_code, order_number, status
      ) values (
        ${input.merchantId},
        ${input.userId},
        ${input.customerName},
        ${input.customerWa},
        ${input.mode},
        ${tx.json((input.address ?? null) as never)},
        ${bd.shipping},
        ${tx.json(items as never)},
        ${bd.total},
        ${merchant.currency},
        -- The code is recorded only when it actually bought a discount, mirroring the insert
        -- the browser used to make.
        ${discount},
        ${discount ? (input.voucherCode ?? null) : null},
        ${orderNumber},
        -- Hardcoded, never taken from the caller. A client could otherwise file an order that
        -- is already 'completed' — which the insert policy used to prevent and no longer can,
        -- because no policy runs on this connection.
        'new'
      )
    `

    return { orderNumber }
  })
}
```

Now the four new helpers. `assertOrderableMerchant` grows a return shape — it already reads the merchant row, and the rates and currency are on it:

```ts
interface OrderableMerchant {
  order_prefix: string
  rates: { WM: number; EM: number }
  currency: string
}

/**
 * The intake gate: is this shop allowed to take an order at all? Returns what pricing it
 * needs, or throws.
 *
 * Deliberately NOT called the "Checkout gate" — CONTEXT.md already gives that name to the
 * sign-in / create-account / continue-as-guest step, which is a different thing in a
 * different layer.
 */
async function assertOrderableMerchant(tx: postgres.TransactionSql, merchantId: string): Promise<OrderableMerchant> {
  const rows = await tx<{ order_prefix: string; status: string; shipping: { WM?: unknown; EM?: unknown } | null; currency: string | null }[]>`
    select order_prefix, status::text, shipping, currency from merchants where id = ${merchantId}
  `
  const merchant = rows[0]
  if (!merchant) throw new OrderError('merchant_not_found')
  if (merchant.status !== 'active') throw new OrderError('merchant_inactive')
  return {
    order_prefix: merchant.order_prefix,
    rates: {
      WM: Number(merchant.shipping?.WM ?? 0),
      EM: Number(merchant.shipping?.EM ?? 0),
    },
    currency: merchant.currency ?? 'MYR',
  }
}

/** `products.id` is a uuid. A cart key that is not one cannot name a product. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The cart's products, scoped to this merchant and to what is actually on sale.
 *
 * An id that comes back missing is REFUSED, not dropped: a cart quietly shrinking to the
 * products that happen to exist would commit an order the customer never placed, at a total
 * they never saw.
 *
 * The ids are shape-checked before they reach the query, and that is not fussiness: the
 * comparison casts to `uuid[]`, so a cart key of `'nope'` would raise a Postgres cast error
 * and surface as a 500 — a bad request dressed up as a server fault. It is a refusal, and the
 * client is told so.
 *
 * `Number(row.price)` is not defensive either. postgres.js returns `numeric` as a STRING to
 * preserve precision, so `price` arrives as '13.00' and would reach round2's `.toFixed()`
 * and throw.
 */
async function cartProducts(
  tx: postgres.TransactionSql,
  merchantId: string,
  cart: Record<string, number>,
): Promise<PricedProduct[]> {
  const ids = Object.keys(cart).filter(id => (cart[id] ?? 0) > 0)
  if (ids.length === 0) throw new OrderError('product_unavailable')
  if (!ids.every(id => UUID.test(id))) throw new OrderError('product_unavailable')

  const rows = await tx<{ id: string; name: string; price: string }[]>`
    select id, name, price from products
    where merchant_id = ${merchantId} and id = any(${ids}::uuid[]) and active
  `
  // Every requested id must have come back. Fewer means one is another shop's, inactive, or
  // gone — and we cannot tell the customer WHICH without leaking whether a stranger's product
  // id exists, so all three are one refusal.
  if (rows.length !== ids.length) throw new OrderError('product_unavailable')

  return rows.map(r => ({ id: r.id, name: r.name, price: Number(r.price) }))
}

/** The state that sets the shipping region — only a delivery has one. */
function deliveryState(mode: string, address: unknown): string | null {
  if (mode !== 'delivery') return null
  if (!address || typeof address !== 'object') return null
  const state = (address as Record<string, unknown>).state
  return typeof state === 'string' && state ? state : null
}

/**
 * The quote the customer confirmed must be the price they are charged.
 *
 * Compared in cents: both sides are already round2'd, so an exact integer-cent comparison is
 * the honest one — a float `===` would refuse orders over a phantom 0.000001.
 *
 * A mismatch is a REFUSAL, not a correction. The shop's prices moved under a customer who is
 * mid-checkout; committing at the new number would charge them something they never agreed to,
 * and committing at the old one would let a stale quote buy a discount. The storefront
 * re-prices and asks them again.
 */
function assertQuoteHolds(computed: number, quoted: number): void {
  const cents = (n: number) => Math.round(n * 100)
  if (!Number.isFinite(quoted) || cents(computed) !== cents(quoted)) {
    throw new OrderError('price_changed')
  }
}
```

Finally, `claimVoucher` must **return** the voucher it claimed — the same locked row the discount is then computed from, so the voucher that is spent is the voucher that was priced. Change its signature and its final lines; the lock, the entry check and the three refusals are unchanged:

```ts
async function claimVoucher(
  tx: postgres.TransactionSql,
  merchantId: string,
  code: string,
  rawEntry: string,
): Promise<PricedVoucher> {
  const entry = (rawEntry ?? '').trim().toLowerCase()
  if (!entry) throw new OrderError('voucher_entry_required')

  // `kind` and `amount` are selected because THIS row is what the order is priced from — the
  // discount must come from the voucher that was locked, not from a second, unlocked read.
  const rows = await tx<{ id: string; code: string; kind: string; amount: string; max_uses: number | null; used_by: string[] }[]>`
    select id, code, kind, amount, max_uses, used_by from vouchers
    where merchant_id = ${merchantId} and code = ${code}
    for update
  `
  const voucher = rows[0]
  if (!voucher) throw new OrderError('voucher_not_found')
  if (voucher.used_by.includes(entry)) throw new OrderError('voucher_already_used')
  if (voucher.max_uses !== null && voucher.used_by.length >= voucher.max_uses) {
    throw new OrderError('voucher_fully_used')
  }

  await tx`
    update vouchers set used_by = used_by || ${tx.json([entry] as never)}
    where id = ${voucher.id}
  `
  return voucherFromRow(voucher as unknown as Record<string, unknown>)
}
```

Keep `nextCounterValue` exactly as it is.

- [ ] **Step 5: Rewrite the route's body validation in `app.ts`**

Replace the validation block and the `placeOrder` call at `apps/backend/src/app.ts:467-527`. The `num` helper and the token handling above it stay; the price fields it validated are gone:

```ts
app.post('/api/orders', async (c) => {
  const bodyJson = await c.req.json().catch(() => null)
  if (!bodyJson || typeof bodyJson !== 'object') return c.json({ error: 'invalid_body' }, 400)

  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  // No token is a guest, not a rejection. A token that is present but bad is also a guest:
  // the alternative is a checkout that dies on an expired session the customer cannot see.
  const user = token ? await getUserFromToken(token) : null

  const b = bodyJson as Record<string, unknown>

  // A cart is ids → positive whole quantities. Reject a malformed one rather than coercing it:
  // `Number('abc')` is NaN, which sails past TypeScript, reaches Postgres and comes back a 500
  // — a bad request dressed up as a server fault.
  const isCart = (v: unknown): v is Record<string, number> =>
    !!v && typeof v === 'object' && !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every(
      q => typeof q === 'number' && Number.isInteger(q) && q > 0,
    ) &&
    Object.keys(v as Record<string, unknown>).length > 0

  const quotedTotal = typeof b.quotedTotal === 'number' && Number.isFinite(b.quotedTotal)
    ? b.quotedTotal
    : null

  if (
    typeof b.merchantId !== 'string' || !b.merchantId ||
    typeof b.customerName !== 'string' ||
    typeof b.customerWa !== 'string' ||
    typeof b.mode !== 'string' ||
    !isCart(b.cart) ||
    quotedTotal === null
  ) {
    return c.json({ error: 'invalid_body' }, 400)
  }

  try {
    const result = await placeOrder({
      merchantId: b.merchantId,
      userId: user?.id ?? null,
      customerName: b.customerName,
      customerWa: b.customerWa,
      mode: b.mode,
      address: b.address ?? null,
      cart: b.cart,
      quotedTotal,
      voucherCode: typeof b.voucherCode === 'string' ? b.voucherCode : null,
      voucherEntry: typeof b.voucherEntry === 'string' ? b.voucherEntry : null,
    })
    return c.json(result)
  } catch (err) {
    // A refusal the customer can act on — a closed shop, a spent voucher, a price that moved —
    // carries its code so the storefront can say which, and can offer the right retry. Anything
    // else is a bug, and must not be dressed up as a domain error the customer can "fix".
    if (err instanceof OrderError) {
      return c.json({ error: err.code }, err.code === 'merchant_not_found' ? 404 : 409)
    }
    console.error('Order intake failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'order_failed' }, 500)
  }
})
```

Update the comment block above the route (`app.ts:459-466`) to add the price rule:

```ts
// ── Order intake — counter, voucher, PRICE and order in ONE transaction ───────
// The JWT is OPTIONAL: guest checkout is a first-class path and must keep working.
//
// The body carries a cart and the total the customer saw. It carries NO prices: every number
// on the order is derived from Postgres inside placeOrder. It used to carry `total`, which
// meant any client could POST total: 0 and have the order commit at zero.
//
// Attribution comes from the token and from nowhere else. `user_id` is never read from the
// body — see placeOrder's contract for why that is a security property rather than a tidiness
// one.
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
pnpm --filter @bitetime/backend test:db -- orders
```

Expected: PASS, including every pre-existing rollback, concurrency, attribution and intake-gate assertion. Then the whole DB suite, because `tests/api/db.test.ts` and the RLS suites share the schema:

```bash
pnpm --filter @bitetime/backend test:db
pnpm typecheck && pnpm lint
```

Expected: PASS. Typecheck will still fail in `apps/frontend` if you have not done Task 4 — `store.ts` is still sending the old body. That is expected here; Task 4 closes it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(orders): the backend derives the price; the body only quotes it

placeOrder took items, total, shippingFee, discount and currency from the request
body and trusted them — a client could POST total: 0 and the order committed at
zero. It now takes a cart and the total the customer saw, and derives every number
from the products, the shop's shipping rates and the voucher it locked. The quote is
checked, never trusted: a disagreement refuses with price_changed rather than
charging a number the customer never saw.

The merchant_id predicate on the product lookup is load-bearing — db.ts is
RLS-exempt, so it is the only thing keeping a stranger's product out of the cart."
```

---

### Task 4: The browser sends a cart, not a price

**Files:**
- Modify: `apps/frontend/src/store.ts:522-605` (`OrderErrorCode`, `placeOrder`)
- Modify: `apps/frontend/src/store/Storefront.tsx:276-330`

**Interfaces:**
- Consumes: the wire contract from Task 3 — `{ merchantId, customerName, customerWa, mode, address, cart, quotedTotal, voucherCode, voucherEntry }`, and the codes `price_changed` / `product_unavailable`.
- Produces: `placeOrder({ merchantId, customerName, customerWa, mode, address, cart, quotedTotal, voucherCode, voucherEntry })`.

- [ ] **Step 1: Twin the new codes in `store.ts`**

`apps/frontend/src/store.ts:528` — the type is a deliberate twin of the backend's, and the comment above it says a new code must get a customer-facing message or the customer is told "something went wrong" for a refusal we know the reason for. Add both:

```ts
export type OrderErrorCode =
  | 'merchant_not_found'
  | 'merchant_inactive'
  | 'voucher_not_found'
  | 'voucher_already_used'
  | 'voucher_fully_used'
  | 'voucher_entry_required'
  | 'price_changed'
  | 'product_unavailable'
```

- [ ] **Step 2: Send a cart and a quote**

Replace `placeOrder`'s signature and body in `apps/frontend/src/store.ts`. Its docstring keeps the three-calls history and gains the price rule:

```ts
/**
 * Place an order: ONE call, which commits the order number, the order row, the voucher claim
 * and THE PRICE in a single transaction server-side.
 *
 * [… keep the existing paragraphs about the three trips and the swallowed redemption …]
 *
 * We send what the customer WANTS (the cart) and what they SAW (`quotedTotal`) — never what it
 * costs. The backend derives every number from its own rows; sending a total would mean any
 * client could name its own. If the backend's price disagrees with our quote it refuses with
 * `price_changed` rather than charging a number the customer never confirmed.
 */
export async function placeOrder({ merchantId, customerName, customerWa, mode, address, cart, quotedTotal, voucherCode, voucherEntry }: {
  merchantId: string
  customerName: string
  customerWa: string
  mode: string
  address?: AddressParts | string
  cart: Record<string, number>
  quotedTotal: number
  voucherCode?: string | null
  voucherEntry?: string | null
}) {
  // Optional: a guest has no session, and guest checkout is a first-class path.
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token

  // `fetch` REJECTS on a network or CORS failure rather than returning a non-ok response, so
  // an offline customer would otherwise get a raw "Failed to fetch" on the checkout screen.
  const res = await fetch(`${API_URL}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      merchantId, customerName, customerWa, mode, address,
      cart, quotedTotal, voucherCode, voucherEntry,
    }),
  }).catch(() => null)
  if (!res) throw new OrderError('network')

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}))
    throw new OrderError(payload?.error ?? 'order_failed')
  }
  return (await res.json()) as { orderNumber: string }
}
```

- [ ] **Step 3: Update the Storefront's call site**

`apps/frontend/src/store/Storefront.tsx:276`. The cart is filtered to what is actually in it — a zeroed line is not an order line, and the backend refuses a cart entry with a quantity it cannot fulfil:

```ts
      const result = await placeOrder({
        merchantId: merchant.id,
        customerName: name.trim(),
        customerWa: wa.trim(),
        mode,
        address: mode === 'delivery' ? address : '',
        // What they want, and what they saw. Never what it costs: the shop's own rows are the
        // only thing that may say that, and `bd` is only ever a quote.
        cart: Object.fromEntries(Object.entries(cart).filter(([, qty]) => qty > 0)),
        quotedTotal: total,
        voucherCode: appliedVoucher?.code ?? null,
        voucherEntry: appliedVoucher ? voucherEntry : null,
      })
```

`cartItems`, `subtotal`, `fee`, `discount` and `total` are still derived from `bd` and still drive the summary and the success screen — that is unchanged, and correct: after a 200 the backend's price and the quote are known to agree, because the backend refused otherwise.

- [ ] **Step 4: Handle the two new refusals**

In the same file's `catch` block (`Storefront.tsx:303`), add two branches before the final `else`. `fetchProducts` and `setProducts` are already in scope:

```ts
      } else if (code === 'price_changed') {
        // The shop's prices moved while they were checking out. NOTHING was written. Show them
        // the new numbers and let them decide — charging the new total silently would bill a
        // number they never agreed to, and honouring the stale one would let an old quote buy a
        // discount the shop withdrew.
        const fresh = await fetchProducts(merchant.id).catch(() => null)
        if (fresh) setProducts(fresh)
        const msg = t(
          'Prices at this shop just changed. Please review your order and place it again.',
          '本店价格刚刚有所调整，请确认订单后重新下单。',
        )
        setError(msg)
        toast.error(msg)
      } else if (code === 'product_unavailable') {
        // Something in the cart stopped being on sale mid-checkout. Refetch so the menu tells
        // the truth, and let them rebuild the cart rather than guessing which item it was.
        const fresh = await fetchProducts(merchant.id).catch(() => null)
        if (fresh) setProducts(fresh)
        const msg = t(
          'Something in your cart is no longer available. Please check your order and try again.',
          '购物车中有商品已下架，请检查订单后重试。',
        )
        setError(msg)
        toast.error(msg)
      } else if (code === 'network') {
```

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass. Typecheck now covers both sides of the wire.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(storefront): send the cart and the quote, never the price

The browser now tells the backend what the customer wants and what they saw, and
the backend says what it costs. A price that moved mid-checkout comes back as
price_changed: the menu is refetched and the customer decides, rather than being
billed a number they never confirmed."
```

---

### Task 5: Run the app, and say so in the docs

CLAUDE.md: UI is verified by running the app, not by component tests. This is that step, and it is not optional — the whole checkout path changed shape.

**Files:**
- Modify: `CONTEXT.md` (the **Order pricing** section)

- [ ] **Step 1: Drive a real checkout**

With local Supabase up (`cd apps/backend && supabase start`) and `pnpm dev` running, place a real order through a storefront at `/s/<slug>`: pickup with two items, then a delivery to a Sabah postcode, then one with a percent voucher applied. For each, confirm the total on the success screen matches the `orders` row (`select total, shipping_fee, discount, items from orders order by created_at desc limit 1`).

Then force the refusal: with the checkout open and a cart priced, change a product's price in the merchant dashboard in another tab, and place the order. Expect the "Prices at this shop just changed" message, no order row, and — critically — **no burnt counter slot** (`select value from order_counters where merchant_id = …` is unchanged).

- [ ] **Step 2: Update CONTEXT.md**

In `CONTEXT.md` → **Order pricing**, replace the first paragraph's opening sentence and add the authority rule. The existing "two of `priceOrder`'s inputs have no caller" paragraph **stays** — it is still true until #69 and #70 land — but its promo half is corrected, because promo is unbuilt rather than unwired:

```markdown
## Order pricing

The deep, pure module (`packages/shared/src/pricing.ts`) that turns a cart + context into a
money breakdown. Single source of truth for every total the app **shows** and every total the
backend **charges** — it lives in `@bitetime/shared` for exactly that reason. Owns shipping-region
selection, promo price resolution, voucher discount, and referral discount — in that order. No
I/O: the clock, the loaded voucher and the resolved referral are all passed in.

**The backend is the price authority.** The Storefront's `priceOrder` call is a *quote*, for
display; the backend's, inside the order transaction, is the *charge*. `POST /api/orders`
carries a cart and `quotedTotal` — the number the customer saw — and no prices at all: `items`,
`total`, `shipping_fee`, `discount` and `currency` are every one derived from the shop's own
rows. The quote is **checked, never trusted**. A disagreement is refused (`price_changed`) and
the transaction rolls back: a customer is never charged a number they did not confirm, and a
stale quote never buys a withdrawn discount. Before this, a client could POST `total: 0` and the
order committed at zero.

- **`priceOrder(input) -> PriceBreakdown`** — the one interface, called on both sides of the wire.
  Returns `{ lines, subtotal, shipping, discount, referralDiscount, total }`. The `lines` carry
  resolved unit prices, so the order row, the success screen and the Telegram message consume the
  breakdown instead of re-deriving it.
- **`voucherError(voucher, ctx) -> string | null`** — pure voucher rules. The **browser's**
  pre-flight only; the backend enforces redemption under a row lock in `claimVoucher` instead.
  Three of its six codes can never fire — see #71.
- **`voucherFromRow(row) -> PricedVoucher`** — the `vouchers` row → domain mapping, shared because
  both sides price from the same rows. Coerces `amount`, which postgres.js returns as a string.
- **`effectivePrice(product, now, sold)`** — promo resolution (`promoActive` by date and quantity
  limit).

Promo is **unbuilt**, not unwired: `products` has no `promo_price`/`promo_limit`/`promo_end`
column and the dashboard offers no promo field, so `promoActive` is always false and no merchant
has ever been able to set a promo, capped or otherwise (#69). The `referral` input likewise has no
caller, so `referralDiscount` is always 0 (#70). Do not read either as live behaviour.

Discount order is load-bearing: voucher applies to items+shipping, then referral applies to the
post-voucher total (`min(amount, totalAfterVoucher)`). Rounding is `parseFloat(toFixed(2))` per
step, and the quote/charge comparison is made in whole cents.
```

- [ ] **Step 3: Full verification**

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @bitetime/backend test:db
```

Expected: all pass. Do not claim completion on any suite you have not watched pass.

- [ ] **Step 4: Commit and open the PR**

```bash
git add -A
git commit -m "docs: the backend is the order's price authority

CONTEXT.md said priceOrder was the source of truth for every total the app shows. It
is now also the source of every total the backend charges, which is why it moved into
@bitetime/shared. Corrects the promo caveat: promo is unbuilt, not unwired — no
columns, no dashboard field, so no merchant ever set one."
```

Open the PR against `main`, referencing #68 and noting that #69 (promo) is unblocked by it.
