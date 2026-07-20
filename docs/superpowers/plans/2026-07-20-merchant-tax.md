# Merchant Tax Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant charge a configurable tax rate, added on top of the order, priced identically in the browser and in the order transaction.

**Architecture:** Tax is one more step in the single pure pricing module (`packages/shared/src/pricing.ts`), which both the storefront (to quote) and the backend (to charge) call. The rate lives in two new `merchants` columns read by the order transaction's existing `select`, and is snapshotted onto the order row so a later rate change cannot repaint old receipts. No new endpoint, no new refusal code — a stale quote against a changed rate lands on the existing `price_changed` path.

**Tech Stack:** pnpm + Turborepo, TypeScript everywhere, React 19 + Vite (frontend), Hono + postgres.js (backend), Supabase/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-20-merchant-tax-design.md`
**Issue:** [#88](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/88)
**Branch:** `feat/tax-settings` (already created, spec already committed on it)

## Global Constraints

1. **Tax is exclusive**: menu prices are pre-tax, tax is added on top as its own line.
2. **Taxable base is `subtotal − discount`**, clamped at 0. Shipping is never taxed. The *discount* itself is still computed on `subtotal + shipping` — unchanged from today.
3. **`shopTax` is the single mapper** from a merchant row to `{ enabled, rate }`, called on **both** sides of the wire. Fallback is always **off, rate 0**.
4. **The render gate is `tax_rate > 0`, never `tax > 0`** — a fully-discounted order at a taxed shop must still print `Tax (8%) 0.00`.
5. **Tax is never accepted from a request body.** It is derived inside the order transaction, like `total`.
6. **postgres.js returns `numeric` as a string; PostgREST returns a number.** Every numeric read goes through the module's `num()` coercion or an equivalent.
7. Rate is a **percentage number**: `6` means 6%. Never a fraction.
8. Bilingual strings go through `t(english, chinese)` — no i18n library, no label column.
9. Run all commands from the repo root unless stated.
10. Adding a migration file does **not** apply it — `pnpm --filter @bitetime/backend db:migrate` does.

---

### Task 1: Tax in the pricing rule

**Files:**
- Modify: `packages/shared/src/pricing.ts` (add `shopTax`, extend `PriceInput` / `PriceBreakdown`, extend `priceOrder`)
- Test: `packages/shared/src/pricing.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface ShopTax { enabled: boolean; rate: number }`
  - `export function shopTax(row: unknown): ShopTax`
  - `PriceInput.tax?: ShopTax`
  - `PriceBreakdown.tax: number` and `PriceBreakdown.taxRate: number`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/pricing.test.ts`. First extend the import at the top of the file (line 3) to include `shopTax`:

```ts
import {
  priceOrder, voucherError, voucherFromRow, shopRates, shopTax, DEFAULT_WM_RATE,
```

Then append these suites at the end of the file:

```ts
describe('tax', () => {
  const products = [{ id: 'a', name: 'Nasi Lemak', price: 10 }]
  const cart = { a: 2 }
  const rates = { WM: 8, EM: 18 }

  it('is absent when no tax is configured — today\'s numbers, unchanged', () => {
    const bd = priceOrder({ products, cart, mode: 'delivery', state: 'Selangor', rates })
    expect(bd.subtotal).toBe(20)
    expect(bd.shipping).toBe(8)
    expect(bd.tax).toBe(0)
    expect(bd.taxRate).toBe(0)
    expect(bd.total).toBe(28)
  })

  it('is absent when tax is configured but disabled', () => {
    const bd = priceOrder({
      products, cart, mode: 'pickup', rates,
      tax: { enabled: false, rate: 6 },
    })
    expect(bd.tax).toBe(0)
    expect(bd.taxRate).toBe(0)
    expect(bd.total).toBe(20)
  })

  it('adds tax on the subtotal, and never on shipping', () => {
    const bd = priceOrder({
      products, cart, mode: 'delivery', state: 'Selangor', rates,
      tax: { enabled: true, rate: 6 },
    })
    // 6% of 20 = 1.20. The RM8 delivery fee is NOT taxed.
    expect(bd.tax).toBe(1.2)
    expect(bd.taxRate).toBe(6)
    expect(bd.total).toBe(29.2) // 20 + 8 + 1.20
  })

  it('taxes the subtotal AFTER the voucher comes off', () => {
    const bd = priceOrder({
      products, cart, mode: 'pickup', rates,
      voucher: { code: 'X', type: 'fixed', value: 5 },
      tax: { enabled: true, rate: 6 },
    })
    // discount 5 off (20 + 0); taxable base 20 − 5 = 15; tax 0.90
    expect(bd.discount).toBe(5)
    expect(bd.tax).toBe(0.9)
    expect(bd.total).toBe(15.9)
  })

  it('never charges a negative tax when the voucher exceeds the subtotal', () => {
    const bd = priceOrder({
      products, cart, mode: 'delivery', state: 'Selangor', rates,
      voucher: { code: 'X', type: 'fixed', value: 25 },
      tax: { enabled: true, rate: 6 },
    })
    // discount is min(25, 20 + 8) = 25, which is MORE than the 20 subtotal.
    // Base clamps to 0 — an unclamped base would be a tax that pays the customer.
    expect(bd.discount).toBe(25)
    expect(bd.tax).toBe(0)
    expect(bd.total).toBe(3)
  })

  it('rounds tax to cents', () => {
    const bd = priceOrder({
      products: [{ id: 'a', name: 'Kopi', price: 3.33 }], cart: { a: 1 },
      mode: 'pickup', rates,
      tax: { enabled: true, rate: 6 },
    })
    expect(bd.tax).toBe(0.2) // 3.33 * 0.06 = 0.1998
    expect(bd.total).toBe(3.53)
  })

  it('carries a fractional rate through to the breakdown', () => {
    const bd = priceOrder({
      products, cart, mode: 'pickup', rates,
      tax: { enabled: true, rate: 6.5 },
    })
    expect(bd.taxRate).toBe(6.5)
    expect(bd.tax).toBe(1.3)
  })
})

describe('shopTax', () => {
  it('reads an enabled rate off a merchant row', () => {
    expect(shopTax({ tax_enabled: true, tax_rate: 6 })).toEqual({ enabled: true, rate: 6 })
  })

  it('is OFF for a shop that never configured tax', () => {
    const off = { enabled: false, rate: 0 }
    expect(shopTax(null)).toEqual(off)
    expect(shopTax(undefined)).toEqual(off)
    expect(shopTax({})).toEqual(off)
    expect(shopTax('nonsense')).toEqual(off)
  })

  it('is OFF when the flag is false, even with a rate stored', () => {
    expect(shopTax({ tax_enabled: false, tax_rate: 6 })).toEqual({ enabled: false, rate: 6 })
  })

  it('coerces the string a postgres.js numeric arrives as', () => {
    // postgres.js hands back '6.00'; PostgREST hands back 6. Two sides mapping
    // differently is a refused checkout for every order at the shop.
    expect(shopTax({ tax_enabled: true, tax_rate: '6.00' })).toEqual({ enabled: true, rate: 6 })
    expect(shopTax({ tax_enabled: true, tax_rate: '6.50' })).toEqual({ enabled: true, rate: 6.5 })
  })

  it('fails to NO tax on an unparseable rate, never to a number nobody chose', () => {
    expect(shopTax({ tax_enabled: true, tax_rate: 'abc' })).toEqual({ enabled: false, rate: 0 })
    expect(shopTax({ tax_enabled: true, tax_rate: null })).toEqual({ enabled: false, rate: 0 })
  })

  it('treats an enabled 0% as no tax', () => {
    expect(shopTax({ tax_enabled: true, tax_rate: 0 })).toEqual({ enabled: false, rate: 0 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @bitetime/shared test
```

Expected: FAIL — `shopTax is not a function`, and the `tax` suite fails on `bd.tax` being `undefined`.

- [ ] **Step 3: Implement**

In `packages/shared/src/pricing.ts`, add the type to `PriceBreakdown` (which currently ends at `total: number`):

```ts
export interface PriceBreakdown {
  lines: PriceLine[]
  subtotal: number
  shipping: number
  discount: number
  /** Money. 0 when the shop charges no tax. */
  tax: number
  /** The percentage that produced `tax` — 6 means 6%. 0 when the shop charges no tax.
   *  Stored on the order and used to LABEL the line, because `tax` alone cannot say "6%". */
  taxRate: number
  total: number
}
```

Add to `PriceInput`, after `voucher`:

```ts
  /** The shop's tax, mapped through `shopTax`. Absent means no tax. */
  tax?: ShopTax
```

Add the `ShopTax` type and mapper next to `shopRates`:

```ts
export interface ShopTax {
  enabled: boolean
  /** A PERCENTAGE, not a fraction: 6 means 6%. */
  rate: number
}

/**
 * A merchant row → the tax `priceOrder` charges. The twin of `shopRates`, and it exists for
 * the same reason: the browser quotes and the backend charges, and a disagreement between
 * them is not a rounding gap — it is a `price_changed` refusal for every order at that shop.
 *
 * The fallback is always OFF, rate 0. A shop that never configured tax must never grow one,
 * and an unparseable rate must fail to NO tax rather than to a number nobody chose — the
 * same direction `shopRates` fails in, for the same reason.
 *
 * `num()` is not defensiveness: postgres.js returns `numeric` as a STRING ('6.00') while
 * PostgREST returns a number (6).
 *
 * An enabled 0% is normalised to disabled. They charge the same money, and collapsing them
 * here means every consumer has ONE thing to test instead of two that must agree.
 */
export function shopTax(row: unknown): ShopTax {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const rate = num(r.tax_rate)
  if (rate === null || rate <= 0) return { enabled: false, rate: 0 }
  return { enabled: r.tax_enabled === true, rate }
}
```

In `priceOrder`, replace the block from `const beforeDiscount` to the `return`:

```ts
  const beforeDiscount = subtotal + shipping
  const discount = voucherDiscount(input.voucher, beforeDiscount)

  // Tax is the LAST step, and its base is `subtotal − discount` — NOT `beforeDiscount`.
  // Shipping is not taxed (the shop sells food, the courier sells delivery), and the customer
  // is not taxed on money a voucher took off. The clamp is not defensiveness: a fixed voucher
  // is `min(value, subtotal + shipping)`, so it CAN exceed the subtotal alone — and an
  // unclamped base is then a NEGATIVE tax, a tax that pays the customer.
  //
  // Note what is NOT changed: `discount` is still computed on `subtotal + shipping`. Moving
  // that base would shift every existing shop's totals for a feature they never turned on.
  const tax = input.tax?.enabled
    ? round2((Math.max(0, round2(subtotal - discount)) * input.tax.rate) / 100)
    : 0
  const taxRate = input.tax?.enabled ? input.tax.rate : 0

  const total = round2(beforeDiscount - discount + tax)

  return { lines, subtotal, shipping, discount, tax, taxRate, total }
```

Export the new symbols from the package barrel if `packages/shared/src/index.ts` re-exports names explicitly rather than with `export *` — check it and add `shopTax` and `ShopTax` alongside `shopRates`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @bitetime/shared test
pnpm typecheck
```

Expected: PASS. `typecheck` may fail in the frontend/backend if either constructs a `PriceBreakdown` literal — fix those by letting `priceOrder` produce it, never by hand-writing the new fields.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/pricing.ts packages/shared/src/pricing.test.ts packages/shared/src/index.ts
git commit -m "feat(pricing): tax on subtotal minus discount, shipping untaxed"
```

---

### Task 2: Schema — the configured rate and the charged rate

**Files:**
- Create: `apps/backend/supabase/migrations/20260720140000_merchant_tax.sql`
- Modify: `apps/frontend/src/types.ts` (`Merchant` and `Order` interfaces)

**Interfaces:**
- Consumes: nothing.
- Produces: `merchants.tax_enabled` (boolean), `merchants.tax_rate` (numeric(5,2)), `orders.tax` (numeric), `orders.tax_rate` (numeric(5,2)). Frontend `Merchant.tax_enabled?: boolean`, `Merchant.tax_rate?: number | string`, `Order.tax?: number`, `Order.tax_rate?: number`.

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260720140000_merchant_tax.sql`:

```sql
-- Merchant-configurable tax (#88).
--
-- Real columns rather than a key in the `config` jsonb: the order transaction already does
-- `select order_prefix, status, shipping, currency, config, timezone from merchants`, so two
-- more columns cost nothing at read time and buy a CHECK constraint jsonb cannot have.
--
-- Defaults are OFF / 0: every existing shop is a tax-free shop and must stay one.

alter table merchants
  add column tax_enabled boolean not null default false,
  add column tax_rate    numeric(5,2) not null default 0;

alter table merchants
  add constraint merchants_tax_rate_range check (tax_rate >= 0 and tax_rate <= 100);

-- The rate is snapshotted onto the order alongside the amount, NOT derived at read time.
-- A shop moving 6% -> 8% next month must not repaint last month's receipts, and `tax` alone
-- cannot label itself "6%".
--
-- Readers gate the tax line on `tax_rate > 0`, never on `tax > 0`: an 8% shop's fully
-- discounted order has tax = 0 and must still print "Tax (8%) 0.00" rather than look untaxed.
alter table orders
  add column tax      numeric not null default 0,
  add column tax_rate numeric(5,2) not null default 0;

comment on column merchants.tax_rate is 'Percentage: 6 means 6%. Charged only when tax_enabled.';
comment on column orders.tax_rate is 'Percentage charged on THIS order. 0 = no tax was charged.';
```

- [ ] **Step 2: Apply it and verify the columns exist**

```bash
pnpm --filter @bitetime/backend db:migrate
```

Then confirm (requires a running local Supabase — `supabase start` from `apps/backend` if it is not up):

```bash
cd apps/backend && psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
  -c "\d merchants" -c "\d orders" | grep -i tax
```

Expected: four lines showing `tax_enabled`, `tax_rate` on merchants and `tax`, `tax_rate` on orders.

- [ ] **Step 3: Extend the frontend types**

In `apps/frontend/src/types.ts`, add to the `Merchant` interface (find it above `Order`):

```ts
  /** Whether this shop charges tax. See `shopTax` — never read this without it. */
  tax_enabled?: boolean
  /** A PERCENTAGE: 6 means 6%. PostgREST sends a number; read via `shopTax`. */
  tax_rate?: number | string
```

And to `Order`, after `total?: number`:

```ts
  /** Tax charged on this order. 0 on orders placed before tax settings shipped. */
  tax?: number
  /** The percentage that produced `tax`. **Gate the tax line on this, not on `tax`** — a fully
   *  discounted order at a taxed shop has tax 0 and must still show its rate. */
  tax_rate?: number
```

- [ ] **Step 4: Verify the types compile**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/supabase/migrations/20260720140000_merchant_tax.sql apps/frontend/src/types.ts
git commit -m "feat(db): tax_enabled/tax_rate on merchants, tax snapshot on orders"
```

---

### Task 3: Charge the tax in the order transaction

**Files:**
- Modify: `apps/backend/src/orders.ts` (import, `OrderableMerchant`, `assertOrderableMerchant` at ~250-280, `priceOrder` call at ~159, INSERT at ~213-239)
- Modify: `apps/backend/src/writes.ts` (`MERCHANT_CONFIG_FIELDS` and `pickMerchantConfig`)
- Test: `apps/backend/tests/api/orders.test.ts`, `apps/backend/tests/api/writes-merchants.test.ts`

**Interfaces:**
- Consumes: `shopTax`, `ShopTax`, `PriceBreakdown.tax`, `PriceBreakdown.taxRate` from Task 1; the columns from Task 2.
- Produces: orders committed with `tax` / `tax_rate` populated; `tax_enabled` / `tax_rate` accepted by `PATCH /api/merchants/:id`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/tests/api/orders.test.ts`. Match the existing suites' fixture helpers in that file (a shop is created by the same helper the voucher tests at ~429 use — reuse it rather than inventing one; read lines 1-60 for the fixture names before writing).

```ts
describe('tax', () => {
  it('commits tax and the rate that produced it', async () => {
    const shop = await makeShop({ tax_enabled: true, tax_rate: 6 })
    const product = await makeProduct(shop.id, { price: 10 })

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseOrderBody(shop.id),
        cart: { [product.id]: 2 },
        mode: 'pickup',
        quotedTotal: 21.2, // 20 + 6%
      }),
    })
    expect(res.status).toBe(200)

    const row = await orderRow(shop.id)
    expect(Number(row.total)).toBe(21.2)
    expect(Number(row.tax)).toBe(1.2)
    expect(Number(row.tax_rate)).toBe(6)
  })

  it('commits zero tax for a shop that charges none', async () => {
    const shop = await makeShop()
    const product = await makeProduct(shop.id, { price: 10 })

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseOrderBody(shop.id),
        cart: { [product.id]: 2 },
        mode: 'pickup',
        quotedTotal: 20,
      }),
    })
    expect(res.status).toBe(200)

    const row = await orderRow(shop.id)
    expect(Number(row.tax)).toBe(0)
    expect(Number(row.tax_rate)).toBe(0)
  })

  it('refuses a quote computed before the merchant raised the rate', async () => {
    const shop = await makeShop({ tax_enabled: true, tax_rate: 6 })
    const product = await makeProduct(shop.id, { price: 10 })
    await setShopTax(shop.id, { tax_enabled: true, tax_rate: 8 })

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseOrderBody(shop.id),
        cart: { [product.id]: 2 },
        mode: 'pickup',
        quotedTotal: 21.2, // priced at the OLD 6%
      }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('price_changed')
  })

  it('ignores a tax the client puts in the body', async () => {
    const shop = await makeShop({ tax_enabled: true, tax_rate: 6 })
    const product = await makeProduct(shop.id, { price: 10 })

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseOrderBody(shop.id),
        cart: { [product.id]: 2 },
        mode: 'pickup',
        quotedTotal: 21.2,
        tax: 0,
        tax_rate: 0,
      }),
    })
    expect(res.status).toBe(200)

    const row = await orderRow(shop.id)
    expect(Number(row.tax)).toBe(1.2)
    expect(Number(row.tax_rate)).toBe(6)
  })
})
```

`makeShop` in this file does not take tax fields yet — extend its options parameter to pass them through to the merchants insert, and add a `setShopTax(id, patch)` helper beside it that does a direct update. `orderRow(shopId)` should select the newest order for that merchant; if the file already has an equivalent, use that name instead of adding a second one.

Append to `apps/backend/tests/api/writes-merchants.test.ts`:

```ts
it('accepts tax settings from the owner', async () => {
  const res = await ownerPatch(shop.id, { tax_enabled: true, tax_rate: 6 })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.tax_enabled).toBe(true)
  expect(Number(body.tax_rate)).toBe(6)
})

it('refuses a rate outside 0-100 instead of storing it', async () => {
  const res = await ownerPatch(shop.id, { tax_rate: 150 })
  expect(res.status).toBe(400)
})

it('refuses a non-numeric rate', async () => {
  const res = await ownerPatch(shop.id, { tax_rate: 'six' })
  expect(res.status).toBe(400)
})
```

Use the file's existing owner-request helper rather than `ownerPatch` if it is named something else.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @bitetime/backend test:db
```

Expected: FAIL — the committed `tax` is 0 where 1.2 is expected, and the 409 case returns 200.

- [ ] **Step 3: Implement the intake wiring**

In `apps/backend/src/orders.ts`, extend the import on line 2 with `shopTax` and the type:

```ts
import { priceOrder, voucherFromRow, shopRates, shopTax, productFromRow, promoClaims, fulfilmentConfig, isDateSelectable, DEFAULT_TIMEZONE } from '@bitetime/shared'
import type { ShopTax } from '@bitetime/shared'
```

Add to `OrderableMerchant`:

```ts
  tax: ShopTax
```

In `assertOrderableMerchant`, add both columns to the row type and the `select`, and map them:

```ts
  const rows = await tx<{ order_prefix: string; status: string; shipping: unknown; currency: string | null; config: unknown; timezone: string | null; tax_enabled: boolean; tax_rate: unknown }[]>`
    select order_prefix, status::text, shipping, currency, config, timezone, tax_enabled, tax_rate from merchants where id = ${merchantId}
  `
```

and in the returned object, after `currency`:

```ts
    // shopTax, for the same reason as shopRates above: the storefront quotes from this exact
    // function, and the penalty for the two disagreeing is a REFUSAL, not a rounding gap.
    // postgres.js hands `tax_rate` back as a string; the mapper is what knows that.
    tax: shopTax(merchant),
```

In the `priceOrder` call (~line 159), add after `voucher`:

```ts
      tax: merchant.tax,
```

In the INSERT (~line 213), add both columns and both values:

```ts
        shipping_fee, items, total, currency, discount, tax, tax_rate, voucher_code, fulfil_date, order_number, status
```

and in the `values` list, after `${discount},`:

```ts
        -- Derived from the shop's own row inside this transaction, NEVER from the body — the
        -- same rule as `total` and `user_id`. A client-supplied tax is a client-chosen total.
        ${bd.tax},
        ${bd.taxRate},
```

- [ ] **Step 4: Implement the write allowlist**

In `apps/backend/src/writes.ts`, add both fields to `MERCHANT_CONFIG_FIELDS`:

```ts
const MERCHANT_CONFIG_FIELDS = [
  'currency', 'shipping', 'pickup_address', 'payment_bank', 'payment_note', 'config', 'timezone',
  'tax_enabled', 'tax_rate',
] as const
```

and validate the rate inside `pickMerchantConfig`.

`pickMerchantConfig` today only ever *drops* bad input (see the `timezone` line), and dropping a
bad tax rate is the wrong answer here: the merchant hits Save, sees a success toast, and charges
nothing. The column's `CHECK` would answer instead with a 500 from deep inside PostgREST. So the
rate is refused **at the door**, where the merchant is present to see it — which means
`pickMerchantConfig` needs a way to say *no*.

`writes.ts` has no error type and the route does not expect a throw, so return the problem as a
discriminated result rather than throwing. Note the shape: `undefined` means "not being written"
and must pass through untouched, and a present-but-invalid value is **refused, never coerced** —
silently clamping 150 to 100 would charge a rate the merchant never typed.

In `writes.ts`:

```ts
export type PickResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string }

export function pickMerchantConfig(body: any): PickResult {
  const out: Record<string, unknown> = {}
  for (const k of MERCHANT_CONFIG_FIELDS) if (body?.[k] !== undefined) out[k] = body[k]
  if (out.timezone !== undefined && !isTimezone(out.timezone)) delete out.timezone
  if (out.tax_rate !== undefined) {
    const rate = typeof out.tax_rate === 'string' ? Number(out.tax_rate) : out.tax_rate
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return { ok: false, error: 'tax_rate must be a number between 0 and 100' }
    }
    out.tax_rate = rate
  }
  if (out.tax_enabled !== undefined && typeof out.tax_enabled !== 'boolean') {
    return { ok: false, error: 'tax_enabled must be a boolean' }
  }
  return { ok: true, patch: out }
}
```

In `apps/backend/src/app.ts:139-146`:

```ts
app.patch('/api/merchants/:id', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const picked = pickMerchantConfig(await c.req.json().catch(() => ({})))
  if (!picked.ok) return c.json({ error: picked.error }, 400)
  const patch = picked.patch
  if (Object.keys(patch).length === 0) return c.json({ error: 'No updatable fields' }, 400)
  const { data, error } = await admin.from('merchants').update(patch).eq('id', id).select().single()
  if (error) return c.json({ error: 'Update failed' }, 500)
  return c.json(data)
})
```

Update the `MERCHANT_CONFIG_FIELDS` comment above the array to record the new call site (the Tax tab from Task 4 writes `{ tax_enabled, tax_rate }`), since that comment claims to be the exact union of call sites.

Check whether any other file imports `pickMerchantConfig` and adjust it the same way:

```bash
grep -rn "pickMerchantConfig" apps/backend
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @bitetime/backend test:db
pnpm --filter @bitetime/backend test
pnpm typecheck
```

Expected: PASS, all three.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/orders.ts apps/backend/src/writes.ts apps/backend/src/app.ts apps/backend/tests/api/orders.test.ts apps/backend/tests/api/writes-merchants.test.ts
git commit -m "feat(orders): charge and snapshot merchant tax inside the transaction"
```

---

### Task 4: Merchant dashboard — the Tax settings form

**Files:**
- Modify: `apps/frontend/src/merchant/ShopSettings.tsx` (`ShippingTab`, ~lines 100-230)

**Interfaces:**
- Consumes: `shopTax` (Task 1), `Merchant.tax_enabled` / `Merchant.tax_rate` (Task 2), the widened `PATCH /api/merchants/:id` (Task 3).
- Produces: nothing later tasks depend on.

The Tax card goes in the existing Shipping tab rather than a new tab — it is one checkbox and one field, and a tab of its own would be a tab the merchant has to go looking for. It saves through the same `save()` handler and the same `updateMerchantConfig` call.

- [ ] **Step 1: Extend the form state**

In `ShopSettings.tsx`, extend the import from `@bitetime/shared` (it already imports `shopRates`) to include `shopTax`.

Add to the `SettingsFields` type (find it near the top of the file):

```ts
  taxEnabled: boolean
  taxRate: string
```

In `ShippingTab`'s `useState` initialiser, alongside the `shopRates` call:

```ts
    // shopTax, not a local `?? 0`, for the same reason shopRates is used one line up: this form
    // shows the merchant what their shop CHARGES, and the charge is decided by that one function
    // on both sides of the wire.
    const tax = shopTax(merchant!)
    return {
      currency: merchant!.currency ?? DEFAULT_CURRENCY,
      wm: String(rates.WM),
      em: String(rates.EM),
      pickupAddress: merchant!.pickup_address ?? '',
      taxEnabled: tax.enabled,
      taxRate: tax.rate ? String(tax.rate) : '',
    }
```

- [ ] **Step 2: Send the fields on save**

In `save()`, add to the `updateMerchantConfig` body, after `pickup_address`:

```ts
        // A blank rate box is 0, and 0 is "no tax" — the same collapse `shopTax` makes when it
        // reads the row back, so the form cannot save a value it then displays differently.
        // The checkbox is stored as typed: a merchant who unticks it keeps their rate on the
        // row, and reads it back as OFF because `shopTax` gates on the flag.
        tax_enabled: fields.taxEnabled,
        tax_rate: Number(fields.taxRate) || 0,
```

Then extend the "show back what was actually saved" line below it so the rate box reflects the stored value:

```ts
      const applied = {
        ...fields,
        wm: String(shipping.WM),
        em: String(shipping.EM),
        taxRate: Number(fields.taxRate) ? String(Number(fields.taxRate)) : '',
      }
```

- [ ] **Step 3: Add the Tax card**

Insert this card between the Shipping rates card and the Pickup address card in `ShippingTab`'s JSX (`CARD` and `HEADING` are the file's existing class constants):

```tsx
      <div className={CARD}>
        <h3 className={HEADING}>{t('Tax', '税')}</h3>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[14px] text-ink">
            <input
              type="checkbox"
              checked={fields.taxEnabled}
              onChange={e => setFields(f => ({ ...f, taxEnabled: e.target.checked }))}
            />
            {t('Charge tax on orders', '订单收取税费')}
          </label>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-tax-rate">{t('Tax rate (%)', '税率 (%)')}</Label>
            <Input
              id="shop-tax-rate" type="number" step="0.01" min="0" max="100"
              value={fields.taxRate}
              disabled={!fields.taxEnabled}
              onChange={e => setFields(f => ({ ...f, taxRate: e.target.value }))}
              variant="compact"
            />
            {/* Says what the rate DOES, because the base is not obvious: it is charged on the
                food after any voucher, and never on the delivery fee. */}
            <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
              {t('Added on top of your item prices, after any voucher discount. Delivery fees are not taxed.',
                 '在商品价格之上加收，扣除优惠券后计算。运费不征税。')}
            </p>
          </div>
        </div>
      </div>
```

- [ ] **Step 4: Verify it compiles and the dirty-tracking test still passes**

```bash
pnpm typecheck
pnpm --filter @bitetime/frontend test
```

Expected: PASS. `settingsDirty.test.ts` compares `saved` to `fields` structurally, so the two new keys need no change there — if it fails, it is because the test builds a `SettingsFields` literal; add the two keys to that fixture.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/ShopSettings.tsx
git commit -m "feat(dashboard): tax rate and on/off in shop settings"
```

---

### Task 5: Storefront — quote the tax and show the line

**Files:**
- Modify: `apps/frontend/src/store/Storefront.tsx` (import; `priceOrder` call at ~288-306; derived consts at ~309-312; checkout breakdown at ~1137-1155; confirmation screen at ~697-711)

**Interfaces:**
- Consumes: `shopTax`, `PriceBreakdown.tax` / `.taxRate` (Task 1); `Merchant.tax_*` (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Quote with the shop's tax**

Extend the `@bitetime/shared` import in `Storefront.tsx` with `shopTax`.

Add near the `shopRates` line (~151):

```ts
  const tax = shopTax(merchant)
```

Add to the `priceOrder` call, after `voucher: appliedVoucher,`:

```ts
    // The SAME mapper the order transaction charges with. A second reading of these columns
    // here is a second rule, and the customer meets it as a refused checkout (`price_changed`).
    tax,
```

Add to the derived consts (~309-312):

```ts
  const taxAmount = bd.tax
  const taxRate = bd.taxRate
```

- [ ] **Step 2: Add a shared rate formatter**

The rate is rendered in two places in this file (checkout summary, confirmation) plus three in Task 6. Put one formatter in `apps/frontend/src/receipt.ts`, which already owns display-side money helpers:

```ts
/**
 * A tax rate as it is printed: `6`, `6.5`, never `6.00`.
 *
 * `tax_rate` is `numeric(5,2)`, so PostgREST can hand back `6` and postgres.js `'6.00'` for
 * the same shop — the label must not depend on which one arrived.
 */
export function formatTaxRate(rate: number | string | null | undefined): string {
  const n = typeof rate === 'string' ? Number(rate) : rate
  if (n === null || n === undefined || !Number.isFinite(n)) return '0'
  return String(parseFloat(n.toFixed(2)))
}
```

And a test in `apps/frontend/src/receipt.test.ts` (create it if the file does not exist; if it does, append):

```ts
import { describe, it, expect } from 'vitest'
import { formatTaxRate } from './receipt'

describe('formatTaxRate', () => {
  it('trims the trailing zeros a numeric(5,2) carries', () => {
    expect(formatTaxRate(6)).toBe('6')
    expect(formatTaxRate('6.00')).toBe('6')
    expect(formatTaxRate(6.5)).toBe('6.5')
    expect(formatTaxRate('6.50')).toBe('6.5')
  })

  it('falls back to 0 rather than printing NaN%', () => {
    expect(formatTaxRate(null)).toBe('0')
    expect(formatTaxRate(undefined)).toBe('0')
    expect(formatTaxRate('abc')).toBe('0')
  })
})
```

Run it:

```bash
pnpm --filter @bitetime/frontend test
```

Expected: PASS.

- [ ] **Step 3: Render the line in the checkout summary**

In the totals block (~1137-1155), insert between the voucher row and the Total row:

```tsx
                {taxRate > 0 && (
                  <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                    <span className="min-w-0">{t('Tax', '税')} ({formatTaxRate(taxRate)}%)</span>
                    <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(taxAmount, currency)}</span>
                  </div>
                )}
```

Gated on `taxRate`, not `taxAmount` (Global Constraint 4): a cart fully covered by a voucher at a taxed shop shows `Tax (6%) 0.00` rather than a summary that looks untaxed.

Add `formatTaxRate` to the existing `../receipt` import, or create that import if the file has none.

- [ ] **Step 4: Render it on the confirmation screen**

Read `Storefront.tsx:697-711` first — that block renders the placed order's totals. Add the same row there, immediately above its Total row, reading from the same `taxRate` / `taxAmount` consts if they are in scope at that point; if the confirmation renders from a stored order object instead, read `order.tax_rate` / `order.tax` and gate on `(order.tax_rate ?? 0) > 0`.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck
pnpm --filter @bitetime/frontend test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/store/Storefront.tsx apps/frontend/src/receipt.ts apps/frontend/src/receipt.test.ts
git commit -m "feat(storefront): quote tax and show it in the order summary"
```

---

### Task 6: Show the tax on stored orders

**Files:**
- Modify: `apps/frontend/src/store/ReceiptDialog.tsx` (~44-45, ~117-132)
- Modify: `apps/frontend/src/store/OrderHistory.tsx` (~147-148, ~206-218)
- Modify: `apps/frontend/src/merchant/OrdersView.tsx` (~298-314)

**Interfaces:**
- Consumes: `Order.tax` / `Order.tax_rate` (Task 2), `formatTaxRate` (Task 5).
- Produces: nothing.

All three read a stored order row, never a live quote — recomputing a historical order at today's rate is exactly the bug the snapshot exists to prevent. All three gate on `tax_rate > 0`.

Both order read routes use `select('*')` (`app.ts:165` and `:267`), so the new columns arrive with no backend change.

- [ ] **Step 1: ReceiptDialog**

At ~44-45, beside the existing `shipping` / `discount` extraction:

```ts
  const tax = order.tax ?? 0
  const taxRate = order.tax_rate ?? 0
```

In the breakdown (~117-132), insert between the discount row and the total row:

```tsx
            {taxRate > 0 && (
              <MoneyLine label={`${t('Tax', '税')} (${formatTaxRate(taxRate)}%)`} value={money(tax)} />
            )}
```

The comment at ~112-114 claims "subtotal + fee − voucher = total, every term printed" — update it, because that arithmetic now has a fourth term:

```tsx
          {/* Subtotal is stated here and nowhere else in the app: it is what closes the
              arithmetic on a page that has to stand on its own — subtotal + fee − voucher
              + tax = total, every term printed. */}
```

Add `formatTaxRate` to the existing `../receipt` import (the file already imports `receiptSubtotal` from there).

- [ ] **Step 2: OrderHistory**

At ~147-148:

```ts
              const tax = o.tax ?? 0
              const taxRate = o.tax_rate ?? 0
```

In the expanded detail (~206-218), between the discount row and the total, following the row shape already used there:

```tsx
                      {taxRate > 0 && (
                        <DetailLine
                          label={`${t('Tax', '税')} (${formatTaxRate(taxRate)}%)`}
                          value={formatMoney(tax, currency)}
                        />
                      )}
```

Use whatever the surrounding rows actually use — read lines 200-220 and match it exactly rather than introducing a `DetailLine` that may not exist in this file.

- [ ] **Step 3: OrdersView (merchant dashboard order detail)**

At ~298-314, between the discount row and the total row, matching the surrounding markup:

```tsx
                    {selected.tax_rate != null && selected.tax_rate > 0 && (
                      <div className="flex justify-between text-[13px]">
                        <span className="text-rose-muted">{t('Tax', '税')} ({formatTaxRate(selected.tax_rate)}%)</span>
                        <span className="tabular-nums text-ink">{formatMoney(selected.tax ?? 0, orderCurrency)}</span>
                      </div>
                    )}
```

Read lines 294-316 first and copy the exact wrapper classes the shipping and discount rows use.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: PASS, all three.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/store/ReceiptDialog.tsx apps/frontend/src/store/OrderHistory.tsx apps/frontend/src/merchant/OrdersView.tsx
git commit -m "feat(orders): show the charged tax on receipts, history and dashboard"
```

---

### Task 7: Run the app and verify end to end

**Files:** none — verification only. Per CLAUDE.md, UI is verified by running the app, not by component tests.

- [ ] **Step 1: Start the stack**

```bash
cd apps/backend && supabase start
cd ../.. && pnpm --filter @bitetime/backend db:migrate
pnpm dev
```

If the backend appears to run pre-edit code, clear the jiti cache — restarting the dev server alone does not.

- [ ] **Step 2: Walk the merchant path**

Sign in as a merchant → Settings → Shipping tab. The Tax card shows an unticked checkbox and a disabled rate box. Tick it, enter `6`, save. Reload the page: the checkbox is still ticked and the box still reads `6` (not `6.00`).

- [ ] **Step 3: Walk the customer path**

Open that shop's storefront, add two items totalling RM20, choose delivery to a West Malaysia state. The summary reads: Subtotal 20.00, Delivery fee 8.00, Tax (6%) 1.20, Total 29.20 — tax is 6% of 20, **not** of 28.

Apply a RM5 voucher: Tax becomes 0.90 and the Total 24.90.

Place the order. The confirmation shows the same tax line.

- [ ] **Step 4: Check the stored order**

Open the customer's order history and the receipt: both show `Tax (6%) 0.90`, and subtotal + fee − voucher + tax equals the total printed. Open the merchant dashboard's order detail: same numbers.

- [ ] **Step 5: Check that an untaxed shop is untouched**

Order from a shop with tax off. No tax row appears anywhere — summary, confirmation, receipt, history, dashboard — and the total is subtotal + fee − voucher exactly as before.

- [ ] **Step 6: Full suite and push**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @bitetime/backend test:db
git push -u origin feat/tax-settings
```

Expected: all green. Then open a PR referencing #88.

---

## Deliberately out of scope

Do not build these; the spec rules them out:

- Tax-inclusive pricing, or a merchant-selectable inclusive/exclusive mode
- A merchant-named tax label — the line is `t('Tax', '税')`
- Per-product or per-category rates
- Tax on the shipping fee
- Tax reporting or export
- **Any change to the Telegram notification** (`apps/backend/src/notify.ts`) — explicitly excluded
