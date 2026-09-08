# Domain glossary

Names for the load-bearing concepts in the ordering app. Use these terms in code, tests, and reviews.

## Order pricing

The deep, pure module (`packages/shared/src/pricing.ts`) that turns a cart + context into a money breakdown. Single source of truth for every total the app **shows** and every total the backend **charges** — it lives in `@bitetime/shared` for exactly that reason. Owns fulfilment-method fee selection (region flat rate or express distance), promo price resolution, voucher discount, and tax — in that order. No I/O: the clock, the loaded voucher, and the routed distance are all passed in.

**The backend is the price authority.** The Storefront's `priceOrder` call is a *quote*, for display; the backend's, inside the order transaction, is the *charge*. `POST /api/orders` carries a cart (`{productId: qty}`) and `quotedTotal` — the number the customer saw — and no prices at all: `items`, `total`, `shipping_fee`, `discount`, `tax`, `tax_rate` and `currency` are every one derived from the shop's own rows. The quote is **checked, never trusted**. A disagreement is refused (`price_changed`) and the whole transaction rolls back — not even a counter slot is burnt — so a customer is never charged a number they did not confirm, and a stale quote never buys a withdrawn discount. Before this, a client could POST `total: 0` and the order committed at zero.

One input to that derivation still comes from the body, and it is worth naming: the shipping **rate** is read from `merchants.shipping`, but the shipping **region** is read from the delivery address's `state` — the parcel's own destination, which only the customer can say. So the fee is *charged from the shop's rows, for the region the customer declared*. A `delivery` that declares no state is **refused** (`delivery_state_required`), never priced: with no state, `shippingFee` falls through to 0, and the shop would ship to Sabah for free. The rest — quantities aside, and those are capped — the client cannot influence at all. The same shape holds under *Shipping policy* below: the **routed distance** is likewise a destination fact the shop cannot know, and it is likewise never taken from the body.

- **`priceOrder(input) -> PriceBreakdown`** — the one interface, called on **both** sides of the wire. Returns `{ lines, subtotal, shipping, discount, tax, taxRate, total }`. The `lines` carry resolved unit prices, so the order row, the success screen and the Telegram message consume the breakdown instead of re-deriving it.
- **`voucherError(voucher, ctx) -> string | null`** — pure voucher rules. The **browser's pre-flight only**; the backend enforces redemption under a row lock in `claimVoucher` instead. Three of its six codes (`min_order`, `expired`, `not_assigned`) can never fire, because no column backs them — see #71.
- **`voucherFromRow(row) -> PricedVoucher`** — the `vouchers` row → domain mapping, shared because both sides price from the same rows. Coerces `amount`, which **postgres.js returns as a string**.
- **`shopRates(shipping) -> { WM, EM }`** — the `merchants.shipping` jsonb → rates mapping, shared for the same reason: the two sides disagreeing is now a refused checkout, not a rounding difference. A missing `EM` falls back to `WM`, never to 0 — a 0 would ship to East Malaysia free.
- **`shopTax(row) -> { enabled, rate }`** — the `merchants.tax_enabled` / `merchants.tax_rate` columns → the tax `priceOrder` charges, `shopRates`'s twin and shared for the identical reason: the browser quotes and the backend charges, and a disagreement between them is not a rounding gap, it is a `price_changed` refusal for every order at that shop. The fallback is always OFF — a shop that never configured tax, or an unparseable rate, must fail to NO tax rather than to a number nobody chose. An enabled 0% is normalised to disabled, so every consumer has one thing to test instead of two that must agree.
- **`promoState(product, now) -> { price, remaining } | null`** — is this product's promo running, and for how many more units (`Infinity` when uncapped). See *Promo* below.
- **`productFromRow(row) -> PricedProduct`** — the `products` row → domain mapping, shared for the same reason as `voucherFromRow`: the columns are snake_case, the fields are not, and **postgres.js returns `numeric` as a string** while PostgREST returns a number. `PricedProduct` keeps an index signature, so a *raw* row still type-checks as one — with `promoPrice: undefined`, hence no promo, silently, with **no compiler error**. Map one side and not the other and every promo checkout is refused. The cross-driver test in `pricing.test.ts` is what holds that shut; the type system cannot.

`mode` is an **allowlist** (`pickup` | `delivery` | `express`), not a free string, and that is a price rule: `mode` selects the shipping fee, so any unrecognised value prices shipping at 0. `sameday` was removed from the union entirely (#103) — it had been unreachable and rate-less since the legacy order form was deleted, and a dead value beside real ones is an invitation to bring it back. The cart is capped at the door too (≤ 1000 per line, ≤ 100 lines, `invalid_body`): `Number.isInteger(1e21)` is true, and the price check cannot catch a quantity the client both asks for and quotes.

A **cart key must be a canonical (lowercase) uuid** — the regex has no `i` flag, and that is money, not style. Postgres compares `uuid` case-insensitively and JavaScript `===` does not: an uppercase key matched the row in `= any(…::uuid[])`, sailed past the "every requested id came back" refusal, and then matched *nothing* in `priceOrder`'s `products.find(p => p.id === id)` — so the line was silently dropped, the cart priced at 0, and on a pickup `quotedTotal: 0` agreed with it. Any product, any quantity, committed free. **Refuse a non-canonical key; do not normalise it** — lowercasing would let the upper- and lowercase forms of one id merge into a single line at double the quantity, walking past `MAX_CART_QTY`.

There is no order-level referral discount. The legacy `referral` input and `referralDiscount` output were removed (#70) — the referral program is a **subscription** reward (see *Referral* below), not a discount on a customer's food order.

Rounding is `parseFloat(toFixed(2))` per step, and the quote/charge comparison is made in whole cents.

## Fulfilment methods

What a customer can choose, and what that choice costs. A shop offers one or more of **three**, and the set is closed: `pickup`, `delivery` and `express`. Each is switched on or off independently on `merchants` (`pickup_enabled` / `delivery_enabled` / `express_enabled`), and **at least one must be on** — `merchants_one_fulfilment_method` makes that a database fact rather than a UI courtesy. A method switched off keeps its configuration, dormant, the same arrangement a disabled tax keeps its `tax_rate`.

Which rule prices a delivery is a property **of the method**, not of the shop, and that is the whole point: one shop can post parcels at a flat rate and run a rider by the kilometre.

- **`pickup`** — no fee, and no address. Shows `pickup_address`, which is display-only free text.
- **`delivery`** — a flat rate per region (`WM` / `EM`), selected by the state the customer declared. See *Order pricing* above.
- **`express`** — `fee = base + rate × routed distance`. Two merchant-typed numbers and an optional `max_km`. A shop that wants pure per-km sets `base` to 0.

**`shopMethods(row) → { pickup, delivery, express }`** is the one reading of those columns, the fourth of `shopRates`' family and shared for the identical reason: the storefront renders its buttons from it and intake refuses from it (`method_not_offered`), and the two disagreeing is a refused checkout. An absent column reads as that column's own default; **all three false fails closed** — no method, no order, never a fallback to pickup.

**Delivery origin** — the shop's geocoded start point, chosen once in Shop Settings through address autocomplete and stored as a place id plus coordinates. Express **cannot be switched on without one**; that is a validation, not a fallback. Not to be confused with `pickup_address`, which is display-only free text for the pickup blurb and is never routed — a string re-resolved on every call would drift the shop between quote and charge.

**Routed distance** — road kilometres from the shop's origin to the customer's destination, **rounded to one decimal before the rate multiplies it**. That order matters and is not cosmetic: the receipt line reads `Express delivery fee (25.2 km)`, so the km on the line must be the km that produced the money. (The line is named after the **method**, not after a house term for "shipping": with `delivery` and `express` both selectable at one shop, a line reading `Delivery fee` on an express order names the wrong method. One order still wears one word for one charge — that word is now the method's own name, and `fulfilmentLabel.ts` is the single place that decides it.) Rounding after would print 25.2 km beside a fee computed from 25.216. It is *road* distance, not straight-line — a straight-line number would understate what the rider actually drives by roughly a third, and merchants would set their rate against a lie.

**Distance quote** — a cached `(origin, destination) → metres` row, keyed by the two place ids. The 30-day expiry (the cap Google's terms allow) is enforced by the **reader**, inclusively (`created_at >= cutoff`) — nothing sweeps expired rows; a row written exactly at the cutoff still counts as fresh. It is what makes the quote and the charge the same number without asking Google twice: both the storefront's quote and order intake's cache-miss lookup read the row first and write it on a miss, sharing the identical read-then-lookup-then-write logic. A merchant who moves their shop changes the origin place id and so invalidates their own cache with no sweep. On a miss at intake the distance is fetched again — **before the order transaction opens**, never inside it, because the transaction holds the shop's counter lock and a Google round-trip under that lock serialises the whole shop's intake behind Google's latency. A distance that moved in the meantime surfaces as the ordinary `price_changed` refusal, which the customer resolves by confirming the new total.

**Distance failures fail closed.** No fee is ever invented for an address that could not be routed, and the two failures are told apart because only one of them is worth retrying: an address with **no road route** is refused as out-of-range, the same answer as beyond `max_km` and the same message, because it is the same fact — that shop does not deliver there. Only a genuine API error says "try again". Falling back to the region rate was rejected, and is now plainly wrong rather than merely undesirable: the region rate belongs to a **different method the customer did not choose** (`delivery`), and a receipt line named `Express delivery fee` cannot honestly wear it.

The distance is a **destination fact the client cannot be trusted to state**, so it is never read from the request body, and the quote endpoint takes a place id rather than free text. That is an **API-shape deterrent, not a validation** — any non-empty string is accepted, because place ids have no stable public format and a shape check would refuse legitimate addresses; free text would also let a caller mint unlimited distinct destinations, and every distinct destination is a billable call on the platform's own Maps account. What actually bounds the spend is a per-IP sliding window (cheap flood protection) plus a **per-merchant daily ceiling** on provider calls — charged only on a cache miss, since a hit costs nothing — keyed on the shop's own canonical row id, which a caller cannot re-spell by varying the request. **Order intake is a second spender on that same per-merchant ceiling, not just a reader of what the quote endpoint cached**: its own cache-miss path draws on the identical bucket (one Google bill, one shop, one ceiling) and adds a per-IP bound of its own on the miss path only — a courtesy against accidental hammering, not the abuse control the per-merchant ceiling is.

A percent voucher still discounts `subtotal + shipping`, unchanged. Worth knowing that this bites harder here: 20% off an RM8 flat rate gives away RM1.60 of shipping, the same voucher against an RM31.20 distance fee gives away RM6.24 — and that is the merchant's rider cost, not their food margin. Left as-is deliberately; changing the discount base would move totals at every shop that never asked for distance pricing.

## Fulfilment date

**When** the customer asks for their order — the date the storefront picker is built from and order intake checks against. One pure module, `packages/shared/src/fulfilment.ts`, decides it for both sides of the wire, for the same reason `priceOrder` does: two copies of this arithmetic that drift by a day are a checkout that refuses every honest order on the window's edge, with nothing on screen to explain it. Not to be confused with **fulfilment method** above, which is *how* the order travels.

A shop offers dates in one of **two modes**, and the set is closed: `rolling` and `custom`. `merchants.config -> 'fulfilment' -> 'mode'`, read through `fulfilmentConfig` like every other field in that bag. The unused mode's settings stay in the row, dormant, the same arrangement a disabled tax keeps its `tax_rate` — switching mode is never a deletion.

- **`rolling`** — a moving range computed from three numbers: `lead_days` (days of notice, 0 allows same-day), `window_days` (how far ahead the shop commits), and `closed_weekdays`. Closed days are **removed** from the range, they do not extend it: `window_days` is how far ahead the merchant is willing to commit, not a quota of open days. This is what every shop that has never opened the Fulfilment tab reads as — `0 / 14 / none`.
- **`custom`** — an explicit **allowlist**, `custom_dates`, of calendar dates the merchant ticked. `lead_days`, `window_days` and `closed_weekdays` do not apply to it at all: ticked is ticked. The only filter is *date ≥ today*, and the merchant's own notice period is theirs to honour by not ticking tomorrow.

**Today is the shop's clock, not the customer's** (`merchants.timezone`). A customer ordering from another timezone must see the same earliest date the merchant would, or the lead time silently means something different for them. Dates are compared as UTC-midnight milliseconds — the one place a date string becomes a number — because UTC has no daylight saving, so "+1 day" is always +86400000 and a window can never gain an hour and land on the wrong date.

**The horizon is 90 days**, one constant (`FULFILMENT_HORIZON_DAYS`) bounding both modes — but not identically, and the difference is worth stating because the constant's name suggests otherwise. In `custom` it is absolute: a ticked date more than 90 days out is never offered and cannot be saved. In `rolling` it clamps `window_days` **alone**, and `lead_days` (up to 30) still pushes the range out ahead of it, so a rolling shop can commit as far as day 119. That is the pre-existing behaviour of the two caps and is left alone deliberately; the feedback that asked for "up to 3 months" was about the ticked dates, and 90 days is that, expressed in the day-count arithmetic this module is already made of rather than a second concept and calendar-month maths.


**The merchant may move an order's date, under the same rule as the customer.** `PATCH /api/merchants/:id/orders/:orderId` takes `fulfil_date`, judged by `isDateSelectable` against the shop's own Fulfilment settings on the shop's clock — lead days, window, closed weekdays, ticked dates, all of it. A looser rule was built first and reverted the same day: the settings are what the merchant told the platform they can serve, and a drawer that ignores them is a door around the Fulfilment tab. A merchant who wants a Monday order has changed their mind about Mondays, and the tab is where that goes. The drawer's picker is built from `selectableDates`, the same list the storefront draws, so a closed day is not clickable and no day it offers is one the save refuses; a refusal (`fulfil_date_unavailable`, 409, intake's own word) therefore reaches a merchant only when the settings moved under an open drawer. A **completed** order's date is as final as its status and is refused with `order_completed` ([ADR 0024](docs/adr/0024-a-completed-order-is-final.md)). The date can be moved but never **cleared**: a null `fulfil_date` means "placed before #91", a fact and not a choice. Each move is a `fulfil_date_changed` event with both ends. The customer is not told — that is a merchant's conversation on WhatsApp, not the platform's — which is a deliberate gap, not an oversight.

**A shop with no offerable date is paused, not closed.** The two reads agree by construction — `selectableDates` returns `[]` and `isDateSelectable` returns false — so the storefront and a scripted POST get the same answer, and a paused shop cannot be sold out from under its owner by a caller who skips the picker. `merchants.status` stays `active`: the menu, prices and photos still render and are still crawlable, and the customer is told at the date step that the shop is not taking orders. A configuration gap must not wear the suspended-shop screen; being suspended is something the platform did to you. A stray POST is refused with the existing `fulfil_date_unavailable` — the date *is* unavailable, so the vocabulary already has the honest word and gains no new one.

**Pausing has exactly two causes.**

1. **The allowlist ran dry** — every ticked date is in the past. The merchant is warned in the dashboard before it happens (amber when the last remaining date is within 7 days, red at zero), computed from config with no job and no send path.
2. **A shop paused before #222** — the tier's removal took the only writer of `needs_review` with it, so nothing can pause a shop this way any more. The flag and its readers survive so a row written before that still behaves as its owner was told. See [ADR 0015](docs/adr/0015-a-shop-with-no-offerable-dates-pauses.md).

**`needs_review` is cleared by a deliberate act inside the Fulfilment tab**, never by a banner button and never by a forced edit — a merchant whose rolling window was already right must not have to break it to reopen. That act is now the only thing that clears it.

**Stale dates are filtered on read and pruned on save.** Nothing sweeps them: a read that rewrote the merchant's config would be a merchant-config write on the customer path.

**A date the merchant un-ticks stops new orders and nothing else.** Orders already placed for it keep their date, which is a historical fact about what the customer was promised, not a view of current settings.

## Promo

A reduced price on one product, optionally ending on a date and optionally capped at a number of units. Four columns on `products`: `promo_price`, `promo_limit` (null = uncapped), `promo_end` (null = no end date), `promo_sold` (the counter).

**A promo exists iff `promo_price is not null`** — never `> 0`. A promo of `0.00` is a **free item**, and it is a real promo; a truthiness test would silently price it at base. An empty dashboard field stores `null`, which is what "no promo" means. A promo with neither a cap nor an end date simply runs until the merchant clears the price.

**The cap binds per unit, so a line splits.** A cart of 10 against 3 remaining promo units is **3 at the promo price and 7 at base**, not 10 of either — all-or-nothing would let a cap of 3 sell 100 promo units to one order, which is not a cap. Two `PriceLine`s therefore carry the **same product id**, and two entries land in the order's `items` jsonb. Anything rendering those lines **keys by index**: keyed by id, React drops one row from the screen while the customer is charged for both.

**The cap is claimed inside the order transaction**, under `select … for update` on the product rows — the `claimVoucher` pattern, for the identical reason: without the lock two concurrent checkouts both read the last unit and both take it. Lock order is **counter → voucher → products**, and `order_counters` is one row per merchant, so it serialises a shop's intake before any product row is touched. A promo that sells out between quote and submit surfaces as the existing **`price_changed`** refusal — the customer is shown the new total and confirms it, never quietly charged more. *(Note: because every intake serialises on the counter first, the two-concurrent-intakes test does not actually exercise the product lock — a separate test holds the last unit open on a second connection to do that. Do not delete it thinking the race test covers it.)*

**`promo_sold` is not writable from the browser.** A `before insert or update` trigger pins it for every role except `postgres` / `service_role` / `supabase_admin`, and the backend re-reads the counter (`returning`) to confirm it actually moved rather than trusting the UPDATE. The dashboard upserts the *whole* product row, so a merchant editing a product's **name** mid-checkout would otherwise write back a `promo_sold` read before the sale and rewind the cap. Same rule as `orders.user_id` and the voucher key: **a counter the client can write is not a counter.** The trigger is `security invoker` **on purpose** — `current_user` must be the caller's role, and making it `security definer` (the style of the other guards in that directory) would make it `postgres` on every call and disable the pin entirely.

The counter **survives a cap edit** and resets **only when the promo price changes**: 10 sold against a cap of 10, cap raised to 20, means ten more units — not twenty. A new price is a new promo. A **cancelled order never returns its units** to the cap; the merchant resets the count by changing the price.

**The browser prices the promo window against the *server's* clock** (`GET /api/time` → `serverClock.ts`), and this is not fastidiousness. `priceOrder` runs on both sides and a disagreement is a hard refusal, so the clock is a **price input**: a device minutes off ours, on the promo's last day, would quote the promo, be refused, re-quote *with the same skewed clock*, and be refused again — a permanent refusal loop for a legitimate customer, at the promo's busiest moment. A menu refetch cannot repair a clock; only the sync can. `promo_end` is a `timestamptz` (an absolute instant) for the other half of the same bug: `new Date(dateStr + 'T23:59:59')` parses as **local** time, putting a UTC server eight hours from a UTC+8 customer. A failed sync falls back to the device clock — the old behaviour — and **that fallback alone does not recover** (I-3, #69): if `/api/time` is persistently unreachable while `POST /api/orders` still works, `resync()` keeps failing, the offset stays 0, and a `price_changed` retry that only re-syncs the clock re-quotes against the same skewed offset and is refused again, forever. What actually closes the loop is that `price_changed` itself carries the server's clock in its body (`app.ts`'s OrderError handler stamps `now`) — the refusal that proves the connection works also states the time, so `refreshQuoteSources` **adopts** that timestamp (`serverClock.ts`'s `adopt()`) instead of re-fetching `/api/time`, and recovery needs no second endpoint that could fail the same way.

The promo's end-of-day is in the timezone of the browser the **merchant** set it from. A shop has no timezone of its own; that is out of scope, and it is why `promoEnd.ts` exists rather than an inline date cast.

## Menu options

A question a merchant attaches to a product, and the answer a customer gives to it. One mechanism covers two shapes that look unrelated: a **box of 6 muffins** whose flavours the customer allocates, and a **coffee** whose milk the customer picks.

**Three terms, and they are not interchangeable.** An **option group** (选项组) is the question, and carries `minSelect`, `maxSelect`, `maxPerOption` and `active`. An **option** (选项) is one answer inside it, and carries `name`, `name_zh?`, `delta` and `active`. A **selection** is what one customer chose for one group. The muffin box is `minSelect = maxSelect = 6` with `maxPerOption = null`; the milk is `minSelect = maxSelect = maxPerOption = 1`. Same row, different integers — which is the whole reason this is one concept and not a "mix and match" feature sitting beside a "variants" feature, each with its own table, validator, renderer and ticket format. `maxPerOption` is independent of `maxSelect` and cannot be inferred from it: "pick up to 3 toppings" is `maxSelect = 3, maxPerOption = 1`, and a customer taking chilli three times is not what the merchant meant. Not **modifier** — 加料 means "add ingredients", which is false of a box the customer is filling rather than modifying.

**A selection describes one unit; `qty` repeats it.** Two boxes with different flavours are **two cart lines**, never one line of twelve muffins. The alternative — allocating across the whole line — dissolves the box into an ordering minimum, forces every validation site to multiply `minSelect` by `qty`, and has no honest answer when a customer edits qty from 2 to 1 and someone must decide which six muffins to delete on their behalf.

**The cart is a list, not a map.** `CartLine` is `{ productId, qty, selections }` and its key is **derived** — the product id plus its selections, canonically serialised — so two adds of the same drink with the same milk merge, and the backend re-derives the key rather than trusting one. This is the shape the *output* has had all along: a split promo already writes two `PriceLine`s under one product id, which is why *Promo* above says to key those by index. The input simply stops disagreeing with it. **`.find` by product id is wrong everywhere from this point on** — it silently answers about the first line only. See [ADR 0009](docs/adr/0009-the-cart-is-a-list-of-lines-keyed-by-selection.md). Distinguish `CartLine` (what the customer put in) from `ReceiptLine` (a priced line for display, derived from `bd.lines`); one name for both is how the promo split came to strain it.

**The cart caps keep their per-*product* meaning.** `MAX_CART_QTY` is still "the most of any one product", now summed **across** that product's lines, and `MAX_CART_LINES` is still "the most distinct products", with a separate ceiling on lines. Reinterpreting them per line would multiply the guarantee by the line cap and leave the comment above them false — a hundred thousand cookies is a smaller number with the same shape as a trillion. A merchant's own config is now a cart input too: `maxSelect`, the option count and the group count are all merchant-typed, so all three are capped at **write** time as well as read time.

**An option's `delta` is a cost, not a discount.** It is absolute (never a percentage — those compound against a promo price and round twice), non-negative, and applied **per selected unit on top of whichever unit price is in force**, promo or base. So a promo latte with oat milk is `promoPrice + delta`, and the promo split carries identical selections into both halves. A promo that absorbed the delta would hand out paid extras free to anyone who noticed, and "small −2" is a cheaper product or a promo, not an option. `PriceLine.unitPrice` is therefore **all-in**: `base + Σ(delta × optionQty)`.

**Scarce promo units are a budget spread across lines, not a fresh allowance per line.** With one product able to occupy several lines, each line reading `promo.remaining` independently would sell a cap of 3 six times over — the cap failing open, silently, exactly as the swallowed voucher claim did. Lines are walked in canonical key order and the remainder is consumed as it goes. `promoClaims` is unaffected: it counts **units of the product**, which is what `promo_sold` means.

**The order snapshots the answer, and never references it.** Each order item carries the group name, the option name, both languages, the quantity **and the delta that was charged**. An order is a financial record, not a view of current config: a merchant tidying their menu next month must not rewrite last month's receipts, and with the groups stored as jsonb there is no foreign key that would stop them. Storing the delta is what makes the line self-proving — without it, "Latte ×1 @ 12.00" cannot be reconciled against a menu that now says 10 and oat +3.

**The groups live on the product row**, `products.option_groups` jsonb, per product, with no shared library — see [ADR 0008](docs/adr/0008-option-groups-live-in-the-product-row.md). Array order **is** display order, for groups and for options; there is no `sort` column and no tie-break to get wrong. `name_zh` is optional and falls back to the English string, matching `products.name_zh`.

**Availability is a flag, never a count.** `active` on a group and on an option is all a merchant gets, because the shop cannot track stock on a *product* either — per-option inventory would let a merchant cap oat milk but not muffins, and would put a third decrement inside the order transaction beside the counter lock and the promo claim. An option going inactive mid-checkout is refused as **`option_unavailable`**, which is its own code and not `product_unavailable`: that one recovers by refetching the menu so the vanished id drops out of the cart, and here the product id still exists, so the dead selection survives every refresh and every retry is refused identically — the permanent refusal loop *Refusal* above exists to prevent. Its recovery **repairs** the line by reopening the picker, and falls back to dropping the line only when the whole group is dead. That fallback is the terminating case, not a courtesy.

**`active: false` hides a group rather than deleting it**, and that is now only the merchant's own Hide control — the bulk revocation that used to write it went with the tier (#222). A switched-off group **is not a question**: `validateSelections` filters on `active` before it enforces anything, so the product stays sellable and the question is simply not asked, required or not. ADR 0010's second clause — a *required* group taking its product off sale — went with the revocation that was its only writer; nothing implements it now. See [ADR 0010](docs/adr/0010-menu-options-are-pro-and-downgrade-hides.md) and [ADR 0016](docs/adr/0016-one-plan.md).

## Menu category

A section of a shop's own menu, authored by the merchant and named in their own words — 饮料, 甜点, 蛋糕 — chosen once per product and rendered as a heading on the storefront. The domain type is **`MenuCategory`**, not `Category`, because `FeedbackCategory` already holds that word: that one is the platform's own bug/feature/billing/other vocabulary, a support term that never reaches a shopper, and the two are unrelated.

**Exactly one per product, and a product may have none.** That is what makes this a *section* and not a tag: every product appears on the menu **once**, in one place, the way a printed menu is arranged. A product carrying no category — or carrying an id the shop's list no longer holds — is **uncategorized**, and uncategorized products render **last, under no heading at all**. So a shop that never authors a category has exactly the menu it had before this existed, rather than one whose every item now sits under a platform-supplied "Other".

**A category with nothing live under it renders nothing.** The storefront already drops inactive products; this is the same rule one level up. It is what keeps three otherwise-visible blemishes off a merchant's shop: a category created ahead of the season, a category whose items are all deactivated, and the empty category left behind when a product save fails after its category was created inline.

**The list belongs to the shop; the choice belongs to the product.** `merchants.product_categories` (jsonb) holds the ordered list — `[{ id, name, name_zh?, active }]` — and `products.category_id` points into it. **Array order is display order**, with no `sort` column and no tie-break, the same arrangement option groups use and for the same reason. `name_zh` is optional and falls back to the English string, matching `products.name_zh`. Names are unique within a shop on a **folded** key (case and punctuation folded away, Chinese preserved — the `matchKey` fold *Shop customer* uses for tags): two identical headings on one menu is broken in a way two spellings of one customer tag is not, so here the collision is refused rather than surfaced. See [ADR 0013](docs/adr/0013-menu-categories-live-on-the-merchant-row.md).

**Deleting a category takes nothing with it.** It leaves its products pointing at an id the list no longer holds, which is the uncategorized reading above — the products stay on sale and fall to the trailing block. Nothing rewrites the products, so there is no multi-row write and no half-applied delete; the merchant is told how many products are about to become uncategorized before they confirm.

**`active: false` hides a category and takes **no product** off sale.** A category is decoration, not a fulfilment requirement: unlike a *required* option group, a product whose heading disappeared is still perfectly sellable, so [ADR 0010](docs/adr/0010-menu-options-are-pro-and-downgrade-hides.md)'s second clause has no analogue. All categories inactive is precisely the uncategorized shop above. The storefront reads `active` and nothing else.

**The order never carries it.** An order snapshots names and prices precisely so a merchant tidying their menu cannot rewrite last month's receipts; how the menu was *arranged* the day it was ordered from is not a fact about the order. Receipts, Telegram tickets and the xlsx report are unchanged by this.

## Menu arrangement

How a shop's menu is ordered, and the fact that the merchant — not the creation date — decides it. Two stored things: the order of `merchants.product_categories`, and `products.sort` with `products.category_id`. The merchant sets both by dragging, on the dashboard's **Storefront** section, whose drag surface renders the storefront's own rows (`components/MenuRow.tsx`) at phone width — so the surface *is* the preview, and cannot drift from what a customer sees. See the spec, `docs/superpowers/specs/2026-08-17-storefront-arrangement-design.md`.

**`sort` is dense and global per shop**, numbered `0..n-1` across the sections in render order rather than restarting inside each one. A per-section counter would need the section to break the tie; one global number means the storefront's single flat product read already returns them in render order and grouping is all that is left. It is written by `PUT /api/merchants/:id/product-order` and by nothing else — a product upsert must never move a product.

**The whole list is sent on every save, never a diff.** Two browsers arranging one shop is last-writer-wins, the deal every other merchant write already offers; a diff would interleave one save's numbering with the other's.

**Two functions, because there are two questions.** `menuGroups.ts` answers the storefront's — *what does a customer see* — so it drops hidden categories, drops empty sections and reads a dangling id as uncategorized. `merchant/menuArrangement.ts` answers the merchant's — *where is everything filed* — and keeps all three, because a merchant must be able to drop a product into a section a customer cannot see. The arrangement screen therefore shows hidden products and hidden categories, tagged: it is faithful about **order and layout**, and deliberately not about **visibility**.

**Dragging an item out of a deleted section is what clears the dangling id.** The saved patch takes each product's section from the block it now sits in, not from the id stored on the row.

## Product copy

A **superadmin-only** bulk duplication of products from one shop into another, used to set up a new merchant's menu at their request. It is a dedicated backend write path (a `db.ts` transaction), not the product upsert: it carries `descr_zh` (real merchant data the form cannot edit), strips every promo field (a promo is one shop's time-bound campaign, not menu data), duplicates image **objects** into the target's own storage prefix (a cross-tenant path reference would break when the source shop deletes), and remaps `category_id` by category **name**, appending sections the target lacks. Copies land whole or not at all — with one carve-out: a source image whose object is already gone (image deletes are best-effort, so a row can outlive its file) is skipped and reported, never fatal, because the honest copy of a photo that no longer exists is no photo. The picker — not the write path — is where duplicate-name judgement lives.

## Order intake

The flow that collects a cart and customer details and commits an order: `collect → priceOrder → placeOrder → notifyOrder`. The multi-tenant **Storefront** (`store/Storefront.tsx`) is the only intake path; the legacy single-tenant order form has been deleted. `notifyOrder` is a single post-commit call that fans out to three recipients — see *Order notifications*. Every way this flow can say no is named — see *Refusal* below.

## Merchant order reads

How the dashboard is allowed to ask for a shop's orders. Three shapes, and which one a caller gets is decided by what it is going to *do* with the answer.

**Nothing may ask for "all the orders".** PostgREST caps every response at `max_rows` (1000, `apps/backend/supabase/config.toml`) and reports the truncation only in a `Content-Range` header. The dashboard's orders endpoint was an unbounded `select *`, so every screen built on it silently stopped seeing a shop's oldest history at its 1000th order — the order list could not reach it, the revenue chart did not count it, and the "new orders" badge measured a list that had already been cut (#144). No error, no empty state, and a merchant making decisions on a revenue figure that was simply short. Production's cap may be a different number; the failure is the same at any number, which is why the rule is about the *shape of the request* and not about the value.

So:

**A page, when rows are rendered.** `GET /api/merchants/:id/orders` takes `page`, `pageSize`, `sort`, `dir` and `search`, and answers `{ orders, total, page, pageSize }`. `total` is the exact matched count, so the caller can tell a page from the whole — a bounded window the caller *named* is not a truncation. Sorting and searching run in Postgres for the same reason the paging does: a browser cannot search rows it was never sent. The sort column is a whitelist and an unknown one is a **400**, never a silent fall back to `created_at` — a list ordered by something other than what was asked is the same defect in a smaller costume. Paging is a **total** order (`sort`, then `id`), or page 2 can repeat a row from page 1. This path stays on the REST client because these rows are rendered and must match the row a status `PATCH` hands back.

**An aggregate, when only a number is wanted.** `GET /api/merchants/:id/stats` computes the whole Overview server-side with `computeMerchantStats` — the same shared module the XLSX export uses, so "booked excludes cancelled" stays stated once. `GET /api/merchants/:id/orders/count` answers with a count Postgres did. Neither ships an order row to the browser; a chart is not a reason to send someone a thousand rows.

**The driver, when an aggregate needs the whole history.** `ordersDb.ts` reads through `db.ts`, which has no row cap, and selects only the four columns the stats module reads. The KPI cards are all-time and the month-over-month deltas need last month as well as this one, so there is no window that could be pushed into SQL without answering a different question. This is the same escape the customer list took in #143 (`shopCustomersDb.ts`) — SQL groups, TypeScript decides. Like everything on `db.ts` it is **RLS-exempt**: `requireMerchantOwns` on the route is what makes the `merchant_id` filter true.

**A could-not-ask is not a zero.** Overview and the order list say so on screen rather than rendering an empty chart or an empty table. Collapsing a failed read to `[]` is how a merchant comes to trust a number that is not one — the row cap was only how it happened.

**The order drawer** (`merchant/orderDetail/`) is a header, a scrolling body of cards and a fixed status footer. It grew for a year as one flat scroll of hairline-separated sections, which is how seven groups came to carry the same weight and how the status control — the thing a merchant opens the drawer to use most — ended up last on the page, past the items, the address, the courier fields and the note. The footer is where the status lives now, and it offers one button for the next step in the chain `new → preparing → ready → completed`.

`nextStatus.ts` holds that chain as a **lookup and not the next index in `ORDER_STATUSES`**. That array is a vocabulary, not a line: `pending_payment` sits before `new` and `cancelled` after `completed` because that reads well in a list. Walking it by index would offer "cancel this order" as the one-click move on a completed order, and would advance an unpaid one — which asserts that the money arrived. A merchant says that themselves, by choosing the value. An unknown status returns `null` for the reason `STATUS_BADGE` falls back to neutral: it is a status the module has not been taught, and guessing its successor would write to the database on a guess.

**A `completed` order gets no footer at all** — not a disabled list, and not the badge on its own, which `OrderHeader` is already showing. Where there is no move to make, the bar is chrome repeating the header, which is why a suspended shop has never had one either. The move that decided it is completed → cancelled: a cancellation releases the voucher redemption the order spent, on goods the shop already handed over, and it is one press of a list the drawer used to show. `cancelled` stays changeable, because un-cancelling is what [ADR 0023](docs/adr/0023-a-cancelled-order-returns-its-redemption.md) built for a merchant's mis-click. The rule is `isStatusFinal` in `orderStatus.tsx`, but the drawer is **not the boundary**: the backend refuses a status change away from `completed` with `409 order_completed`, and only `status` is frozen — `note`, `courier` and `awb` still write, because a shop files an AWB after the delivery. An identical value is a no-op, not an error. See [ADR 0024](docs/adr/0024-a-completed-order-is-final.md).

A suspended shop gets **no footer at all**, so no status write is reachable there; the note and the courier render as text.

## Order event

One thing that happened to one order, recorded as it happened: the order was created, a payment proof landed, the status moved, a note or tracking detail changed. An event names its **kind**, its **actor** and the moment. It is immutable and is never deleted — a log that can be edited is not a log — and it is recorded **with** the action, never after it: an action that cannot be logged does not happen ([ADR 0025](docs/adr/0025-an-order-event-commits-with-its-action.md)).

The **actor** is who did it: the **merchant**, the **customer**, or the **system** (a change no person chose — the status flip a payment proof causes, the voucher use a cancellation returns). A guest is still a customer, just one with no account behind the act.

Not to be confused with the customer's **order history** (their own past orders at a shop) or the storefront **timeline** (the four-step status tracker).

## Order log

The events of one order, oldest first, as the merchant reads them in the order drawer. The customer does not see it. A date change (`fulfil_date_changed`, see *Fulfilment date*) is one more event kind in this log and nothing new.

## Refusal

A reason the backend would not take an order or price a delivery, named by a **wire code** the customer's browser can act on — as opposed to a bug, which carries no code and is never dressed up as one. The vocabulary is `packages/shared/src/refusal.ts`: the codes, what each one means, and the HTTP status it carries.

It is shared for the same reason `priceOrder` is — it must hold identically on both sides of the wire — and it is shared because the hand-copied version **drifted**. `method_not_offered` was added to the backend's union, handled in the storefront as a bare string comparison, and never added to the frontend's own union, so nothing could see the gap. Nothing *could*: `handleSubmit` reads `err?.code` off an `any`, so the compiler was never looking. A code is now added in one place and **breaks both builds** until it is handled — the backend's on `REFUSAL_STATUS` (a total `Record`, no default), the frontend's on `orderRefusalPlan`'s exhaustiveness check.

**What a refusal says and does is not shared, deliberately.** The backend renders no message, `t(en, zh)` is the browser's, and two messages depend on whether the shop offers pickup — a refusal must not point at a button that is not on screen. `orderRefusalPlan` (`store/orderRefusal.ts`) turns a code into `{ message, actions }`, where `actions` is an **ordered** list: `refresh_sources` → `clear_quote` → `requote` for `price_changed`, and the order is load-bearing. `refresh_sources` adopts the server clock the refusal itself carried; re-quoting first would re-quote against the same skewed offset and be refused again — the permanent refusal loop of I-3, #69. Order as data is what lets a test hold that shut; as statement order in a catch block it was only ever a comment.

**Exhaustive at build time, forgiving at run time.** A deployed browser is always older than the server, so an unknown code falls back to a generic sentence — never the raw wire code on the checkout screen, which is what used to happen before `invalid_body` was given a branch.

**The quote path tells the same truth as the order path.** `quoteDelivery` used to narrow the endpoint's eight codes to five, folding `merchant_not_found`, `merchant_inactive` and `quota_exceeded` into `lookup_failed` — whose copy says *try again*. A shop's daily ceiling on billable lookups does not clear for up to 24 hours, and the order path had always refused to make that promise (see `distance_lookup_failed`). All eight now survive, and a closed shop reads as a closed shop.

## Order notifications

The messages sent **after** an order commits, never inside its transaction — a notification outage must never roll back a paid order. One post-commit call (`POST /api/notify/order`, anonymous) fans out to three independent, best-effort recipients; any can fail or skip without touching the order or the others.

The three are not variations on one message, and every difference between them is deliberate: who receives it, whether it is deduplicated, and what language it speaks.

**Merchant notification** — a Telegram message to the shop. The shop's surface: English only, carries operational detail (WhatsApp, distance). Skips when the merchant has no Telegram configured, which is the only condition on it. Not deduplicated — a repeat is merchant-facing noise.

**A message too long to send is a notification lost, so the Telegram arm truncates rather than overflows.** `sendMessage` caps text at **4096 characters** and does not trim — it refuses the whole call. Because the fan-out runs *after* the commit, that refusal costs the merchant every word about an order that already exists, and it looks exactly like a shop with no Telegram configured. A full cart is `MAX_CART_LINES` (100) items at roughly forty characters each, so the item block alone reaches the ceiling before the header and totals are counted; the per-item selections line adds the rest. `buildOrderMessage` therefore renders under the cap by construction — the guard lives in the builder, not the call site, so nothing downstream can forget it. What gives way is the **item block**, from the end, never the head or the tail: the order number, customer and address at the top and the money at the bottom are what a merchant acts on, and a cart long enough to overflow is the one whose individual lines matter least. It **says so** — *N of M items shown — open your dashboard for the full order* — because silent truncation reads as a complete order (see *Merchant order reads*, where an uncounted row was the same defect). Lines are dropped whole and the notice's `*` markers are balanced: the message goes out as Markdown, and a cut landing mid-`*bold*` is a parse rejection, which loses precisely what the truncation was written to save. The last resort, where the header alone overflows, keeps the order number and nothing else — with it a merchant can find the order, without it they cannot. **The two mail arms need no such guard**, and that is a fact about the numbers rather than a difference in principle: the largest legal cart renders to tens of kilobytes against a provider ceiling in megabytes, with no line near RFC 5322's 998 octets. Both facts are pinned by tests, so #145 cannot quietly move either one.

**Order confirmation email** — a bilingual receipt to the **customer**, and only to a **signed-in** one: the recipient is the account email read server-side from `order.user_id` via Auth, so a guest order (`user_id` null) skips *structurally*, never by a check that can be forgotten. Sent once per order — stamped `orders.confirmation_emailed_at` under an atomic guard, because a customer receiving the same receipt twice reads as broken. Language rides in the request body (presentation only, safe to trust); the recipient never does.

**Merchant order email** — the shop owner's new-order alert, and **the arm every shop gets**. It exists because Telegram is opt-in: a shop that never set a bot up had no notification at all and learned of an order by refreshing the dashboard, which is not a notification. Telegram stays the loud, phone-buzzing channel in the group the whole shop already sits in, and a shop that has configured one simply receives both. The recipient is the owner's account email, read from `merchants.owner_id` via Auth (never `profiles`, which a fresh signup may not have); an owner-less shop skips. English only, following the Telegram rule rather than the receipt's — the body's `lang` is the *customer's* presentation and never reaches here. It carries what the receipt deliberately omits: the customer's WhatsApp number and the routed distance. Sent from the **platform's** address, not the shop-named sender the receipt uses — the shop is the recipient, and an alert appearing to come from itself reads as a copy of the customer's mail.

Sent once per order, stamped `orders.merchant_emailed_at`, and here the guard is **load-bearing rather than merely tidy**. ADR 0003 accepted an anonymous notify endpoint on the reasoning that the worst an enumerator achieves is triggering the one legitimate *customer* email slightly early. That argument does not survive a recipient who is not the customer: order numbers are a guessable per-shop daily counter, so without the stamp a guessed number is an unbounded mail flood at a merchant's inbox. The owner is resolved **before** the claim, so a shop with no reachable owner leaves the stamp unclaimed rather than burning its one alert on a send that never happened.

## Order review

One customer's 1-to-5 star rating of ONE order, with an optional comment of at most 500
characters. It is three columns on `orders` (`review_rating`, `review_comment`, `review_at`),
not a table: a row cannot hold two reviews, so one review per order is structural, and the
merchant's existing `select('*')` reads carry it with no join.

The customer rates on the **order-placed screen**, immediately after checkout. The rating thus
measures the checkout and not the food. This is deliberate. A guest order keeps `user_id = null`
for ever. Thus the order-placed screen is the only screen that a guest sees again. A customer
with an account can also rate the order, and rate it again, from the order history.

Two endpoints write it. They are the equivalents of the two invoice endpoints.
`POST /api/orders/:orderId/review` uses the order's `user_id`. `POST /api/orders/review` matches
the shop, the order number and the phone with `phoneKey()`, under `reviewSubmitIpWindow`, and
only for an order with no `user_id`. A cancelled order gets a 409. Each other refusal gets the
same 404.

The merchant READS it — a column in the order table, a card in the order drawer — and can never
write it. Nothing is public: there is no shop average, no reply and no moderation.

A guest who leaves the order-placed screen cannot change the review. `/invoice` gives a PDF, and
does not show an order. This limit is accepted. See
`docs/superpowers/specs/2026-09-03-order-reviews-design.md`.

## Invoice

The document a customer keeps: **what was ordered, and what is owed**. It is a PDF, generated by the backend, and there is no other invoice — the same bytes serve the order-placed screen, the guest lookup page, the signed-in customer's order history and the merchant's order sheet. See [ADR 0017](docs/adr/0017-the-invoice-is-a-pdf-and-the-only-invoice.md).

**Not a payment proof.** A **payment proof** is the transfer slip the *customer uploads* after paying (#182, `GET /api/orders/:orderId/payment-proof`). The two travel in opposite directions and one word for both is how a shop comes to ask for the wrong file. _Avoid_: receipt (for either), bill.

**It asserts nothing about payment, and nothing about progress.** The platform never touches the money — bank transfer and QR are off-platform — so "paid" is not a fact it holds. Status, courier and AWB are absent for a second reason: paper goes stale and an order does not, and a customer holding a page that says *preparing* about an order delivered last week has been misinformed by us.

**It is issued from `new` onward** — `new`, `preparing`, `ready`, `completed`. A `pending_payment` order gets nothing, because the shop has confirmed nothing; a `cancelled` order gets nothing, because nothing happened. The consequence is that at a shop taking manual payment, where an order is *born* `pending_payment`, the order-placed screen cannot offer the file yet and says so instead.

**English only**, both languages of the app notwithstanding. The CJK font is still embedded unconditionally: `merchants.name` and `products.name` hold Chinese for many shops, whichever language the reader chose.

**It reads the order and the shop, and never the menu.** Names and prices come from the order's own snapshot, so a merchant tidying their menu cannot rewrite last month's paper — the rule *Menu options* and *Menu arrangement* already state, here made structural: there is no menu lookup to get it wrong.

**Three doors, one document.** A signed-in customer proves ownership with the JWT; a merchant with `requireMerchantOwns`; a guest with the **order number plus their phone**, matched on `phoneKey()` against `orders.customer_phone_key` and scoped to one shop, because an order number is unique per shop and not globally. That door is public, rate-limited, and answers a wrong phone and a missing order identically — see [ADR 0018](docs/adr/0018-a-guest-proves-an-order-with-its-number-and-a-phone.md).

## Voucher

A per-merchant promotion code. `percent` (subtotal×value/100) or fixed (`min(value, total)`). Validation rules live in `voucherError` (the browser's pre-flight); the discount math lives in `priceOrder`; the claim lives in `claimVoucher`, under a row lock, inside the order transaction.

**Two caps, and they are different concepts.** `max_uses` is the **shop's** total (null = unlimited); `per_customer_limit` is **one customer's** allowance (default 1, null = unlimited). They are named as a pair for that reason — `fully_used` means the shop's cap is spent, `customer_limit_reached` means yours is. The old code was `already_used`, which stopped being true the moment a limit above 1 was sayable: it would fire on a customer's fourth attempt at a three-use code. The same rule that renamed `orderCount` to `bookedOrders` under *Shop customer*.

**Both null is refused.** An unlimited total against an unlimited per-customer allowance is a literally unlimited discount for one person — #72 reached through the dashboard instead of the request body. A CHECK forbids it, and the form makes it a disclosed dependency rather than a rejected submit: pick unlimited per customer, and the total cap is required.

**A voucher requires an account.** The one-per-customer key is the **verified JWT's email** and nothing else. A guest has no verified identity, so their claim cannot be keyed to anything they cannot also change — and an unkeyable claim is *refused* (`voucher_requires_account`), never keyed on `''`. The key used to be `voucherEntry`, a string the **request body** supplied: the same person re-redeemed a one-per-customer voucher forever by varying it (`a@b.com`, `a+1@b.com`, `x`), and a voucher with a null `max_uses` was an unlimited discount for one person (#72). A key the client can name is not a key — the same rule that already governs `user_id`. The storefront's voucher section offers sign-in when signed out; the Checkout gate is untouched and guest checkout is still one tap. It just cannot carry a discount.

**This is friction, not a wall — do not read it as airtight.** A customer account is free to mint: signup is **pre-confirmed** (`email_confirm: true`) and a customer's email is never verified, deliberately (see *Customer signup*). So the abuse is not eliminated, it is *priced*: an extra redemption now costs a signup with an unused address, is subject to the signup rate limit, and arrives as a real order the merchant sees and fulfils, rather than an invisible string swap. The cap is **per-mailbox, not per-human** — `a+1@gmail.com` is a distinct Supabase account. Making it genuinely airtight means real email verification, which reverses a deliberate product decision and is its own work.

**A redemption is a row, not an entry in a list** — `voucher_redemptions`, indexed `(voucher_id, customer_key)`, with the order it was spent on. Both caps are aggregates over it. The old `used_by` jsonb array was read and rewritten *under the checkout's row lock* and became unbounded the moment one customer could hold several redemptions; it also served every redeemer's email address to an unauthenticated lookup on a code printed on flyers. The public lookup now returns **derived flags only** — `fullyUsed`, `expired`, `minOrder`, and `yoursRemaining` when the caller presents a JWT — so there is no field left that could carry an email. See [ADR 0019](docs/adr/0019-voucher-redemptions-are-rows-not-a-list.md).

The array's historical WhatsApp numbers were backfilled **verbatim**, junk included: they are a key that can no longer be produced and will never match again, someone who redeemed as a guest gets one more redemption from an account, and their stale row still eats a `max_uses` slot. All of that was already true, and a backfill that quietly dropped them would have handed every live voucher extra capacity on deploy day.

**A cancellation returns the redemption.** A redemption is void when its order is `cancelled`, and live again if the merchant un-cancels — the STATE decides, never the transition, so the write is idempotent; it runs inside the order patch's own transaction, so a void that fails rolls the patch back with it ([ADR 0025](docs/adr/0025-an-order-event-commits-with-its-action.md)). It is a `voided_at` timestamp, not a delete: the merchant keeps the fact that the code was redeemed, and un-cancelling is a null-out rather than an insert that would have to race the caps again. The restore is unconditional and can put a voucher one over `max_uses`, because refusing a merchant's correction of their own mis-click is the worse failure. **Every count of `voucher_redemptions` must say `voided_at is null`** — the one in `claimVoucher` under the row lock is the only one that frees a slot, and the two display counts in `voucherRedemptionsDb.ts` would otherwise tell the shop a slot is spent that checkout will take. The two cases that decided it: a shop out of an item cancels and charges the customer a code for nothing, and an order born `pending_payment` that is never paid burns a use on nothing at all. See [ADR 0023](docs/adr/0023-a-cancelled-order-returns-its-redemption.md). **A `completed` order cannot be cancelled at all** — the release would hand the use back on goods already delivered, so the status is frozen there ([ADR 0024](docs/adr/0024-a-completed-order-is-final.md)). **An unpaid order nobody cancels still holds its use for ever** — that needs an expiry rule for `pending_payment`, which is its own decision.

**A restriction holds in three places, and one of them is not optional.** The storefront keeps an applied voucher across cart edits, so `expires_at` and `min_order` cannot live only in `voucherError`: apply at RM60, remove an item, and the discount survives — and because the backend prices from the same module, it would agree. So `priceOrder` **drops the discount** when the voucher is expired or the basket is under the minimum (it already takes `now`), `claimVoucher` **refuses** so nobody burns a redemption for RM0, and `voucherError` keeps the message as the pre-flight only. Under the minimum the storefront keeps the chip and states the gap ("Add RM10 more to use …"), because a minimum-order voucher exists to prompt exactly that.

**`min_order` is compared against the subtotal, before any discount.** Not subtotal + shipping, which is what a percent voucher discounts against: with shipping in the base, an EM-rate customer qualifies at a lower food spend than a KL one — and on a distance-priced shop the threshold moves street by street. A merchant setting RM50 means food. The subtotal already reflects promo prices, so a sale basket can fall under.

**`expires_at` is an ISO instant, and the merchant picks a date.** The create endpoint resolves that date to 23:59:59.999 in `merchants.timezone` and stores the instant — the conversion lives there and nowhere else, so the comparison stays a plain `now > expires_at` and the shared module never learns about timezones. Stored naively the merchant's "31 Aug" becomes `00:00Z`, which in `Asia/Kuala_Lumpur` kills the voucher at 8am on the day they thought it ran. `promo_end`'s rule (an instant, never a local date string) holds unchanged.

**The merchant sets all of it behind checkboxes.** Three fields are always visible — code, type, amount — and each limit is disclosed by its own tick: *Limit the total number of redemptions*, *Reusable — one customer can use this more than once*, *Add an expiry date*, *Require a minimum order*. Two of those defaults are opposite and the labels have to say so: unticked total means **unlimited**, unticked per-customer means **one each**. The reveal is a conditional render and not a hidden `div`, because a hidden input still submits, still validates and still takes keyboard focus — an unticked limit would block the form on a value the merchant cannot see.

**There is no delete. `active = false` is a pause, and the unique index is partial** — `unique (merchant_id, code) WHERE active`. A paused voucher stays on the merchant's list, marked, keeps its code, its limits and its redemption count, and comes back exactly as it was — it is the same campaign, waiting, and is editable while it waits. It used to vanish from the list, and "Turn off" for a row that disappears reads as delete, which is what merchants took it for. Hard delete would take the redemption history with it, and the old delete-and-recreate was also how a merchant silently reset `used_by`. The partial index is what stops a paused code reserving its string for ever: creating it again makes a **new row with a new id**, so the old campaign's redemptions stay attached to the old campaign and count against nobody. The price of that is paid on **reactivation**: if a second live row now holds the code, the first cannot come back until the second is paused — a 409 `duplicate_code`, the same answer create gives, and the dashboard says which one has to move. `claimVoucher` and the public lookup filter `and active` themselves; only the merchant's own list shows both. Consequence: two rows can share a `code`, and any query on the string alone must say `and active` or get an ambiguous answer. `DELETE /vouchers/:id` survives as the same write the dashboard no longer sends, and must never become a delete that deletes.

**An edit changes what a code does, never what it is.** `PATCH /api/merchants/:id/vouchers/:voucherId` replaces the discount and every restriction — type, amount, total cap, per-customer limit, expiry, minimum — and ignores a `code` in the body. The code is printed on flyers, held by customers, and is what the partial unique index keys on, so a merchant who needs a different string turns this voucher off and creates the next, which is deliberately a new row. Both write routes read the body through one parser (`voucherInput.ts`), so the unbounded refusal and the shop-clock expiry cannot hold on create and lapse on edit. `{ active }` alone is the list's own Activate/Deactivate action, which must not have to know the rules to flip a switch. Redemptions already taken are untouched: lowering `max_uses` under the count reads as fully used from now on, and the dashboard's form says so before the save. On the dashboard, create and edit are one drawer (`VoucherFormSheet.tsx`, the product drawer's shell) over a table (`VouchersManager.tsx`), the same arrangement as products; the form's seeding rule — which limit boxes a row opens with ticked — is the pure `voucherDraft.ts`, because `per_customer_limit = 1` is the UNTICKED state and not a ticked box holding "1".

**The merchant sees a voucher's history as a list of orders, never of people.** `GET /api/merchants/:id/vouchers/:voucherId/redemptions` joins each `voucher_redemptions` row to the order it was spent on and returns the order number, the customer name typed at checkout, the discount taken, the order status and the two timestamps — and never `customer_key`, which is the redeemer's platform account email and stays behind the *Shop customer* line. A returned row (`voided_at` set) stays on the list, because "was this code ever used?" must keep a true answer; a backfilled row has no order and no time and says so. The edit drawer shows it as its last card. `tests/api/reads-voucher-redemptions.test.ts` drives real redemptions through intake and asserts the key is in the table and absent from the wire.

**A voucher is a broadcast instrument.** Stripe's *limit to a specific customer* and *first-time order only* are deliberately not offered — both need to name a person, and the merchant is forbidden to see the only key that would work. See [ADR 0020](docs/adr/0020-two-stripe-voucher-restrictions-bitetime-cannot-key.md). A voucher also stays **one level**: the code *is* the discount. Stripe splits Coupon from PromotionCode because a Coupon is a billing object reused across many subscriptions; a shop running three codes would gain a second table and a join inside the order transaction for nothing it asked for.

## Referral

Two things share the name.

**Referral capture** — live. A merchant signs up under another member's code, which is stamped on `merchants.referred_by_code`; the referrer can list the shops they brought in (`GET /api/referrals/shops`). The code reaches signup two ways: the `?ref=` a referrer's invite link carries, and a **field on the signup form** (#265), prefilled from that parameter and accepting the whole link pasted in. The field asks `GET /api/referrals/check` whether the code names a shop, and blocks the submit while it does not — the stamp drops a code it dislikes in silence (`resolveReferredByCode`), so before this an unchecked typo looked exactly like a referral that worked. That endpoint is the one referral read whose code comes FROM the request, which it can be because it answers a caller who has no account yet and returns `{ valid }` and nothing else: a code is 8 hex characters, so a name attached to it would make it a merchant directory anyone can walk. It is rate limited per IP. `valid` means the code names a shop and says nothing about a reward, which is decided later, at the referred shop's first invoice. A member's code is the first 8 hex characters of their user id, uppercased. The code is always derived from the caller's verified identity, never accepted from the request — a referrer's shops are not their own tenant, so reading them is a cross-tenant read, and the un-choosable code is the only thing that makes it safe. Display-only: no reward is granted.

**Referral reward** — a **subscription** reward, not an order discount (decided in #70, `docs/prd-referral-reward.md`). When a merchant who signed up under a member's code pays their **first invoice**, that referring member earns **one free month of their own subscription** — a credit on their Stripe customer balance, valued at what they pay today (yearly → annual ÷ 12). The referred merchant gets nothing. Stacks with no cap, granted once per referred shop, no clawback. The old order-level `referral`/`referralDiscount` path in `priceOrder` was deleted — a customer typing a code at checkout for money off their food was never this program.

## Shop customer

One shop's record of one person who orders from it. **Not a `Customer`** — that word means a platform *account* (the auth user plus the global `profiles` row, the thing `role === 'customer'` means), and the two are different sets: most shop customers have no account, one account is many shop customers, and there is **no path from one to the other** — a guest order carries `user_id = null` forever, by design.

**Identity is `(merchant_id, phoneKey(customer_wa))`** — the last-eight-digits rule `phone.ts` already defines, reused rather than re-derived. (It defined it for guest order tracking, at `/track`; that route is gone, and the same rule now stands the guest **invoice** door up — see *Invoice*.) The account is an **attribute** (has-an-account), never the key. The reasoning, and the rejected alternatives, are [ADR 0007](docs/adr/0007-shop-customers-are-keyed-by-phone.md); the short version is that guest checkout is first-class and permanent, so an account-keyed list would show a merchant a fraction of their own trade. Consequences accepted knowingly: one human with two numbers is **two** shop customers, and two different numbers sharing their last eight digits are **one**.

**An order whose phone yields no key is not a shop customer** — not an empty-string bucket, not a name fallback. It is excluded and *counted*, so the customer list and the order list never disagree with nothing on screen to explain why. `phone.ts` already refuses to key on `''` and says why; a `customer_name` fallback assembles one person out of unrelated strangers, which is exactly what the pre-#143 `—` row did. That count is surfaced as `unattributedOrders`.

**Behaviour is derived, opinions are stored.** `orders` remains the sole record of what happened — a shop customer's counts and totals are aggregated from it, never copied, so there is no counter that can drift (the rule that already governs `promo_sold` and `orders.user_id`). The only stored half is what the merchant *writes*: a private note and free-form tags, in a row created lazily on first write. Shop-private: the diner never sees them, and neither does another shop.

**Booked, not received.** Counts and money exclude cancelled orders, reusing `merchantStats`' own predicate so "revenue excludes cancelled" stays stated once. The field is therefore named **`bookedOrders`** and never `orderCount` — `windowTotals` already uses an order *count* that includes cancelled orders beside a revenue that does not, and two numbers on one row must not mean two different things. **Last-order date is the exception and includes cancelled orders**: a cancelled attempt is still contact, and recency is asking a different question from money.

**What a shop may see is a boundary, not an accident.** Shop-scoped facts, the has-an-account flag and — since [ADR 0026](docs/adr/0026-a-shop-sees-its-members-account-email.md) — a **member's account email**, and **no saved address, nothing else from the global profile**. A WhatsApp number was volunteered to receive one order; an account email was volunteered to the *platform*, and the reason a shop now sees it anyway is that a Members list it cannot write to is not a members list. The email is derived on every read (`orders.user_id` → `auth.users`, most recent signed-in order), never copied into `shop_customers`. Cross-tenant leakage is structural rather than policed: the record is keyed by merchant, so a shop cannot learn that a diner also orders elsewhere.

**Tags offer, they do not normalise** (#150). The drawer suggests every tag the shop has already written — `shopTags` on the list response, folded in the pure module from the records it has already loaded, so the vocabulary costs no second query and is neither filtered nor paged (it is what the tag filter *chooses from*). Suggestions match the draft case-insensitively, so a merchant halfway through `vip` is shown the `VIP` they used last time and can avoid the collision while it is still avoidable. What the platform does **not** do is lowercase on write: a tag is the merchant's own label in their own words, and silently rewriting it would merge two tags they may have meant to keep apart with no way back — the *refuse or offer, never normalise* instinct the cart key states under *Order pricing*. Consequence accepted: `vip` and `VIP` can still both exist, and merging them is a separate story.

**The row is the choosing** (#205). That vocabulary is drawn as chips under the customer list, one tag active at a time, and clicking the active chip clears it — there is no separate clear control. Capped at ten with a `+N more`, and the selected tag is always drawn even when it sorts past the cap: a filter the merchant cannot see is a list that reads as missing rows. Before it existed the only way to set the filter was to open a customer's drawer and click one of *their* tags, so a merchant looking for their VIPs had to find a VIP first. Each customer's own tags also sit **on their row**, first three then a `+N`, as display and not a second control — the row already opens the drawer, and one pointer must not have two outcomes. Every shop sees both the row and the column.

The list, its search, its sorting, its tag filter and the notes and tags themselves are one feature and every shop has all of it. Sorting, filtering, notes and tags were the paid half until the tier went (#222).

**Member** — a shop customer whose `hasAccount` is true: at least one order under that phone key was placed signed in. Not a new identity and not a stored flag — it is derived from `orders.user_id`, which comes only from a verified JWT, so "member" means "has a platform account", and every account is an email + password, so it also means "has an email" — the one the **Members** list shows (ADR 0026), and the All list does not. The set is decided per **shop customer**, not per order: a phone with one signed-in order and nine guest orders is one member, and all ten orders are a member's orders. **Not the *Referral* section's "member"** — that word there means a merchant with a referral code, a different set with nothing in common but the spelling.

**Segment** — which slice of a shop's customers the list is asked for: `all` or `members`. One word end to end — the sidebar child under Customers, the hash sub-segment, the query parameter — and an allowlist, refused rather than reinterpreted, so a third slice later is one more word and not a second flag. The stat row above the list (customers, booked orders, spend) is scoped exactly as the list's `total` is: after the segment, search and tag filter, before paging.

## Business nature

What a shop sells, as one code from a **closed** vocabulary — `BUSINESS_NATURES` in `@bitetime/shared`, the `merchants_business_nature_check` CHECK, and `merchants.business_nature` (#161). Collected at signup, editable afterwards from Shop Settings → Shop. Platform-facing only: it is never shown to a customer, and it exists to answer one question — which industries the platform actually serves.

**Business nature is the domain term; "industry" is the word the admin Overview says.** The superadmin panel is titled *Merchants by industry* because that is what reads as English to the person looking at it — the code, the column and the shared list all say `business_nature`, and the stats slices (`IndustrySlice`, `stats.industries`) name the ranked view of it. One concept, two registers; do not add a third.

**A closed list, because the whole point is a group-by.** Free text was rejected: `bakery` / `Bakery` / `cake shop` cannot be ranked without a human normalising them afterwards. Consequences: a code is **never renamed in place** (every shop already carrying it would silently change industry), and adding one means the shared list, a new migration's CHECK, and an EN/ZH label — only the label is compiler-enforced.

**NULL is "never said", and is counted.** Every shop predating the field carries it, and the migration backfills nothing — `other` is an answer a merchant *chose*, and defaulting to it would be a lie on the very chart this exists to draw. The admin Overview names the bucket *Unspecified*, sorts it **last** however large it is (it is not an industry), and scales the bars against the biggest *named* industry so day-one's all-NULL platform does not compress every real bar to a stub. The signup form requires a pick; `POST /api/merchants` deliberately does **not** — analytics must never be the reason a shop fails to be created — but a present-but-unknown code is refused, never dropped, on both the create and the settings path.

## Use-case page

A marketing page written for ONE trade, served at `/for/<slug>` — `home-bakers`, `home-kitchens`, `makers`, `cafes-and-stalls` (#214). Every string lives in `apps/frontend/src/marketing/useCases.ts`; `UseCasePage.tsx` renders any entry. The pages exist because the site said what TinyOrder does and never who it is for, and because a page per trade is a page per search a shop owner actually types.

**"Use case" is the domain term. `verticals.ts` is a different thing that shares the English word "vertical".** That file holds the five WORDS the landing hero rotates through (`food`, `bakes`, `art`, `clothes`, `crafts`) with their measured slot widths; it addresses no page and has no route. A use case is a page. Do not merge them, and do not describe a `USE_CASES` entry as a vertical in code.

**They describe the same product, not a bundle.** No shop type is gated, priced or provisioned differently; the pages differ in which shipped behaviour they lead with. That is why every claim on them is checked against `public/llms.txt`, which is the authoritative feature list — a sentence there that the software does not do is a promise the software then has to keep.

**Adding one touches six places**, three of them derived from `USE_CASES` and three by hand: `ROUTE_META` (spread), the router (`.map`), the prerender list (spread), plus `vercel.json`'s rewrite, `sitemap.xml` and `llms.txt`. Of the hand-written three, only the sitemap and the rewrite/llms.txt joins are test-pinned — see `vercelRewrites.test.ts`, `llmsTxt.test.ts`, `sitemap.test.ts`.

## Storefront findability

The SEO scope for merchant storefronts: a customer who searches the **shop's own name** finds `/s/<slug>` with the shop's title, description and menu facts in the result. Deliberately NOT local discovery ("nasi lemak delivery PJ") — that fight belongs to Google Business Profile and delivery marketplaces, not to a path on a shared domain — and NOT custom domains, which is a separate feature. Every active shop gets it; there is no plan gate.
_Avoid_: "merchant SEO" (says nothing about which queries), "shop ranking".

**Head injection** is the mechanism: a Vercel Function serves `/s/:slug` (and its subpaths) by injecting per-shop `<title>`, meta description, canonical and `LocalBusiness` JSON-LD into the same deploy's SPA shell. The **body stays the shell** — content parity for JS-less crawlers is out of scope, so the served snippet is the meta description, which packs category names for that reason. **Fail-open**: any error serves the untouched shell, which is exactly the pre-feature behaviour — hence a breakage is invisible in a browser, and only the canary and the pinning tests see it. Shop data comes from the backend's public API, never a direct database read: `pickMerchantConfig` stays the one authority on which columns are public. Merchant-controlled text lands in raw head HTML and inside the JSON-LD script block — escaping is a pinned rule, not a nicety. See ADR 0022.

**Slug history** is what survives a rename: `PATCH /api/merchants/:id/slug` records the old slug, and the storefront function 301s it to the current one — printed QR codes and indexed URLs keep working. **Claim-wins**: a new shop claiming a slug in another shop's history takes it, and the redirect dies — a live shop's claim beats a dead redirect, and freed slugs stay reusable. Statuses map to crawler answers: unknown slug → 404, `suspended`/`pending` → 200 + noindex (reversible, as suspension is).

**Shop sitemap** (`/sitemap-shops.xml`) is a second, function-served sitemap enumerating active shops only — the static `sitemap.xml` stays hand-maintained for platform pages; the two lists have different owners and change rates. On a database failure it answers **503, never an empty 200**: an empty 200 tells Google every shop page is gone.

## Customer signup

How a customer account comes into being. Email confirmation is on **project-wide** and stays on — it is shared with merchants, and a merchant account controls a shop and its Stripe billing. A client-side `signUp` would therefore return no session, stranding a customer mid-checkout in their inbox holding a cart, so customers are minted **pre-confirmed** by the backend instead (`POST /api/customer/signup` → `admin.auth.admin.createUser({ email_confirm: true })`), and the client signs in normally. Pure seams: `customerSignup` (policy; the account-creation and profile writes are injected adapters), `rateLimit` (clock-injected sliding window), `clientIp` (backend), `signupError` (frontend).

Three trade-offs are load-bearing, not incidental:

- **A customer's email is never verified.** Self-correcting: whoever owns the address reclaims it by password reset. We do send customers order-confirmation mail (see *Order notifications*), so a mistyped or unowned address means a stranger receives that order's details (name, delivery address, items, total) — but this is the **same exposure the reset link already carries**, and a reset link is the graver of the two. It adds no new category of risk, so the unverified-email stance stands; making it airtight means real verification, which reverses this deliberate decision.
- **A duplicate email is disclosed** ("You already have an account — sign in"), which makes the endpoint an email-enumeration oracle. Accepted: the alternative strands a returning customer with no session and no actionable error. Password reset deliberately does *not* disclose — do not "fix" the asymmetry.
- **The rate limit is the only control** (CORS constrains browsers, not servers), and it is **in-memory**. It resets on redeploy (harmless) and silently stops protecting anything if the backend is scaled past one instance (not harmless). Its IP key reads the *rightmost* `X-Forwarded-For` entry, because the leftmost is caller-supplied.

## Checkout gate

The one step between a cart and the checkout form, and the only place a customer is ever *required*
to choose: *sign in / create account / continue as guest*. (Sign-in is also *offered* elsewhere — the
storefront header, the guest strip — but only the gate stands in the way.) Whether it fires is a pure decision
(`checkoutGate.ts` → `checkoutStep`), not a consequence of clicking through a checkout — signed
in, it never renders; first-time guest, it does; returning guest, it is skipped and a quiet
"Ordering as a guest / Sign in" strip stands in its place. The guest choice is remembered in
`localStorage` **keyed by shop slug**: a choice made at one shop must not silence the gate at
another. Signing in overrides a remembered guest choice, always.

Guest is one tap, and the warning ("Guest orders can't be traced back…") is on screen before
they take it — a confirm step is only honest when the consequence is hidden, and it isn't. The
warning is muted, not alarming: as a danger box it out-shouted the headline and made the guest
path the loudest thing on a screen whose purpose is to offer an account.

## Advertising pixel

TinyOrder's own ad-conversion tracking (Meta today; TikTok is built but has no account and is
unnamed in the privacy notice until it does). It answers one question — did a paid ad produce a
shop — and it is **not** SEO: a pixel changes no ranking. Two events only, `PageView` and
`CompleteRegistration`, and no payload rides with either. `track.ts` has no `params` argument at
all, so "no personal data reaches an ad network" is a signature rather than a promise.

**It never runs on a shop's storefront.** The audience there belongs to the merchant, not to us,
and `documents.ts` tells those customers so in as many words. Scope is *derived* from
`ROUTE_META` — the set of pages that have a title of their own — so a new page under `/s/` cannot
quietly join it, and both scope and canonical URL normalise a path through one `normalisedPath`.

Whether anything happens is a pure decision (`pixels/decision.ts` → `pixelDecision`), against a
truth table, for the same reason [Checkout gate](#checkout-gate) is. It is one function because it
was once two conditions: the pageview was gated on the path and the **load** was not, so a visitor
who accepted on `/pricing` and then opened a storefront link injected `fbevents.js` onto that
merchant's page. Nothing was reported and the damage was already done — the load *is* the
third-party request and the advertising cookie. Off a marketing page every answer is now no,
including for a visitor who accepted earlier: consent given on our pages is consent for our pages.

Consent fails closed everywhere — no storage, throwing storage, corrupt JSON, unrecognised value
all read as *not asked yet*, which shows the banner and loads nothing. It is remembered per scope
(`bitetime.consent.v1.<scope>`), so the merchant-pixel follow-up (#220) asks its own question of
its own audience. Accept and Reject are the same control at the same size, deliberately: a decline
that is visibly the lesser button is not a free choice.

With no `VITE_*_PIXEL_ID` set the whole feature is inert — no banner, no script — which is the
state of dev, CI and the e2e run, and why none of them stub anything.

## Product analytics

TinyOrder's own measurement of its own pages, through the `praxor` client (`analytics/`). It
replaced `@vercel/analytics`, which is why `documents.ts` no longer names a hosting provider as a
party that measures page use — a notice naming a recipient that receives nothing is a false
statement in a legal document, the same rule the TikTok warning in `.env.example` states.

Distinct from the [advertising pixel](#advertising-pixel) in what it may do, not just in what it
reports: it sets **no cookie**, keeps only a server-computed visitor hash in `sessionStorage`, and
follows nobody to another site — so it asks no consent question and is gated by no banner. It also
covers **more** pages: the pixel fires only on published pages (`ROUTE_META`), this measures the
merchant dashboard and admin too, because the question is where an owner stalls after signing up.

**It reports nothing from a shop's storefront**, and that rule is why the SDK's own capture is
switched off. `praxor` patches `history.pushState` and listens on `document`; both are global to
the page and neither can be told to ignore `/s/:slug`, and this app is one SPA — a visitor reaches
a storefront from `/pricing` with no document load. So `autoCapturePageviews` and
`trackOutboundLinks` are both `false`, and `useAnalytics` sends each pageview itself behind
`isPlatformPath` (`analytics/scope.ts`), which excludes `/s/` and `/reset-password` and nothing
else. Its own `pathOnly` rather than `normalisedPath`: the canonical one collapses the signup
preselection segment, which is the exact segment `cta.ts` reads.

Five events, `analytics/events.ts`, a union so adding one is a type error until that file changes.
`merchant_signup` and `trial_started` fire from **three** places — `SignupScreen`,
`FinishSignupScreen` and `PendingScreen` — because a shop can be created at signup, later from the
answers parked in auth metadata when email confirmation delays it, or by retrying a trial Stripe
refused. Reporting from one would make the funnel's answer depend on a Supabase setting.
`trial_started` follows the backend's own `trial` flag, never the shop's status: a shop that
activates having already used its one trial started nothing.

`cta_click` comes from one delegated listener on `document`, so the seven signup CTAs need no
handler; `data-cta` on the link names which one. With no `VITE_PRAXOR_SITE_ID` set the client is
never created — the inert state of dev, CI and the e2e run.

## Device

One GoTrue session, and nothing more. The platform stores no device identifier and runs no
fingerprint, so two browsers on one computer are two devices, and clearing a browser's storage
yields a new one — the abandoned session stays as an idle row until it is evicted.

A merchant account holds two at a time. A third sign-in succeeds and signs out the device used
longest ago, ranked on `coalesce(refreshed_at, created_at)`. The merchant sees both in
Settings → Devices and can sign one out. Customers and superadmins are not bounded.

Signing a device out IS deleting its `auth.sessions` row: GoTrue then refuses that session's
still-unexpired access token, so the device stops working at once rather than at its next refresh.

## Password reset

The way back into a customer account — and therefore back to the order history, which is precisely
what they would otherwise lose. It uses **Supabase's own recovery flow**, deliberately not mirroring
the custom signup endpoint: going through Supabase buys rate limiting and **non-enumeration** for
free, where a custom endpoint would force us to rebuild both.

Non-enumeration is only as good as the caller. The request's outcome is **swallowed** and the
neutral *"If that email has an account, we've sent a link"* is shown unconditionally, because
Supabase's per-email cooldown only fires when a mail is actually sent — surface that error and two
submissions a minute apart reveal which addresses are registered. Note the asymmetry with signup,
which **does** disclose that an email already has an account: that was accepted knowingly there, and
reset must not be "fixed" to match it.

The landing route is **top-level** (`/reset-password?shop=<slug>`), outside the storefront shell.
Nested, the shell's merchant-status gate would swallow the page — and a shop being suspended must
never lock a customer out of their own account. It is role-blind: with a shop it returns the customer
to that storefront, without one to the merchant dashboard. The `shop` param arrives from a link that
has been through an inbox and is used to navigate, so it is checked against the slug shape before use
(`resetPassword.ts`) — an open redirect would start exactly there.

The 8-character floor is `@bitetime/shared`'s, enforced in **both** places it can be: the client, and
GoTrue itself (`minimum_password_length` in `config.toml`), because reset writes the password
straight from the browser and GoTrue's own default floor is 6.

## Billing lifecycle

A merchant's platform-subscription journey. **Signup is cardless and provisions
its own trial** — every signup, with no second door: `POST /api/merchants`
creates the 7-day trialing Stripe subscription via `startCardlessTrial`
(`trialSubscription.ts` — the only place a trial is ever granted) and activates
the shop, so the clock starts at signup. A shop stays `pending` only when that provisioning did not finish: its
owner retries with `POST /api/merchants/:id/start-trial`, and
`POST /api/admin/approve-merchant` is the admin-side fallback for one nobody
retried. While `trialing`, the dashboard shows a
persistent countdown banner (urgent inside 72h) whose CTA opens the Stripe
billing portal; Stripe's `trial_will_end` webhook sends the 72h reminder email.
Trial end with no card → Stripe cancels the subscription
(`missing_payment_method: 'cancel'`) → the `subscription.deleted` webhook
suspends the shop. Suspended shops serve a closed storefront and reactivate
through a fresh Checkout that never re-grants a trial (`canStartTrial`). Failed
renewals go `past_due` and the shop stays open for **3 days**
(`PAST_DUE_GRACE_DAYS` in `@bitetime/shared/dunning.ts`), after which the hourly
reconciliation sweep suspends it — even though Stripe still reports `past_due`.

That deadline exists because dunning does not reliably END: the trial has an end
behaviour (`trial_settings.missing_payment_method: 'cancel'`) but a failed
renewal has none, and Stripe's default after its final retry is to leave the
subscription `past_due` for ever — so a shop whose card died stayed `active` and
kept selling, re-read hourly and called healthy every time. The clock runs from
the unpaid period's START (`merchant_billing.current_period_start`), because
Stripe advances the period when it issues the unpaid invoice and
`current_period_end` is then a month away; for the same reason a `past_due` row
is always in the sweep's worklist, whatever its stored deadline says. The rule is
in `@bitetime/shared` because the backend CLOSES on it and the dashboard COUNTS
DOWN to it, and those two dates may not disagree.

Three days is a short window, so the merchant is told, every day of it. The sweep
sends one reminder a day (`past_due_notified_at` is what stops it sending
twenty-four, one per hourly run) naming the date the shop closes, and one further
email when it actually closes. The dashboard banner counts the same days down.

**Paying reopens the shop, by itself.** A dunning closure is stamped
(`dunning_suspended_at`), and `customer.subscription.updated` — with the sweep as
the hourly backstop — reopens the stamped shop the moment Stripe reports the
subscription live again, clearing both dunning marks. The stamp is also what
keeps that honest: without it a dunning closure is indistinguishable from a
moderation suspension (both are `suspended` beside a live subscription), and
`syncMerchantBilling` refuses to reopen the latter for a payment (its
`suspended_by_admin` reason). A closed shop's owner sees a **different**
`SuspendedScreen`: not the reactivation Checkout — `POST /api/checkout` refuses a
shop whose subscription is still live, so that button is a dead end here — but
the Stripe portal, where the outstanding invoice is. Stripe is the
single source of billing truth; `merchant_billing` mirrors it. Pure seams:
`billingLifecycle` (backend) and `billingBannerState` (frontend).

Opening a paid shop does **not** depend on a webhook arriving. Back from
Checkout, the dashboard calls `POST /api/billing/sync` (`billingSync.ts`) on a
bounded schedule — it re-reads the subscription from Stripe and makes the
database agree, so a lost `checkout.session.completed` no longer strands a
charged merchant on a screen that polls forever. Narrower than the webhook: a
shop suspended while its subscription still runs was closed by a human and is
not reopened by paying. See ADR 0014.

## Trial feedback

A one-time, platform-initiated survey — not to be confused with the
merchant-initiated, open-ended complaint box behind the dashboard's feedback
button (`merchant_feedback` table, categories bug/feature/billing/other).
Once a shop's
`trial_ends_at` has passed, a daily sweep (a GitHub Actions cron, the first
scheduled — as opposed to webhook- or request-driven — job in this backend;
see `docs/adr/0011-trial-feedback-is-a-cron-sweep-not-a-webhook.md`) emails
the merchant once, asking about the trial itself, independent of whether it
converted, is still trialing, or ended in suspension. The email links to the
dashboard (login required, same as the existing trial reminder) where a
1–5 star rating (required) plus an optional comment can be given from
whichever shell the shop's status routes the merchant to — `Dashboard` or
`SuspendedScreen`. Declining is permanent: dismissing the prompt marks it
skipped and it never reappears. Only trials ending after this feature ships
are surveyed; no backfill for trials that already ended. Superadmins read
responses on their own admin page, separate from `AdminFeedback`'s complaint
inbox.

## Subscription

**One plan.** There is no tier, and entitlement is not a field: a shop that is
**`active` can use everything the product does**, and a shop that is not is shut
— its storefront refuses every order and its dashboard is locked. Nothing in the
hot paths asks about billing, which is what the tier gate was always careful not
to make them do. See [ADR 0016](docs/adr/0016-one-plan.md).

**The price is Stripe's, and only the cycle is ours to record.** `env.prices` is
two MYR Price IDs keyed by billing cycle, and `reconcileBillingCycle`
(`billing.ts`) reads the price currently on the subscription and maps it back
through `cycleFromPriceId` (`pricing.ts`, the inverse of `priceId`) to write
`merchants.billing_cycle`. It runs on `customer.subscription.updated` and
`checkout.session.completed`, so the column follows the money rather than the
signup body. An **unrecognised price is a no-op**: guessing there would write a
renewal date the shop is not on, and a stale column is the cheaper failure.

**Every amount on every page comes from Stripe at runtime** through
`GET /api/pricing`, cached briefly. No price is written down in this repo —
`FALLBACK_PRICING` in `usePlatformPricing.ts` is a last-resort render value, not
a quote — so changing what a shop pays is a Stripe dashboard action and nothing
else.

**Winding down happens here, not in the portal.** Two routes,
`POST /api/billing/{cancel,resume}`, cancel at period end and undo that. They are
ours rather than Stripe's because they land on a **period boundary**: cancelling
is a flag, so no money moves at the click and there is nothing a payment screen
must explain. What that buys is the sentence the portal cannot say — *cancelling
suspends this shop, on this date*. `merchant_billing.cancel_at_period_end` is
what makes a winding-down subscription visible at all: Stripe leaves `status` on
`'active'` until the day it ends, which is how the Subscription tab once promised
"Renews on 1 Sep" to a merchant whose shop was suspended on 1 Sep. See
[ADR 0005](docs/adr/0005-winding-down-happens-in-the-dashboard.md).

**A comp means billing does not apply**, and `merchant_billing.comped` is that
fact rather than an inference from a shape. Granted by superadmin
`comp-merchant` (partners, staff, promo shops) and revoked by `uncomp-merchant`,
which clears the flag so the shop has to pay like any other. The column is
deliberately apart from `status`: **`status` stays what Stripe says, `comped`
stays what we say.** Everything a comped shop cannot do keys off it — the
Subscription tab turns every billing action off (`subscriptionTabState`), the
reconciliation sweep skips it, and the backend refuses `/api/checkout`,
`/api/billing/portal` and both wind-down routes with `409 shop_is_comped`
**before any Stripe call**. Two invariants earned the hard way: comp **clears
`stripe_customer_id`** (a stale one is what sent a test-mode id to Stripe under a
live key and answered 502) but **keeps `stripe_subscription_id`**, which
`canStartTrial` reads as the one-trial-ever record; and un-comp winds
`status`/`current_period_end` back to null, because those were comp's own writes
and leaving them makes checkout refuse the shop for a subscription it never had.
Comping a shop that really is paying is refused outright
(`409 has_live_subscription`) — cancel in Stripe first.

**Lapsing suspends, and stops there.** `lapseMerchant` writes
`status = 'suspended'` and nothing else. A closed shop's vouchers, sale prices,
menu options and categories are unreachable rather than revoked, and they work
again the day it resubscribes — there is no tier left for the shop to be dropped
to, and nothing to switch off on the way out.

**Buying is Stripe's job, by one of two routes, decided by whether there is a
subscription to change.** With one, the **Customer Portal** manages the card and
the invoices. Without one — a shop whose comp was revoked, or whose subscription
lapsed before a superadmin reopened it — **Checkout** sells a new subscription
outright. The two can never both apply: `POST /api/checkout` refuses exactly
`trialing`/`active`/`past_due`, the complement of the portal's population, so
neither path can create a second subscription. **Settings → Subscription** is the
shop-side screen: it shows the price and the renewal date, and offers whichever
of the two applies.

## Storage buckets

Five, and the split that matters is **which of them the browser can reach**. Every column that
points at one holds a **path**, never a URL.

| Bucket | Public? | Who writes | Who reads |
|---|---|---|---|
| `product-images` | yes | browser, direct, RLS-scoped to the merchant's own folder | anyone (the storefront needs it) |
| `payment-qr` | yes | browser, direct, same folder policy | anyone (a guest sees it on the order-placed screen) |
| `payment-proof` | **no** | backend, service role | backend, service role |
| `sample-shop-screenshots` | yes | backend, service role (the weekly sweep) | anyone |
| `feedback-images` | **no** | backend, service role | backend, service role |

The two private buckets have **no `storage.objects` policies at all**. That is not an omission:
with `public: false` and zero policies, `anon` and `authenticated` get nothing in either
direction, and `tests/rls/payment-proof-storage.test.ts` and
`tests/rls/feedback-images-storage.test.ts` are the proof — no app surface exercises either
bucket from the browser, so a migration that flips one public is caught only there.

`feedback-images` holds up to three screenshots per merchant feedback submission, at
`{merchant_id}/{feedback_id}/{uuid}.{ext}`. Written by `POST /api/merchants/:id/feedback` after
the row commits; read only by a superadmin through
`GET /api/admin/feedback/:feedbackId/images/:index`, which indexes into the row's own
`image_paths` array rather than accepting a path from the caller — that is what makes one
feedback row's screenshots unreachable from another's.

It is private for a reason worth stating plainly: **the platform repo is public**, feedback is
auto-filed there as an issue, and a merchant's bug screenshot is usually their own dashboard —
customer names, phone numbers, delivery addresses. The issue body states the screenshot count
and links the admin dashboard (`/admin#feedback` — a hash, since the admin sections are hash
segments of one route). It carries no image URL, signed or otherwise, and must not grow one.
