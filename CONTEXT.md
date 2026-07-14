# Domain glossary

Names for the load-bearing concepts in the ordering app. Use these terms in code, tests, and reviews.

## Order pricing

The deep, pure module (`packages/shared/src/pricing.ts`) that turns a cart + context into a money breakdown. Single source of truth for every total the app **shows** and every total the backend **charges** — it lives in `@bitetime/shared` for exactly that reason. Owns shipping-region selection, promo price resolution, voucher discount, and referral discount — in that order. No I/O: the clock, the loaded voucher, the sameday quote, and the resolved referral are all passed in.

**The backend is the price authority.** The Storefront's `priceOrder` call is a *quote*, for display; the backend's, inside the order transaction, is the *charge*. `POST /api/orders` carries a cart (`{productId: qty}`) and `quotedTotal` — the number the customer saw — and no prices at all: `items`, `total`, `shipping_fee`, `discount` and `currency` are every one derived from the shop's own rows. The quote is **checked, never trusted**. A disagreement is refused (`price_changed`) and the whole transaction rolls back — not even a counter slot is burnt — so a customer is never charged a number they did not confirm, and a stale quote never buys a withdrawn discount. Before this, a client could POST `total: 0` and the order committed at zero.

One input to that derivation still comes from the body, and it is worth naming: the shipping **rate** is read from `merchants.shipping`, but the shipping **region** is read from the delivery address's `state` — the parcel's own destination, which only the customer can say. So the fee is *charged from the shop's rows, for the region the customer declared*. A `delivery` that declares no state is **refused** (`delivery_state_required`), never priced: with no state, `shippingFee` falls through to 0, and the shop would ship to Sabah for free. The rest — quantities aside, and those are capped — the client cannot influence at all.

- **`priceOrder(input) -> PriceBreakdown`** — the one interface, called on **both** sides of the wire. Returns `{ lines, subtotal, shipping, discount, referralDiscount, total }`. The `lines` carry resolved unit prices, so the order row, the success screen and the Telegram message consume the breakdown instead of re-deriving it.
- **`voucherError(voucher, ctx) -> string | null`** — pure voucher rules. The **browser's pre-flight only**; the backend enforces redemption under a row lock in `claimVoucher` instead. Three of its six codes (`min_order`, `expired`, `not_assigned`) can never fire, because no column backs them — see #71.
- **`voucherFromRow(row) -> PricedVoucher`** — the `vouchers` row → domain mapping, shared because both sides price from the same rows. Coerces `amount`, which **postgres.js returns as a string**.
- **`shopRates(shipping) -> { WM, EM }`** — the `merchants.shipping` jsonb → rates mapping, shared for the same reason: the two sides disagreeing is now a refused checkout, not a rounding difference. A missing `EM` falls back to `WM`, never to 0 — a 0 would ship to East Malaysia free.
- **`effectivePrice(product, now, sold)`** — promo resolution (`promoActive` by date and quantity limit).

`mode` is an **allowlist** (`pickup` | `delivery`), not a free string, and that is a price rule: `mode` selects the shipping fee, so any unrecognised value prices shipping at 0. `sameday` is deliberately absent — it is unreachable from the Storefront and has no rate behind it. The cart is capped at the door too (≤ 1000 per line, ≤ 100 lines, `invalid_body`): `Number.isInteger(1e21)` is true, and the price check cannot catch a quantity the client both asks for and quotes.

Promo is **unbuilt**, not unwired: `products` has no `promo_price`/`promo_limit`/`promo_end` column and the dashboard offers no promo field, so `promoActive` is always false and no merchant has ever been able to set a promo, capped or otherwise (#69). The `referral` input likewise has no caller, so `referralDiscount` is always 0 (#70). Do not read either as live behaviour.

Discount order is load-bearing: voucher applies to items+shipping, then referral applies to the post-voucher total (`min(amount, totalAfterVoucher)`). Rounding is `parseFloat(toFixed(2))` per step, and the quote/charge comparison is made in whole cents.

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

**Referral discount** — a discount on a customer's order, capped at the post-voucher total. The cap math is in `priceOrder`, which takes a resolved `referral` as input — but nothing supplies one, so this does not currently run. Reconnecting it is not a wiring job: the legacy program was two-sided (a first-order discount for the referred customer *and* a gift product for the referrer, merchant-confirmed), and it needs a product decision first. See #70 and Order pricing.

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
