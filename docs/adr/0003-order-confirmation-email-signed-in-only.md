# 3. Order confirmation emails go to signed-in customers only, sourced from Auth

Date: 2026-07-23
Status: Accepted.

## Context

Placing an order gave the customer an on-screen order number and, for guests, WhatsApp-based tracking — but no receipt in their inbox. We wanted a confirmation email on new orders.

Two facts shaped the design. Checkout collects a **name and a WhatsApp number, no email** — an email address exists only for a signed-in account, carried on its JWT. And a post-commit notification path already existed: `POST /api/notify/order`, anonymous, fired fire-and-forget after the order lands, today sending the merchant's Telegram message. The Resend send adapter (`email.ts`) also already existed, used for merchant trial mail.

## Decision

**Only signed-in customers get a confirmation email.** Guests get none. Rather than enforce that with a check, we make it structural: the recipient address is read server-side from `order.user_id` via `admin.auth.admin.getUserById().user.email` — the same Auth source (not `profiles`, which may not exist for a fresh account) already used for owner mail. A guest order carries `user_id = null`, so it has no recipient and skips on its own.

The send **piggybacks the existing `POST /api/notify/order` call**, which stays anonymous. Merchant Telegram and customer email are two independent, best-effort sends of one event: each has its own try/catch, neither blocks the other, and neither touches the already-committed order. The email is sent **once per order**, guarded by a new `orders.confirmation_emailed_at` stamped with an atomic conditional update (`… where confirmation_emailed_at is null returning …`) so concurrent or repeated calls cannot double-send.

Rejected: collecting a guest email at checkout (new PII field, validation, storage, a silent-drop failure class — for the one recipient class with no account); requiring a JWT on the notify endpoint (forces auth onto a path the Telegram send relies on being anonymous, and breaks re-sends after a session expires); rate-limiting the endpoint (real work to prevent a non-harm — see below).

## Consequences

- **Guest exclusion cannot be forgotten.** It falls out of `user_id` being null, not a conditional a later change might drop.
- **The endpoint stays anonymous, and that is safe because of the one-shot guard.** Order numbers are a guessable per-shop daily counter, so an enumerator can hit the endpoint with a valid `merchantId + orderNumber`. The worst case is triggering *the one legitimate confirmation* slightly early — the same email, to the real customer, that the storefront sends on checkout anyway. No exfiltration: the recipient is derived from the order, never the request.
- **A confirmation can reach an unverified address.** A customer's email is never verified (a deliberate stance — see `CONTEXT.md → Customer signup`), so a typo'd or unowned address means a stranger receives the order's name, delivery address, items and total. Accepted: this is the same exposure the password-reset mail already carries to those same addresses, and a reset link is the graver leak. It updates `CONTEXT.md`'s former "we send customers no other mail" — it does not reopen the verification decision.
- **The email is HTML + plain-text multipart**, so the `resendSend` adapter grew an optional `html` field; the text-only trial mail is unchanged.
