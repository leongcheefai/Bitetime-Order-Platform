# Domain glossary

Names for the load-bearing concepts in the ordering app. Use these terms in code, tests, and reviews.

## Order pricing

The deep, pure module (`apps/frontend/src/pricing.ts`) that turns a cart + context into a money breakdown. Single source of truth for every total the app shows. Owns shipping-region selection, promo price resolution, voucher discount, and referral discount — in that order. No I/O: the clock, the loaded voucher, the sameday quote, and the resolved referral are all passed in.

- **`priceOrder(input) -> PriceBreakdown`** — the one interface. Both the storefront and the legacy order form call it. Returns `{ lines, subtotal, shipping, discount, referralDiscount, total }`. The `lines` carry resolved unit prices so the success screen and the Telegram message consume the breakdown instead of re-deriving it.
- **`voucherError(voucher, ctx) -> string | null`** — pure voucher rules (expiry, `usedBy`, assignment, `minOrder` gate). Loading the codes stays I/O in the caller; the rules are testable without a network.
- **`effectivePrice(product, now)`** — promo resolution (`promoActive` by date/limit). Storefront historically ignored promos; folding it here closes that drift.

Discount order is load-bearing: voucher applies to items+shipping, then referral applies to the post-voucher total (`min(amount, totalAfterVoucher)`). Rounding is `parseFloat(toFixed(2))` per step.

## Order intake

The flow that collects a cart and customer details and commits an order: `collect → priceOrder → placeOrder → notifyOrder`. Two intake paths exist today — the multi-tenant **Storefront** (`store/Storefront.tsx`) and the legacy single-tenant **order form** (`components/OrderForm.tsx`); unifying them depends on Order pricing landing first.

## Voucher

A per-merchant promotion code. `percent` (subtotal×value/100) or fixed (`min(value, total)`). Validation rules live in `voucherError`; the discount math lives in `priceOrder`.

## Referral

A discount earned by referring a new customer. Capped at the post-voucher total. The cap math is in `priceOrder`; the referrer lookup and new-customer check are I/O in the caller (`fetchProfileByReferralCode`, `isNewCustomer`).

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
