# Domain glossary

Names for the load-bearing concepts in the ordering app. Use these terms in code, tests, and reviews.

## Order pricing

The deep, pure module (`packages/shared/src/pricing.ts`) that turns a cart + context into a money breakdown. Single source of truth for every total the app **shows** and every total the backend **charges** — it lives in `@bitetime/shared` for exactly that reason. Owns shipping-region selection, promo price resolution, voucher discount, referral discount, and tax — in that order. No I/O: the clock, the loaded voucher, the sameday quote, and the resolved referral are all passed in.

**The backend is the price authority.** The Storefront's `priceOrder` call is a *quote*, for display; the backend's, inside the order transaction, is the *charge*. `POST /api/orders` carries a cart (`{productId: qty}`) and `quotedTotal` — the number the customer saw — and no prices at all: `items`, `total`, `shipping_fee`, `discount`, `tax`, `tax_rate` and `currency` are every one derived from the shop's own rows. The quote is **checked, never trusted**. A disagreement is refused (`price_changed`) and the whole transaction rolls back — not even a counter slot is burnt — so a customer is never charged a number they did not confirm, and a stale quote never buys a withdrawn discount. Before this, a client could POST `total: 0` and the order committed at zero.

One input to that derivation still comes from the body, and it is worth naming: the shipping **rate** is read from `merchants.shipping`, but the shipping **region** is read from the delivery address's `state` — the parcel's own destination, which only the customer can say. So the fee is *charged from the shop's rows, for the region the customer declared*. A `delivery` that declares no state is **refused** (`delivery_state_required`), never priced: with no state, `shippingFee` falls through to 0, and the shop would ship to Sabah for free. The rest — quantities aside, and those are capped — the client cannot influence at all. The same shape holds under *Shipping policy* below: the **routed distance** is likewise a destination fact the shop cannot know, and it is likewise never taken from the body.

- **`priceOrder(input) -> PriceBreakdown`** — the one interface, called on **both** sides of the wire. Returns `{ lines, subtotal, shipping, discount, tax, taxRate, total }`. The `lines` carry resolved unit prices, so the order row, the success screen and the Telegram message consume the breakdown instead of re-deriving it.
- **`voucherError(voucher, ctx) -> string | null`** — pure voucher rules. The **browser's pre-flight only**; the backend enforces redemption under a row lock in `claimVoucher` instead. Three of its six codes (`min_order`, `expired`, `not_assigned`) can never fire, because no column backs them — see #71.
- **`voucherFromRow(row) -> PricedVoucher`** — the `vouchers` row → domain mapping, shared because both sides price from the same rows. Coerces `amount`, which **postgres.js returns as a string**.
- **`shopRates(shipping) -> { WM, EM }`** — the `merchants.shipping` jsonb → rates mapping, shared for the same reason: the two sides disagreeing is now a refused checkout, not a rounding difference. A missing `EM` falls back to `WM`, never to 0 — a 0 would ship to East Malaysia free.
- **`shopTax(row) -> { enabled, rate }`** — the `merchants.tax_enabled` / `merchants.tax_rate` columns → the tax `priceOrder` charges, `shopRates`'s twin and shared for the identical reason: the browser quotes and the backend charges, and a disagreement between them is not a rounding gap, it is a `price_changed` refusal for every order at that shop. The fallback is always OFF — a shop that never configured tax, or an unparseable rate, must fail to NO tax rather than to a number nobody chose. An enabled 0% is normalised to disabled, so every consumer has one thing to test instead of two that must agree.
- **`promoState(product, now) -> { price, remaining } | null`** — is this product's promo running, and for how many more units (`Infinity` when uncapped). See *Promo* below.
- **`productFromRow(row) -> PricedProduct`** — the `products` row → domain mapping, shared for the same reason as `voucherFromRow`: the columns are snake_case, the fields are not, and **postgres.js returns `numeric` as a string** while PostgREST returns a number. `PricedProduct` keeps an index signature, so a *raw* row still type-checks as one — with `promoPrice: undefined`, hence no promo, silently, with **no compiler error**. Map one side and not the other and every promo checkout is refused. The cross-driver test in `pricing.test.ts` is what holds that shut; the type system cannot.

`mode` is an **allowlist** (`pickup` | `delivery`), not a free string, and that is a price rule: `mode` selects the shipping fee, so any unrecognised value prices shipping at 0. `sameday` is deliberately absent — it is unreachable from the Storefront and has no rate behind it. The cart is capped at the door too (≤ 1000 per line, ≤ 100 lines, `invalid_body`): `Number.isInteger(1e21)` is true, and the price check cannot catch a quantity the client both asks for and quotes.

A **cart key must be a canonical (lowercase) uuid** — the regex has no `i` flag, and that is money, not style. Postgres compares `uuid` case-insensitively and JavaScript `===` does not: an uppercase key matched the row in `= any(…::uuid[])`, sailed past the "every requested id came back" refusal, and then matched *nothing* in `priceOrder`'s `products.find(p => p.id === id)` — so the line was silently dropped, the cart priced at 0, and on a pickup `quotedTotal: 0` agreed with it. Any product, any quantity, committed free. **Refuse a non-canonical key; do not normalise it** — lowercasing would let the upper- and lowercase forms of one id merge into a single line at double the quantity, walking past `MAX_CART_QTY`.

There is no order-level referral discount. The legacy `referral` input and `referralDiscount` output were removed (#70) — the referral program is a **subscription** reward (see *Referral* below), not a discount on a customer's food order.

Rounding is `parseFloat(toFixed(2))` per step, and the quote/charge comparison is made in whole cents.

## Shipping policy

Which rule turns a delivery into a fee. A shop has **exactly one**, named by `merchants.shipping_mode`, and the other policy's configuration stays stored but dormant — the same arrangement as a disabled shop keeping its `tax_rate`.

- **Region pricing** — the original and the default for every existing shop. A flat rate per region (`WM` / `EM`), selected by the state the customer declared. See *Order pricing* above.
- **Distance pricing** — `fee = base + rate × routed distance`. Two merchant-typed numbers and an optional `max_km`. A shop that wants pure per-km sets `base` to 0.

**Delivery origin** — the shop's geocoded start point, chosen once in Shop Settings through address autocomplete and stored as a place id plus coordinates. Distance mode **cannot be switched on without one**; that is a validation, not a fallback. Not to be confused with `pickup_address`, which is display-only free text for the pickup blurb and is never routed — a string re-resolved on every call would drift the shop between quote and charge.

**Routed distance** — road kilometres from the shop's origin to the customer's destination, **rounded to one decimal before the rate multiplies it**. That order matters and is not cosmetic: the receipt line reads `Delivery fee (25.2 km)`, so the km on the line must be the km that produced the money. (The label keeps the house term used on every other surface — the storefront summary, the confirmation, the receipt and the order history all say `Delivery fee` / `送货费`; only the distance is appended. One order must not wear two words for one charge.) Rounding after would print 25.2 km beside a fee computed from 25.216. It is *road* distance, not straight-line — a straight-line number would understate what the rider actually drives by roughly a third, and merchants would set their rate against a lie.

**Distance quote** — a cached `(origin, destination) → metres` row, keyed by the two place ids. The 30-day expiry (the cap Google's terms allow) is enforced by the **reader**, inclusively (`created_at >= cutoff`) — nothing sweeps expired rows; a row written exactly at the cutoff still counts as fresh. It is what makes the quote and the charge the same number without asking Google twice: both the storefront's quote and order intake's cache-miss lookup read the row first and write it on a miss, sharing the identical read-then-lookup-then-write logic. A merchant who moves their shop changes the origin place id and so invalidates their own cache with no sweep. On a miss at intake the distance is fetched again — **before the order transaction opens**, never inside it, because the transaction holds the shop's counter lock and a Google round-trip under that lock serialises the whole shop's intake behind Google's latency. A distance that moved in the meantime surfaces as the ordinary `price_changed` refusal, which the customer resolves by confirming the new total.

**Distance failures fail closed.** No fee is ever invented for an address that could not be routed, and the two failures are told apart because only one of them is worth retrying: an address with **no road route** is refused as out-of-range, the same answer as beyond `max_km` and the same message, because it is the same fact — that shop does not deliver there. Only a genuine API error says "try again". Falling back to the dormant region rate was rejected: it charges by a formula the shop switched off, under a receipt line that cannot honestly name a distance.

The distance is a **destination fact the client cannot be trusted to state**, so it is never read from the request body, and the quote endpoint takes a place id rather than free text. That is an **API-shape deterrent, not a validation** — any non-empty string is accepted, because place ids have no stable public format and a shape check would refuse legitimate addresses; free text would also let a caller mint unlimited distinct destinations, and every distinct destination is a billable call on the platform's own Maps account. What actually bounds the spend is a per-IP sliding window (cheap flood protection) plus a **per-merchant daily ceiling** on provider calls — charged only on a cache miss, since a hit costs nothing — keyed on the shop's own canonical row id, which a caller cannot re-spell by varying the request. **Order intake is a second spender on that same per-merchant ceiling, not just a reader of what the quote endpoint cached**: its own cache-miss path draws on the identical bucket (one Google bill, one shop, one ceiling) and adds a per-IP bound of its own on the miss path only — a courtesy against accidental hammering, not the abuse control the per-merchant ceiling is.

A percent voucher still discounts `subtotal + shipping`, unchanged. Worth knowing that this bites harder here: 20% off an RM8 flat rate gives away RM1.60 of shipping, the same voucher against an RM31.20 distance fee gives away RM6.24 — and that is the merchant's rider cost, not their food margin. Left as-is deliberately; changing the discount base would move totals at every shop that never asked for distance pricing.

## Promo

A reduced price on one product, optionally ending on a date and optionally capped at a number of units. Four columns on `products`: `promo_price`, `promo_limit` (null = uncapped), `promo_end` (null = no end date), `promo_sold` (the counter).

**A promo exists iff `promo_price is not null`** — never `> 0`. A promo of `0.00` is a **free item**, and it is a real promo; a truthiness test would silently price it at base. An empty dashboard field stores `null`, which is what "no promo" means. A promo with neither a cap nor an end date simply runs until the merchant clears the price.

**The cap binds per unit, so a line splits.** A cart of 10 against 3 remaining promo units is **3 at the promo price and 7 at base**, not 10 of either — all-or-nothing would let a cap of 3 sell 100 promo units to one order, which is not a cap. Two `PriceLine`s therefore carry the **same product id**, and two entries land in the order's `items` jsonb. Anything rendering those lines **keys by index**: keyed by id, React drops one row from the screen while the customer is charged for both.

**The cap is claimed inside the order transaction**, under `select … for update` on the product rows — the `claimVoucher` pattern, for the identical reason: without the lock two concurrent checkouts both read the last unit and both take it. Lock order is **counter → voucher → products**, and `order_counters` is one row per merchant, so it serialises a shop's intake before any product row is touched. A promo that sells out between quote and submit surfaces as the existing **`price_changed`** refusal — the customer is shown the new total and confirms it, never quietly charged more. *(Note: because every intake serialises on the counter first, the two-concurrent-intakes test does not actually exercise the product lock — a separate test holds the last unit open on a second connection to do that. Do not delete it thinking the race test covers it.)*

**`promo_sold` is not writable from the browser.** A `before insert or update` trigger pins it for every role except `postgres` / `service_role` / `supabase_admin`, and the backend re-reads the counter (`returning`) to confirm it actually moved rather than trusting the UPDATE. The dashboard upserts the *whole* product row, so a merchant editing a product's **name** mid-checkout would otherwise write back a `promo_sold` read before the sale and rewind the cap. Same rule as `orders.user_id` and the voucher key: **a counter the client can write is not a counter.** The trigger is `security invoker` **on purpose** — `current_user` must be the caller's role, and making it `security definer` (the style of the other guards in that directory) would make it `postgres` on every call and disable the pin entirely.

The counter **survives a cap edit** and resets **only when the promo price changes**: 10 sold against a cap of 10, cap raised to 20, means ten more units — not twenty. A new price is a new promo. A **cancelled order never returns its units** to the cap; the merchant resets the count by changing the price.

**The browser prices the promo window against the *server's* clock** (`GET /api/time` → `serverClock.ts`), and this is not fastidiousness. `priceOrder` runs on both sides and a disagreement is a hard refusal, so the clock is a **price input**: a device minutes off ours, on the promo's last day, would quote the promo, be refused, re-quote *with the same skewed clock*, and be refused again — a permanent refusal loop for a legitimate customer, at the promo's busiest moment. A menu refetch cannot repair a clock; only the sync can. `promo_end` is a `timestamptz` (an absolute instant) for the other half of the same bug: `new Date(dateStr + 'T23:59:59')` parses as **local** time, putting a UTC server eight hours from a UTC+8 customer. A failed sync falls back to the device clock — the old behaviour — and **that fallback alone does not recover** (I-3, #69): if `/api/time` is persistently unreachable while `POST /api/orders` still works, `resync()` keeps failing, the offset stays 0, and a `price_changed` retry that only re-syncs the clock re-quotes against the same skewed offset and is refused again, forever. What actually closes the loop is that `price_changed` itself carries the server's clock in its body (`app.ts`'s OrderError handler stamps `now`) — the refusal that proves the connection works also states the time, so `refreshQuoteSources` **adopts** that timestamp (`serverClock.ts`'s `adopt()`) instead of re-fetching `/api/time`, and recovery needs no second endpoint that could fail the same way.

The promo's end-of-day is in the timezone of the browser the **merchant** set it from. A shop has no timezone of its own; that is out of scope, and it is why `promoEnd.ts` exists rather than an inline date cast.

## Order intake

The flow that collects a cart and customer details and commits an order: `collect → priceOrder → placeOrder → notifyOrder`. The multi-tenant **Storefront** (`store/Storefront.tsx`) is the only intake path; the legacy single-tenant order form has been deleted.

## Voucher

A per-merchant promotion code. `percent` (subtotal×value/100) or fixed (`min(value, total)`). Validation rules live in `voucherError` (the browser's pre-flight); the discount math lives in `priceOrder`; the claim lives in `claimVoucher`, under a row lock, inside the order transaction.

**A voucher requires an account.** The one-per-customer key is the **verified JWT's email** and nothing else. A guest has no verified identity, so their claim cannot be keyed to anything they cannot also change — and an unkeyable claim is *refused* (`voucher_requires_account`), never keyed on `''`. The key used to be `voucherEntry`, a string the **request body** supplied: the same person re-redeemed a one-per-customer voucher forever by varying it (`a@b.com`, `a+1@b.com`, `x`), and a voucher with a null `max_uses` was an unlimited discount for one person (#72). A key the client can name is not a key — the same rule that already governs `user_id`. The storefront's voucher section offers sign-in when signed out; the Checkout gate is untouched and guest checkout is still one tap. It just cannot carry a discount.

**This is friction, not a wall — do not read it as airtight.** A customer account is free to mint: signup is **pre-confirmed** (`email_confirm: true`) and a customer's email is never verified, deliberately (see *Customer signup*). So the abuse is not eliminated, it is *priced*: an extra redemption now costs a signup with an unused address, is subject to the signup rate limit, and arrives as a real order the merchant sees and fulfils, rather than an invisible string swap. The cap is **per-mailbox, not per-human** — `a+1@gmail.com` is a distinct Supabase account. Making it genuinely airtight means real email verification, which reverses a deliberate product decision and is its own work.

`used_by` still holds WhatsApp numbers from historical guest redemptions. They are a key that can no longer be produced and will never match again; someone who redeemed as a guest gets one more redemption from an account, and their stale entry still eats a `max_uses` slot. Not cleaned up — rewriting them would mean guessing which number belonged to which account.

## Referral

Two things share the name.

**Referral capture** — live. A merchant signs up under another member's code, which is stamped on `merchants.referred_by_code`; the referrer can list the shops they brought in (`GET /api/referrals/shops`). A member's code is the first 8 hex characters of their user id, uppercased. The code is always derived from the caller's verified identity, never accepted from the request — a referrer's shops are not their own tenant, so reading them is a cross-tenant read, and the un-choosable code is the only thing that makes it safe. Display-only: no reward is granted.

**Referral reward** — a **subscription** reward, not an order discount (decided in #70, `docs/prd-referral-reward.md`). When a merchant who signed up under a member's code pays their **first invoice**, that referring member earns **one month free of their own plan** — a credit on their Stripe customer balance, valued at their current plan (yearly → annual ÷ 12). The referred merchant gets nothing. Stacks with no cap, granted once per referred shop, no clawback. The old order-level `referral`/`referralDiscount` path in `priceOrder` was deleted — a customer typing a code at checkout for money off their food was never this program.

## Customer signup

How a customer account comes into being. Email confirmation is on **project-wide** and stays on — it is shared with merchants, and a merchant account controls a shop and its Stripe billing. A client-side `signUp` would therefore return no session, stranding a customer mid-checkout in their inbox holding a cart, so customers are minted **pre-confirmed** by the backend instead (`POST /api/customer/signup` → `admin.auth.admin.createUser({ email_confirm: true })`), and the client signs in normally. Pure seams: `customerSignup` (policy; the account-creation and profile writes are injected adapters), `rateLimit` (clock-injected sliding window), `clientIp` (backend), `signupError` (frontend).

Three trade-offs are load-bearing, not incidental:

- **A customer's email is never verified.** Self-correcting: whoever owns the address reclaims it by password reset, and we send customers no other mail.
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

A merchant's platform-subscription journey. Basic signup is cardless and lands
`pending`; **superadmin approval** creates the 7-day trialing Stripe
subscription (the only place a trial is ever granted) and activates the shop —
the trial clock starts at approval. While `trialing`, the dashboard shows a
persistent countdown banner (urgent inside 72h) whose CTA opens the Stripe
billing portal; Stripe's `trial_will_end` webhook sends the 72h reminder email.
Trial end with no card → Stripe cancels the subscription
(`missing_payment_method: 'cancel'`) → the `subscription.deleted` webhook
suspends the shop. Suspended shops serve a closed storefront and reactivate
through a fresh Checkout that never re-grants a trial (`canStartTrial`). Failed
renewals go `past_due` (red banner) and ride Stripe dunning. Stripe is the
single source of billing truth; `merchant_billing` mirrors it. Pure seams:
`billingLifecycle` (backend) and `billingBannerState` (frontend).
