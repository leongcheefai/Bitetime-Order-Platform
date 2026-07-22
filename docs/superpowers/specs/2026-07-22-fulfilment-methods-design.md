# Fulfilment methods — design

Issue: [#103](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/103) (`feat: merchant able to select which method they want to support`)
Date: 2026-07-22
Lands on: `feat/distance-delivery-fees`, PR [#104](https://github.com/leongcheefai/Bitetime-Order-Platform/pull/104)

## Problem

Every storefront offers exactly two things — Pickup and Delivery — and no merchant can change
that. A shop that only ships has to tell pickup customers "sorry, not really"; a shop that only
does counter collection shows a delivery button that will produce an order it cannot fulfil.

The half of this that #101 shipped went the wrong way for the same reason. `merchants.shipping_mode`
makes region pricing and distance pricing **mutually exclusive**: a shop that wants to post parcels
at a flat rate *and* run a rider by the kilometre must pick one. That is not a pricing question at
all. Which rule prices a delivery is a property **of the method the customer chose**, not of the
shop.

So: a shop turns each method on or off, and must keep at least one.

## Decisions

Settled during brainstorming; each is a fork that was taken deliberately.

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Relationship of the three methods | **Coexist** — `delivery` (flat region rate) and `express` (distance-priced) are two independent customer-selectable options; either, both, or neither | *Rename only* (one delivery rule per shop, `express` merely the label when distance is live) keeps the exclusivity the issue is asking to remove; *express as a speed tier* invents a cutoff/SLA product nobody asked for |
| `shipping_mode` | **Deleted, by rewriting `20260722120000_distance_shipping.sql` in place** | A *follow-on migration* adds a column that is born and killed inside one PR; *keeping it alongside the flags* leaves `delivery_enabled + express_enabled + shipping_mode='distance'` — a state with no reading |
| Customer-facing names | **Pickup / Delivery / Express delivery** (自取 / 送货 / 快速配送) | *Pickup / Shipping / Delivery* renames a thing existing customers already call Delivery; *merchant-typed labels* push a merchant string onto the receipt, Telegram, order history and the dashboard filter, plus blank and abusive values, for flexibility nobody asked for |
| A shop with no method enabled | **Fails closed** — no button, no order, and the backend refuses | *Falling back to pickup* silently offers a method the merchant switched off. Unreachable past the CHECK; the rule exists so no reader invents one |
| `'sameday'` | **Deleted** from the pricing mode union | It has been unreachable and rate-less since the legacy order form was removed. The union is being edited anyway; leaving a dead third value beside a real one invites its return |

Rewriting the migration means anyone holding a local Supabase must `supabase db reset`. Safe: PR
#104 is unmerged, so these columns have never reached a remote project.

## Domain

A shop offers one or more **fulfilment methods**. Three exist, and the set is closed.

| Method | Fee rule | Address it needs |
|---|---|---|
| `pickup` | none | none — shows the `pickup_address` blurb |
| `delivery` | flat region rate, `WM` / `EM` | free text **plus a state** |
| `express` | `base + rate × routed km` | a **place-id confirmed** address |

The two delivery methods differ in what the customer must supply, not only in what they cost, and
that is why they cannot share one form. `delivery` needs a state because the region selects the
rate; `express` needs a place id because the routed distance selects the fee and free text would
re-resolve differently between quote and charge.

## Schema

`apps/backend/supabase/migrations/20260722120000_distance_shipping.sql`, rewritten. All the
distance columns (`delivery_base_fee`, `delivery_rate_per_km`, `delivery_max_km`, `origin_*`) and
the `distance_quotes` table stay exactly as they are. `shipping_mode` never existed.

```sql
alter table merchants
  add column pickup_enabled   boolean not null default true,
  add column delivery_enabled boolean not null default true,
  add column express_enabled  boolean not null default false,
  ...

alter table merchants
  -- The rule the whole issue rests on, so it is a database fact and not a UI courtesy.
  add constraint merchants_one_fulfilment_method
    check (pickup_enabled or delivery_enabled or express_enabled),
  -- Replaces merchants_distance_requires_origin. Same argument, new predicate: express cannot be
  -- switched on without somewhere to route from, and nullif('') because an empty string is not
  -- null and would otherwise slip through.
  add constraint merchants_express_requires_origin
    check (not express_enabled or nullif(origin_place_id, '') is not null);
```

Every default keeps an existing shop where it is: pickup and delivery on, express off — the
pre-#103 storefront, unchanged.

`orders.mode` gains the value `'express'`. The three `orders.delivery_*` snapshot columns are
unchanged and are now stamped **iff `mode = 'express'`**. No history is backfilled: distance
orders have never existed outside this branch.

## Shared contracts (`packages/shared/src/pricing.ts`)

`PriceInput['mode']` becomes `'pickup' | 'delivery' | 'express'`. Region shipping fires on
`delivery`, distance on `express`. `'sameday'` and the `samedayFee` input are removed, along with
the `sameday` branch of `shippingFee`.

**New mapper — `shopMethods(row) → { pickup: boolean, delivery: boolean, express: boolean }`.**
Shared for the identical reason as `shopRates` and `shopTax`: the storefront decides which buttons
to render, the backend refuses a method the shop does not offer, and the two disagreeing is a
refused checkout, not a cosmetic gap.

- A **missing** column reads as that column's own default — `pickup` and `delivery` true, `express`
  false — so a row that predates these columns behaves exactly as it does today.
- An **explicit `false`** is honoured. Only `false` is false; nothing else is coerced.
- **All three false fails closed**: no method offered, no order taken. Never a fallback to pickup —
  that silently offers a method the merchant switched off, and it is the same species of invented
  answer that `ShopDistance.usable` already refuses.

**`shopDistance(row)`** keeps its name, its shape and its "FALSE IS A REFUSAL, NOT A FALLBACK"
contract on `usable`. One change: the gate moves from `shipping_mode === 'distance'` to
`express_enabled`, and the `mode: 'region' | 'distance'` field is replaced by `enabled: boolean`.

**`priceOrder`** — `distancePriced` becomes `input.mode === 'express'`. `shippingPending` keeps its
current meaning and its current warning: `shipping` is 0 in that state and **is not a fee**.

## Backend (`apps/backend/src/`)

**`writes.ts`** — the merchant-config allowlist swaps `shipping_mode` for the three booleans, each
validated as a real boolean rather than for truthiness.

**`app.ts`, merchant `PATCH`** — the existing origin pre-check generalises. Merge the patch over
`c.get('merchant')` (the row `requireMerchantOwns` already loaded — not a second query), then
refuse with a message that can say *why*, where the CHECK constraint can only say *no*:

- express on with no origin → today's message, reworded for the new name;
- all three off → "Your shop must offer at least one fulfilment method".

The merged read is the point. A PATCH carrying only `delivery_enabled: false` has to be judged
against the **stored** pickup and express flags; judging the patch alone lets a two-save sequence
walk a shop into offering nothing. Both CHECK constraints remain the backstop.

**`app.ts`, intake allowlist** — `'pickup' | 'delivery' | 'express'`. It stays an allowlist for the
reason already written there: `mode` selects the shipping fee, so an unrecognised value prices
shipping at 0.

**`orders.ts`** — a new refusal, `method_not_offered`, checked inside the transaction beside the
active-shop gate. A shop that turned express off must not be chargeable for it by a hand-rolled
request; and the flags live on the shop's row, which only the backend reads. Then the two paths
split on the customer's choice rather than the shop's policy: `delivery` takes the region path and
still refuses without a state (`delivery_state_required`), `express` takes the distance path and
still refuses without a routed distance. `resolveDistance` returns null for anything but `express`,
and the `delivery_*` snapshot is stamped only on express — the routing call stays **outside** the
order transaction, unchanged.

**`app.ts`, quote endpoint** — gates on `express_enabled` instead of `shipping_mode === 'distance'`.

**`notify.ts`** — `*Mode:* express` is a column value, not a label. A local English map renders
`Pickup` / `Delivery` / `Express delivery`, in the style of the deliberate `formatMoney` twin
already in this file.

## Frontend (`apps/frontend/src/`)

**`types.ts`** — `shipping_mode` out, the three booleans in, all read through `shopMethods` and
never directly.

**`store/Storefront.tsx`** — `mode` becomes the three-value union. The initial mode is the first
enabled method in the order `pickup → delivery → express`; only enabled methods render a button.

The address form branches on the **selected mode**, not on a shop-wide `distanceMode`: express
renders `AddressAutocomplete` plus the unit field, delivery renders the free-text line plus the
state select, and both can appear in one session as the customer switches between them. The
existing rule that typing invalidates a confirmed place id is unchanged and still shared.

The refusal copy stops hard-coding a way out. "…please choose pickup instead" is only truthful when
pickup is enabled; otherwise the message states the refusal and stops. Both copies of it (the
out-of-range panel and the submit-time refusal) take the same treatment.

Zero enabled methods blocks checkout with a plain message. The CHECK makes it unreachable; the
storefront must still not invent a method if it ever were.

**`merchant/ShopSettings.tsx`** — the "How you charge for delivery" radio card becomes **"What
customers can choose"**: three checkboxes. Express stays disabled without an origin, keeping
today's explanation of why. The **last ticked** checkbox is disabled, so min-one cannot be violated
by clicking at all; the save-time error is for the paths a disabled input cannot cover.

The region rates card shows when delivery is on, the distance rates card when express is on —
**both at once is now an ordinary state**, and the `? :` between them becomes two independent
conditions. A disabled method keeps its configuration, dormant, exactly as a disabled tax keeps its
`tax_rate`.

**Labels** — `Pickup` 自取 / `Delivery` 送货 / `Express delivery` 快速配送. Three surfaces currently
ternary on `mode === 'delivery'` (`store/ReceiptDialog.tsx`, `store/OrderHistory.tsx`, and
`merchant/OrdersView.tsx`'s own `MODE_LABELS`). They collapse into one shared frontend
`fulfilmentLabel(mode, t)`. A fourth hand-rolled ternary is exactly how one surface ends up calling
the method something the other three do not.

**`savedDetails.ts`** — the rule is `mode !== 'pickup'`, not `mode === 'delivery'`: an express order
carries an address too, and the existing rule (a pickup order's blank address must never overwrite
the saved one) is already stated that way in its own test name.

**`merchant/settingsDirty.ts`** — field swap to match.

## The receipt line — one deliberate reversal

`CONTEXT.md` currently pins the distance fee line to `Delivery fee (25.2 km)` and argues that "one
order must not wear two words for one charge."

With express as a distinct method, that argument now points the other way. An express order says
**Express delivery** on the storefront button, in order history, in the dashboard and on Telegram,
so its fee line must say it too — `Express delivery fee (25.2 km)`. The original rule is not being
broken, it is being satisfied: the one word for this charge is the method's own name. That
paragraph gets rewritten rather than left contradicting the code.

## Docs

- `CONTEXT.md` — *Shipping policy* becomes *Fulfilment methods*: the three methods, the min-one
  rule, `shopMethods` in the mapper list beside `shopRates`/`shopTax`/`shopDistance`, the mode
  allowlist's new third value, and the receipt-line reversal above.
- `docs/adr/0001-distance-fees-from-a-cached-google-route.md` — a note that its exclusive
  `shipping_mode` was superseded before it shipped. Its actual subject (a cached Google route, the
  30-day TTL, failing closed) is untouched and still current.
- `docs/adr/0002-fulfilment-methods-coexist.md` — new: why region and distance stopped being
  exclusive, and why the fee rule belongs to the method rather than to the shop.

## Tests

Shared (`pricing.test.ts`):

- `shopMethods` — column defaults for a pre-#103 row, an explicit `false` honoured, all-false
  returning all-false rather than a pickup fallback.
- `priceOrder` — express prices `base + rate × km`; `delivery` still prices by region; express with
  no routed distance still returns `shippingPending` with no fee.

Backend (`tests/api/`):

- `writes-merchants` — min-one refused; **a patch clearing the only remaining flag, with the other
  two already false in the stored row**, refused; express-without-origin refused; a shop with both
  delivery and express enabled saved and read back.
- `orders` — `method_not_offered` for a method the shop disabled; an express order stamps
  `delivery_distance_km` / `delivery_base_fee` / `delivery_rate_per_km`; a `delivery` order at the
  same shop leaves all three null.
- `shippingQuote` — refused when `express_enabled` is false.
- `tests/rls/helpers.ts` — fixture updated to the new columns.

Frontend: `settingsDirty` and `savedDetails` unit tests. The UI itself is verified by running the
app, per CLAUDE.md.

## Out of scope

- Per-method fulfilment windows or cutoffs. Express is a fee rule, not a speed promise.
- Merchant-authored method labels.
- Any change to how a percent voucher discounts shipping. It still discounts `subtotal + shipping`
  for every method, and the note in `CONTEXT.md` about that biting harder on a distance fee stands.
