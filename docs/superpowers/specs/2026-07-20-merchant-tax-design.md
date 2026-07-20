# Merchant tax settings — design

Issue: [#88](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/88) (`feat: tax settings`)
Date: 2026-07-20

## Problem

A shop that must collect tax (Malaysian SST, typically 6%) has nowhere to say so. Every total the
app quotes and every total the backend charges is tax-free, and a merchant who owes tax is
absorbing it out of margin or adding it by hand after the fact.

## Decisions

Settled during brainstorming; each is a fork that was taken deliberately.

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Tax model | **Exclusive** — menu prices are pre-tax, tax is added on top as its own line | *Inclusive* (back-computed out of the price) and *merchant picks a mode* — two code paths and twice the tests, for a mode nobody asked for |
| Taxable base | **`subtotal − discount`** | *Subtotal only* taxes money the customer never paid; *(subtotal + shipping) − discount* taxes the delivery fee, which shops here don't |
| Merchant controls | **Rate + explicit on/off toggle** | A *label* field — the line reads `t('Tax', '税')` through the existing translator; a shop needing "SST" printed can have it later |
| Display | Storefront cart/checkout, order confirmation + customer order history, merchant dashboard order detail | **Telegram notification unchanged** — deliberate |

## Pricing rule

`packages/shared/src/pricing.ts` — the one module both sides price from.

New input on `PriceInput`:

```ts
tax?: { enabled: boolean; rate: number }   // rate is a percentage: 6 means 6%
```

New fields on `PriceBreakdown`: `tax: number`, `taxRate: number`.

```
subtotal    = Σ lineTotal                                   // unchanged
shipping    = as today                                      // unchanged
discount    = voucherDiscount(voucher, subtotal + shipping) // unchanged
taxableBase = max(0, round2(subtotal − discount))
tax         = enabled ? round2(taxableBase × rate / 100) : 0
total       = round2(subtotal + shipping − discount + tax)
```

Three properties are load-bearing:

**The discount is still computed on `subtotal + shipping`.** Only the *tax base* is
`subtotal − discount`. Moving the discount base would change every existing shop's totals for a
feature they did not turn on.

**`max(0, …)` is not defensiveness.** A fixed voucher is `min(value, subtotal + shipping)`, so a
voucher can exceed the subtotal alone — shipping absorbs the rest. Without the clamp that is a
*negative* tax: a voucher that pays the customer.

**Tax is the last step.** It reads no state the rest of the breakdown didn't already have, so the
quote/charge comparison and its single `price_changed` refusal keep working untouched.

`taxRate` rides in the breakdown so the storefront renders `Tax (6%)` from the number that was
actually charged, rather than re-reading the merchant row and risking a label that disagrees with
the money beside it.

### `shopTax`

```ts
export function shopTax(row: unknown): { enabled: boolean; rate: number }
```

The twin of `shopRates`, and it exists for the same reason: both sides of the wire map the merchant
row through one function, because a browser and a backend that disagree on a rate is not a rounding
difference — it is a refused checkout for every order at that shop.

Fallback is **off, rate 0**. A missing column, a null, or an unparseable value all mean *no tax*.
A shop that never configured tax must never grow one, and the failure direction for a number nobody
chose is zero — the same rule that makes a missing `EM` fall back to `WM` and never to 0.

Reuses the existing `num()` coercion: postgres.js returns `numeric` as a **string** (`'6.00'`) while
PostgREST returns a **number** (`6`). Unmapped on one side, that is `'6.00' / 100` arithmetic on a
string, or a rate that reads as truthy garbage.

## Schema

### `merchants` — the configured rate

```sql
alter table merchants
  add column tax_enabled boolean not null default false,
  add column tax_rate    numeric(5,2) not null default 0
    check (tax_rate >= 0 and tax_rate <= 100);
```

Real columns, not `settings` and not the `config` jsonb: the order transaction already does
`select order_prefix, status, shipping, currency, config, timezone from merchants`, so two more
columns cost nothing at read time and buy a `check` constraint jsonb cannot have.
`numeric(5,2)` admits 6.5% and caps at 100.00.

### `orders` — the charged rate, snapshotted

```sql
alter table orders
  add column tax      numeric not null default 0,
  add column tax_rate numeric(5,2) not null default 0;
```

Both are stored, not just the amount. A shop moving 6% → 8% next month must not repaint last
month's receipts, and `tax` alone cannot label itself. Historical orders keep `0`/`0`, which reads
truthfully as *no tax was charged*.

**`tax_rate` is the render gate**, not `tax`. An 8%-shop order whose cart was fully discounted has
`tax = 0` and must still show `Tax (8%) 0.00`; gating on the amount would make the line vanish and
leave a receipt that looks untaxed.

### RLS and grants

No new policy. Both columns ride on rows already governed by existing policies. The merchant writes
`tax_*` through the same dashboard update path that writes `shipping`; the browser holds no `INSERT`
on `orders`, so `tax` is derived inside the transaction and **never read from the request body** —
the same rule that already governs `total`, `user_id` and `promo_sold`. A client-supplied tax is a
client-chosen total.

Migration must be applied with `pnpm --filter @bitetime/backend db:migrate`, or PostgREST's schema
cache will not see the columns.

## Wiring

**Backend** (`apps/backend/src/orders.ts`): the in-transaction merchant `select` gains
`tax_enabled, tax_rate`; the shop context gains `tax: shopTax(merchant)`; that is passed to
`priceOrder`; the order INSERT gains `tax, tax_rate` from `bd.tax` / `bd.taxRate`.

No new endpoint and no new error code. A quote computed against a rate the merchant has since
changed disagrees with the charge and is refused by the existing `price_changed` path — the
customer is shown the new total and confirms it, never quietly charged more.

**Storefront**: the breakdown renders a tax row between discount and total when `bd.taxRate > 0`.
Label `t('Tax', '税')`; the rate is formatted from `bd.taxRate` with trailing zeros trimmed
(`6`, not `6.00`).

**Confirmation, customer order history, merchant dashboard order detail**: these render from the
stored row (`order.tax`, `order.tax_rate`), gated on `tax_rate > 0` per above — not from a live
quote, which would recompute a historical order at today's rate.

**Merchant dashboard settings**: a Tax block beside the shipping rates — a checkbox
(*Charge tax on orders*) and a rate field, the field disabled while unchecked. Saved through the
existing merchant-settings update path.

**Telegram notification: unchanged.**

## Testing

`packages/shared/src/pricing.test.ts`:

- tax off reproduces today's totals **exactly** — the regression that matters most, since every
  existing shop is a tax-off shop
- tax on, no voucher
- tax on with a voucher: asserts the base is `subtotal − discount` and that shipping is untaxed
- a voucher exceeding the subtotal ⇒ `tax === 0`, never negative
- `shopTax` fallbacks: missing, null, `'6'` (string), garbage — each resolving to the documented
  value, and a cross-driver case pinning string-vs-number parity

`apps/backend/tests/api`:

- an order at a taxed shop commits `tax` and `tax_rate` matching the quote
- a quote at the old rate, submitted after the merchant changes it, is refused `price_changed`

UI is verified by running the app (CLAUDE.md), not component tests.

## Out of scope

- Tax-inclusive pricing
- A merchant-named tax label (line is `t('Tax', '税')`)
- Per-product or per-category tax rates
- Tax on the shipping fee
- Tax reporting or export
- Any Telegram message change
