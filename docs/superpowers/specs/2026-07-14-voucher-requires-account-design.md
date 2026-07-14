# A voucher claim is keyed to a verified account

**Date:** 2026-07-14
**Issue:** #72
**Status:** approved, not yet implemented

## The hole

`POST /api/orders` takes `voucherEntry` from the request body and hands it to `claimVoucher`
(`apps/backend/src/orders.ts`), which uses it as the **one-per-customer key**:

```ts
if (voucher.used_by.includes(entry)) throw new OrderError('voucher_already_used')
```

Nothing binds `entry` to the caller. A signed-in customer's JWT is verified and used for
attribution (`user_id`), but the voucher key is whatever string the body says. So the same
person redeems a "one per customer" voucher as many times as they like:

```
voucherEntry: "ah@meng.com"    → claimed
voucherEntry: "ah+1@meng.com"  → claimed again
voucherEntry: "x"              → claimed again
```

When `max_uses` is null — "unlimited in total, still 1/customer", per the schema comment —
the discount is **unlimited for one person**. This is live, and it is money.

Pre-existing (inherited from the dropped `redeem_voucher`), but #68 sharpens it: that branch
made the discount **amount** authoritative and derived server-side. The **eligibility** stayed
client-asserted. "The backend prices the order" now reads as though it vouches for the whole
voucher, and it does not.

## The decision

**A voucher requires an account.** The claim key is *always* the verified JWT's email; a guest
cannot apply one.

The alternative considered and rejected was keying a guest's claim on the canonicalised digits
of their `customerWa`. It is softer — a guest who varies the number to re-redeem gives the
merchant a wrong contact and loses their own order, so the spoof has a real cost — but it is
still a spoof, and it would have left the leak open for the path most likely to be abused.

The cost of the decision is real and is accepted: **a first-time customer holding a promo code
now meets a sign-in prompt.** Guest checkout stays first-class and one tap; it just cannot
carry a discount.

### What this fix does NOT buy — read this before trusting it

**It is not airtight, and it must not be described as such.** A customer account is *free to
mint*: `POST /api/customer/signup` creates the user **pre-confirmed** (`app.ts`,
`email_confirm: true`), and that is deliberate — `CONTEXT.md` states it outright, *"a customer's
email is never verified"*, because a client-side `signUp` returns no session and would strand a
customer mid-checkout holding a cart.

So the attack is not eliminated. It is **priced**:

| | before | after |
|---|---|---|
| cost per extra redemption | change one string in the request body | one signup call, one unused email address |
| rate limited | no | yes (in-memory; useless past one backend instance) |
| visible to the merchant | no | yes — every redemption is a real order they see and fulfil |

That is a genuine improvement and worth shipping today: it kills a free, invisible, unlimited
bypass. But **the cap is per-mailbox-string, not per-human** — `a+1@gmail.com` is a distinct
verified Supabase account — and anyone reading "a voucher requires an account" as "a voucher
requires a *person*" will be wrong.

Making it actually airtight means real email verification for customers, which reverses a
deliberate, documented product decision and is its own piece of work. Filed separately rather
than smuggled in here.

## Design

### Backend — the client never speaks the key again

`voucherEntry` leaves the wire. `app.ts` already verifies the JWT and already passes
`userId: user?.id ?? null` on exactly this principle; it now also passes
`userEmail: user?.email ?? null`. `PlaceOrderInput` swaps `voucherEntry` for `userEmail`.

Inside the transaction:

- A `voucherCode` with no verified email → **`voucher_requires_account`** (new `OrderErrorCode`).
  A Supabase user with no email address (phone-only auth) lands here too, which is correct — an
  unkeyable claim is refused, never keyed on `''`.
- `claimVoucher` keys `used_by` on the token's email, lowercased.

The existing **`voucher_entry_required` code is deleted**. It guarded an empty entry; the only
way to have no entry now is to have no account, and that has its own code. It is a wire
contract, so it comes out of the frontend's twin `OrderErrorCode` and out of `VOUCHER_REFUSALS`
with it.

The body no longer carries a key. There is nothing left to vary.

### Frontend — the voucher section asks you to sign in

`Storefront.tsx`'s `voucherEntry` (`(account?.email || wa).trim().toLowerCase()`) becomes the
account email alone — the browser's `voucherError` pre-flight must key on the same thing the
server will.

When signed out, the voucher section's code input and Apply button are replaced by a quiet
"Sign in to use a voucher" prompt wired to the existing `SignInDialog`. Not a wall in the
checkout path: the Checkout gate is untouched, guest checkout stays one tap. `applyVoucher`'s
"enter your WhatsApp number before applying a voucher" message disappears with the rule it
enforced.

`voucher_requires_account` still needs a customer-facing `t(en, zh)` message: a session can
expire between applying a voucher and placing the order, and that customer must be told to sign
in again rather than "something went wrong".

### No migration

`used_by` already holds WhatsApp numbers from historical guest redemptions. They simply never
match an email again — a stale key that can no longer be produced. Harmless; noted in
`CONTEXT.md` rather than cleaned up. (Rewriting them would be guessing which number belonged to
which account.)

## Testing

`apps/backend/tests/api/` (real Postgres, never mocked):

- A voucher claim with **no JWT** is refused with `voucher_requires_account`, and writes no
  order row.
- A claim **with** a JWT keys `used_by` on the token's email — assert the row's contents, not
  just that it worked.
- **The hole itself:** the same signed-in customer cannot redeem the same voucher twice. Since
  the body no longer carries a key, there is no longer any way to *express* the attack — which
  is the point. Assert the second order is refused with `voucher_already_used`.
- A body that still sends `voucherEntry` has it **ignored**, not honoured — the analogue of the
  existing "never persists a status the client asked for" test.

UI is verified by running the app (run-and-verify), per CLAUDE.md: a signed-out storefront
offers sign-in instead of a voucher field; a signed-in one applies and redeems as before.

## Out of scope

- **#71** — `voucherError`'s `min_order` / `expired` / `not_assigned` branches still cannot
  fire (no columns behind them). Adjacent, but a separate decision.
- Guest orders remain orphaned forever; that is by design and unrelated.
