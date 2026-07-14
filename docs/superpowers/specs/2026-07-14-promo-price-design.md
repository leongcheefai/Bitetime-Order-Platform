# A promo price, with a quantity cap that actually binds

**Date:** 2026-07-14
**Issue:** #69 (child of #66; unblocked by #68)
**Status:** approved, not yet implemented

## What exists today: nothing

`pricing.ts` carries a promo branch — `promoActive`, `effectivePrice`, `PriceLine.promo`, a
`promoSold` input. Every one of them is dead:

- `products` has no `promo_price`, `promo_limit`, `promo_end` or `promo_sold` column.
- `Product` declares none; `promoPrice`/`promoLimit`/`promoEnd` survive only through the type's
  `[key: string]: any` and the `as any` casts in `pricing.ts`.
- `ProductsManager` has no promo field.
- Nothing passes `promoSold`.

`promoActive` is therefore always false and `PriceLine.promo` is always false, read by nobody.
This is a **feature to build**, not a wire to reconnect — #66 was wrong to call the uncapped
promo a live merchant-facing defect. A merchant has never been able to set a promo at all.

It is only worth building now because **#68 landed**: the backend derives every price and
refuses a quote it disagrees with. Before that, a cap enforced on the server was decorative —
the browser asserted the total, so anyone could `curl` the promo price whether or not it had
sold out.

## The four decisions

### 1. The cap binds per unit, so a line can split

A cart of 10 against a promo with 3 units left is **3 at the promo price and 7 at the base
price**, not 10 at either. All-or-nothing per line would mean a cap of 3 sells 100 promo units
to a single order, which is not a cap.

The price of this: one cart product can produce **two order lines**, at two prices, and the
`items` jsonb will hold two entries with the same product id. That is the honest record of what
was sold, and the storefront summary, the success screen and the Telegram message all render it
as two lines.

### 2. The server's clock goes on the wire

`priceOrder` runs on both sides since #68: the browser quotes, the backend charges, and a
disagreement is a **hard refusal** (`price_changed`). The promo window is the first rule that
reads a clock — which makes the clock a wire input, and today's two clocks would diverge two
different ways:

- **Timezone.** `new Date(promoEnd + 'T23:59:59')` parses as **local** time. A server in UTC and
  a customer in UTC+8 resolve the same stored string to instants **eight hours apart** — every
  Malaysian customer, on the promo's last day.
- **Skew.** Even with one timezone, a device clock minutes off the server's straddles the
  boundary.

Either one produces the same failure, and it is worse than a wrong price: the browser quotes the
promo, the backend refuses it, the storefront re-prices *with the same skewed clock*, quotes the
promo again, and is refused again — a **permanent refusal loop** for a legitimate customer, on
the busiest day of the promo. (This is the failure class #68's `refreshQuoteSources` already
exists to prevent; a clock is the one quote input refreshing cannot fix.)

Two changes, and both are needed — one alone leaves the other divergence open:

- **`promo_end` is a `timestamptz`**, an absolute instant. Never `new Date(str + 'T23:59:59')`
  again. That closes the timezone gap.
- **The backend publishes its clock** (`GET /api/time`), the storefront measures its offset
  against it once, and every `priceOrder` call in the browser is passed the *corrected* time.
  That closes the skew gap. The clock the browser prices with is the clock the backend charges
  with, to within a round-trip.

The merchant picks a **date**; it is stored as the end of that day **in the timezone of the
browser the merchant set it from**. That is a real limitation and is documented rather than
hidden: a shop whose owner sets the promo while travelling gets a window shifted by their
travel. Giving merchants a shop timezone is a separate piece of work.

### 3. A bare promo price runs, and runs forever

A promo price with no cap and no end date is a **live, unbounded promo**. Null cap means
uncapped; null end date means no end date; the merchant turns it off by clearing the price.

Today's rule is the opposite — `promoActive` requires `(hasLimit || hasEnd)`, so a bare promo
price is silently inert. A field that looks set and does nothing is the exact defect #66 thought
it had found. It goes.

**A promo exists iff `promo_price is not null`** — not `> 0`. A promo of `0.00` (a free item) is
a promo; truthiness would silently drop it, which is how a 0 becomes a bug.

### 4. The cap counts units sold, and survives a cap edit

`promo_sold` is a **counter**, incremented inside the order transaction. It is not derived by
scanning `orders.items`: that scan counts cancelled orders, needs a lateral pass per checkout,
and cannot be locked cheaply. The counter is atomic and O(1). Its accepted cost is that a
**cancelled order never returns its units to the cap**.

Raising a cap from 10 to 20 with 10 sold sells **ten more units, not twenty** — the counter
stays. The number the merchant types is the number that sells, ever. The counter resets to zero
only when the **promo price itself changes**: a new price is a new promo.

**The counter is not writable from the browser.** The dashboard upserts the whole product row,
so a merchant editing a product's *name* while a customer checks out would write back a
`promo_sold` it read before the sale — silently rewinding the cap. A `before insert or update`
trigger pins `promo_sold` to its stored value for the `authenticated` and `anon` roles, so only
the backend's owner connection — holding the row lock — can move it. Same rule as the voucher
key and `orders.user_id`: **a counter the client can write is not a counter.**

## Design

### Schema

```sql
alter table public.products
  add column promo_price numeric,      -- null = no promo. 0 is a valid promo (a free item).
  add column promo_limit int,          -- null = uncapped
  add column promo_end   timestamptz,  -- null = no end date. An INSTANT, never a local date.
  add column promo_sold  int not null default 0;

alter table public.products
  add constraint products_promo_price_nonneg
    check (promo_price is null or promo_price >= 0),
  add constraint products_promo_below_price
    check (promo_price is null or promo_price < price),
  add constraint products_promo_limit_positive
    check (promo_limit is null or promo_limit > 0);
```

`promo_price < price` is a database check, not only a form rule: a promo above the base price is
not a promo, and the dashboard is not the only thing that can write this row.

The counter's guard:

```sql
create or replace function public.products_promo_sold_guard() returns trigger
language plpgsql as $$
begin
  -- A counter the client can write is not a counter. The dashboard upserts the WHOLE row, so a
  -- merchant editing a product's name mid-checkout would write back a promo_sold it read before
  -- the sale. The browser's roles cannot move it; only the backend's owner connection, under the
  -- row lock, can. Silently pinned rather than raised: this is a backstop, not a dashboard bug.
  if current_user in ('authenticated', 'anon') then
    new.promo_sold := coalesce(old.promo_sold, 0);
  end if;

  -- A new promo PRICE is a new promo, and its cap starts empty. Raising the cap of a running
  -- promo does not: 10 sold of 10, cap raised to 20, means ten more units — not twenty.
  if tg_op = 'UPDATE' and new.promo_price is distinct from old.promo_price then
    new.promo_sold := 0;
  end if;

  return new;
end $$;

create trigger products_promo_sold_guard
  before insert or update on public.products
  for each row execute function public.products_promo_sold_guard();
```

Then `notify pgrst, 'reload schema'` — without it PostgREST 404s on the new columns.

### `@bitetime/shared` — the promo rule, on both sides of the wire

`PricedProduct` stops leaning on its index signature and declares the promo fields:

```ts
export interface PricedProduct {
  id: string
  name: string
  price: number
  promoPrice?: number | null
  promoLimit?: number | null
  promoEnd?: string | null   // an ISO instant
  promoSold?: number
  [key: string]: unknown
}
```

`productFromRow` joins `voucherFromRow` as a shared mapper, and for the same two reasons: the
column names are snake_case and the field names are not, and **postgres.js returns `numeric` as
a string** (`'8.00'`) while PostgREST returns it as a number. Both sides map through it or the
two sides price differently and every promo checkout is refused.

`promoState` replaces `promoActive`/`effectivePrice`:

```ts
export interface PromoState { price: number; remaining: number }  // remaining = Infinity if uncapped

export function promoState(p: PricedProduct, now: Date): PromoState | null {
  const price = p.promoPrice
  if (price === null || price === undefined) return null       // not `!price` — 0 is a promo
  if (p.promoEnd && now > new Date(p.promoEnd)) return null
  if (p.promoLimit === null || p.promoLimit === undefined) return { price, remaining: Infinity }
  const remaining = Math.max(0, p.promoLimit - (p.promoSold ?? 0))
  return remaining > 0 ? { price, remaining } : null
}
```

`priceOrder` splits the line:

```ts
const promo = promoState(product, now)
const promoQty = promo ? Math.min(qty, promo.remaining) : 0
if (promo && promoQty > 0) lines.push({ …, qty: promoQty, unitPrice: promo.price, promo: true })
if (qty - promoQty > 0)    lines.push({ …, qty: qty - promoQty, unitPrice: product.price, promo: false })
```

`PriceInput.promoSold` — the `Record<string, number>` nobody ever passed — is **deleted**. The
count is a column on the product row now, so a second channel for it is a second thing to
diverge.

`promoClaims(breakdown)` returns `{ [productId]: promoQty }` from the priced lines. The backend
increments from that and nothing else: the units claimed are exactly the units priced.

### Backend

`GET /api/time` → `{ now: <ISO> }`. The clock it publishes is `new Date()` — the same clock
`placeOrder` prices with. Unauthenticated, uncached; it is the *only* thing that makes the
browser's promo window agree with the server's.

`cartProducts` selects the promo columns, maps through `productFromRow`, and takes the rows
**`for update`, ordered by id**. The lock is what makes the cap real, exactly as it is for the
voucher: without it two concurrent checkouts both read the last unit and both take it. `order by
id` so two carts holding the same products in different orders cannot deadlock against each
other.

Lock order inside the transaction becomes **counter → voucher → products**, and the counter is
what makes that trivially safe: `order_counters` is one row per merchant and every intake takes
it first, so no two intakes for the same shop are ever in flight against each other's product
rows. (The merchant dashboard takes a product lock and nothing else, so it cannot close a cycle
either.)

After `assertQuoteHolds`, and still under the lock:

```ts
for (const [id, qty] of Object.entries(promoClaims(bd))) {
  await tx`update products set promo_sold = promo_sold + ${qty} where id = ${id}`
}
```

A promo that sells out between quote and submit therefore surfaces as **`price_changed`** — the
customer is shown the new total and confirms it, rather than being quietly charged more. No new
`OrderErrorCode`; the wire contract does not move.

### Frontend

**The clock.** `serverClock.ts`: a pure `clockOffset(serverNowMs, sentAt, receivedAt)` —
`serverNowMs - (sentAt + receivedAt) / 2`, halving the round-trip out of the estimate — and a
`useServerClock()` hook exposing `now(): Date` and `resync()`. The Storefront syncs on mount,
passes `now()` into **every** `priceOrder` call, and **re-syncs inside `refreshQuoteSources()`**
so a `price_changed` recovery cannot loop on a stale offset. If the sync fails the offset is 0 —
the browser's own clock, i.e. today's behaviour, degraded but not worse.

**The storefront card** shows the promo price, the base price struck through, and — when the
promo is capped — how many units are left. **The summary keys its lines by index, not by product
id**: a split line produces two entries with the same id, and a React key collision would drop
one of them from the screen while the customer is charged for both.

**The dashboard** grows `promo_price`, `promo_limit` and a `promo_end` **date** input, plus a
read-only "N of M sold" once a promo is running. `promo_price` must be below `price` — checked in
the form (the database check is the backstop, not the error message). The date ↔ instant mapping
is its own pure module (`promoEnd.ts`: `promoEndFromDate` / `promoEndToDate`), because
end-of-day-in-local-time is exactly the kind of arithmetic that is wrong in production and
untested in a component.

## Testing

**Unit (`packages/shared`)** — the rule: a split line (cap 3, cart 10 → 3 + 7); a sold-out cap →
no promo line at all; an uncapped promo → the whole line; an elapsed `promo_end` → no promo; a
bare promo price (no cap, no end) → active; `promo_price: 0` → an active promo, **not** dropped
as falsy; `productFromRow` coercing postgres.js's `'8.00'`.

**Unit (`apps/frontend`)** — `clockOffset` halves the round trip; `promoEndFromDate` /
`promoEndToDate` round-trip a date through an instant.

**API (`apps/backend/tests/api`, real Postgres, never mocked)** —

- An order for a promo product commits at the promo price, and `promo_sold` moves by the promo
  quantity.
- Cap 3, cart 5 → the order commits with **two** items entries (3 at promo, 2 at base) and
  `promo_sold` lands on 3, not 5.
- **The race:** two concurrent checkouts for the last promo unit. Exactly one commits; the other
  is refused with `price_changed` (its quote named a promo price that no longer exists), and
  `promo_sold` never exceeds the cap. This is the acceptance criterion, and it is why the row
  lock is not optional.
- An elapsed `promo_end` does not apply: a quote at the promo price is refused, a quote at the
  base price commits.
- `GET /api/time` returns a parseable instant.

**RLS (`apps/backend/tests/rls`)** — a merchant updating their own product **cannot move
`promo_sold`**: an update naming a new value leaves the stored count unchanged, and an update
changing the promo *price* zeroes it.

**Run-and-verify (UI)** — per CLAUDE.md: set a promo from the dashboard, see it on the
storefront with the base price struck through, buy past the cap, watch the split line and the
refusal.

## Out of scope

- **A shop timezone.** The promo's end-of-day is the merchant's browser's, and is documented.
- **#70** (referral discount) and **#71** (`voucherError`'s three unreachable branches) stay
  where they are.
- **Returning a cancelled order's units to the cap.** The counter does not un-count; the merchant
  resets it by changing the promo price.
