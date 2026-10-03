# Dynamic DuitNow QR through HitPay — design

Date: 2026-10-02

## Purpose

A customer pays a shop with a DuitNow QR that holds the exact order total. When the payment is
complete, the order moves from `pending_payment` to `new` with no merchant action, and the
merchant gets an alert.

Today a shop shows a static QR and bank details. The customer pays outside the app and uploads a
screenshot (the payment proof). The merchant must compare each screenshot with the bank account.
This design removes that work for a shop that connects a HitPay account.

Success means two things:

1. The customer pays, and the order moves to `new` in a few seconds. The merchant does nothing.
2. The merchant gets a notification after the customer pays, not before.

## Constraint: the money belongs to the merchant (model A)

Each merchant signs up with HitPay under their own account and does their own KYB. The money
settles directly to the merchant. TinyOrder never holds or collects money for a merchant, and
takes no commission. Stripe stays for the TinyOrder subscription only. The PayNet DuitNow QR API
is not available to TinyOrder: it is for licensed participants only.

## Decisions

| Decision | Choice |
|---|---|
| Gateway | HitPay embedded QR: `payment_methods[]=duitnow`, `generate_qr=true`. |
| Merchant setup | The merchant pastes **one** HitPay API key. TinyOrder registers its own webhook on the merchant's account with that key. The merchant never sees a webhook URL or a salt. |
| Trust model | **Verify by fetch.** A webhook is a signal only. The backend confirms every payment with `GET /v1/payment-requests/{id}` and the shop's own key. No signature check. |
| Merchant alert | Only after the payment. A HitPay order sends no alert at the time of the order. |
| Customer screen | The dynamic QR only. The static QR, the bank details and the proof upload are the fallback when HitPay fails. |
| Unpaid order | The QR expires after 15 minutes. The order stays `pending_payment` until the customer pays or the merchant cancels it. "Get a new QR" shows only after the old QR expires. |
| Payment state | A new `order_payments` table, one row for each HitPay payment request. |
| Currency | Only a shop with currency MYR can connect HitPay. |
| Plan | Every plan. |

### Why the trust model is verify by fetch

The HitPay documentation differs from the first plan in two points:

- `POST /v1/webhook-events` returns no salt. Its response has `id`, `business_id`, `name`, `url`,
  `event_types`, `created_at` and `updated_at` only.
- That endpoint accepts only `charge.*`, `order.*`, `invoice.*`, `transfer.*` and `payout.*`
  event types. It cannot register `payment_request.completed`.

Thus a webhook that TinyOrder registers with one API key cannot carry a signature that TinyOrder
can check. The design does not need one. The backend never acts on the body of a webhook. It reads
one ID from it, and then it asks HitPay for the status with the shop's own key. A forged webhook
can only make the backend ask HitPay a question.

The other options were:

- The merchant pastes the key **and** the salt, and creates the webhook in the HitPay dashboard.
  Rejected: more steps where a merchant can make an error.
- A HitPay Platform account. Rejected for now: it needs approval from HitPay, and
  `payment_request.*` events still go to each sub-merchant's endpoints.

## Flow

```
Merchant: Settings → Payment → "Connect HitPay" (paste the API key)
   │  backend: register charge.* webhook with the key (this is also the key test)
   │           → store in merchant_secrets → merchants.hitpay_connected = true
   ▼
Customer places the order (POST /api/orders, unchanged) → status pending_payment
   │  order-placed screen calls POST /api/orders/:id/hitpay-qr
   ▼
backend: reuse the live QR, or create one (expires_after 15 minutes, reference = order id)
   │  → order_payments row → return the QR payload → the browser draws it + "Save QR"
   ▼
Confirmation (two paths, ONE function: confirmHitpayPayment)
   ├─ webhook POST /api/hitpay/webhook/<shop token> → a signal only
   └─ the screen polls GET /api/orders/:id/hitpay-status every 3 s
        │  GET /v1/payment-requests/{id} with the key of that shop
        ▼  completed + amount + currency + reference agree?
   ONE transaction: pending_payment → new, order event (actor system), row → completed
        ▼  after the commit
   merchant alert "Paid by DuitNow" (Telegram if set up + email)
```

## Backend modules

Each module follows the split that the repo uses: pure rules in one file, SQL in a different file.

| File | Job |
|---|---|
| `hitpay.ts` | The adapter for the HitPay API: register a webhook, remove a webhook, create a payment request, read a payment request. The key and the API base are parameters. It does not read `env.ts` and does not import `supabase.ts` or `db.ts`. It uses `fetch`, so the esbuild command needs no new `--external:` flag. |
| `hitpayPayment.ts` | Pure rules: is a QR still live, and do the HitPay data agree with the order. |
| `hitpayPaymentDb.ts` | The SQL for `order_payments`, the secrets, and the status change in one `withTransaction()`. |
| `hitpayDeps` on `app.ts` | The test seam, the same shape as `supportDeps`. Production uses the real adapter. |

Two new env vars, both optional:

- `HITPAY_API_BASE`: local work points it to the HitPay sandbox, and production points it to
  `https://api.hit-pay.com/v1`.
- `BACKEND_PUBLIC_URL`: the public HTTPS origin of this backend. The webhook URL that TinyOrder
  registers starts with it. No env var holds this value today (`env.ts` has `FRONTEND_URL` only),
  and HitPay rejects a loopback or private address.

When either one is not set, "Connect HitPay" answers `503 hitpay_not_configured`, and a shop with
no connection is not affected.

## Data model

### `merchant_secrets`: three new columns

The browser roles have no grant on this table
(`20260718130000_revoke_all_browser_grants.sql`). Only the backend reads it.

| Column | Type | Purpose |
|---|---|---|
| `hitpay_api_key` | text | The merchant's key. The backend sends it in `X-BUSINESS-API-KEY`. |
| `hitpay_webhook_id` | text | The ID of the webhook that TinyOrder registered. "Disconnect" uses it. |
| `hitpay_webhook_token` | text, unique | The random token in the webhook URL. It identifies the shop for a signal. |

`GET /api/merchants/:id/secret` returns the Telegram token to the browser today. It must **never**
return the HitPay key. The browser gets `{ connected: true, keyLast4: "a1b2" }` from a separate
route.

### `merchants`: one new column

`hitpay_connected boolean not null default false`. The storefront must know if it shows the dynamic
QR or the static info, and it must not read the secrets table. Only the backend writes this column,
at "Connect" and at "Disconnect". It is not in the merchant config write allowlist.

### New table: `order_payments`

| Column | Note |
|---|---|
| `id` uuid primary key | |
| `order_id` → `orders.id` | `on delete cascade` |
| `merchant_id` → `merchants.id` | `on delete cascade` |
| `gateway` text | Always `'hitpay'` in this version. |
| `gateway_request_id` text, unique | The HitPay payment request ID. |
| `qr_payload` text | The raw DuitNow string. The browser draws the image from it. |
| `amount` numeric, `currency` text | A copy of the order total at the time of the QR. |
| `status` text | `pending`, `completed`, `expired` or `failed` (check constraint). |
| `expires_at`, `paid_at`, `created_at` | timestamptz |

- A partial unique index on `(order_id) where status = 'pending'`. Postgres makes "one live QR for
  each order" true, also for two requests at the same time.
- RLS on, with no browser grants. The backend reads and writes it through `db.ts`. **Every query
  states `merchant_id`**, because `db.ts` is RLS-exempt and tenancy on the backend's path is a
  TypeScript rule.

### `order_events`: two new kinds

| Kind | Actor | When |
|---|---|---|
| `payment_confirmed` | `system` | The move from `pending_payment` to `new`. `detail` holds the gateway and the request ID. |
| `payment_after_cancel` | `system` | A verified payment on a cancelled order. The merchant must refund the customer. |

The migration drops and adds `order_events_kind_check`, as the earlier kind migrations do.

### The rule for an order that starts as `pending_payment`

`orders.ts` gives a new order the status `pending_payment` when the shop has a bank, a QR or a
note. The new rule is "the same, **or** `hitpay_connected`". Thus a shop with HitPay and no static
info also gets `pending_payment` orders.

## Routes and errors

### Access

`POST /api/orders/:id/hitpay-qr` and `GET /api/orders/:id/hitpay-status` use the order UUID and
need no sign-in. This is the same model as `POST /api/orders/:orderId/payment-proof`: a guest has
no token, and a UUID is not possible to guess. An IP sliding window limits both routes. The
connect and disconnect routes use `requireMerchantOwns`, and they also refuse anyone who is not
the shop owner with `403 owner_only` (decided 2026-10-03). A superadmin passes
`requireMerchantOwns` with "view as shop", and the key reaches the shop's own money. A superadmin
can still read the status.

### Connect: `PUT /api/merchants/:id/hitpay`

1. Check that the shop currency is MYR.
2. Make a random token. Call `POST /v1/webhook-events` with the key, the URL
   `${BACKEND_PUBLIC_URL}/api/hitpay/webhook/<token>` and `event_types` `charge.created` and
   `charge.updated`. This call is also the key test.
3. If the call succeeds, one transaction writes the three secret columns and sets
   `hitpay_connected = true`. A second connect replaces the old key and removes the old webhook
   (best effort).

| Case | Result |
|---|---|
| HitPay answers 401 or 403 | `400 invalid_key`. Nothing is stored. |
| HitPay is down, answers 5xx, or takes more than 10 s | `502 gateway_unavailable`. Nothing is stored. |
| The shop currency is not MYR | `400 currency_not_supported` |
| `HITPAY_API_BASE` or `BACKEND_PUBLIC_URL` is not set | `503 hitpay_not_configured` |

A shop cannot change its currency after signup: `currency` is not in the merchant config write
allowlist (`writes.ts`). Thus a connected shop stays MYR, and no new refusal is necessary.

### Disconnect: `DELETE /api/merchants/:id/hitpay`

Remove the webhook at HitPay (best effort; a failure is logged and does not block). Clear the three
columns and set `hitpay_connected = false`. Open `order_payments` rows stay. Their orders stay
`pending_payment`, and the merchant moves them by hand.

### Status for the dashboard: `GET /api/merchants/:id/hitpay`

Returns `{ connected, keyLast4 }`. Never the key.

### Get a QR: `POST /api/orders/:id/hitpay-qr`

1. The order must be `pending_payment`, and its shop must have `hitpay_connected`. If not:
   `409 not_payable`.
2. If a `pending` row exists and `expires_at` is in the future, return that row. Create no
   second QR.
3. If not, mark the old row `expired`. Call `POST /v1/payment-requests` with `amount` = the order
   total, `currency=myr`, `payment_methods[]=duitnow`, `generate_qr=true`,
   `expires_after=15 minutes`, `reference_number` = the order ID. `allow_repeated_payments` stays
   at its default, `false`.
4. Insert the row and return `{ qrPayload, amount, currency, expiresAt }`.

| Case | Result |
|---|---|
| HitPay rejects the key, is down, or takes more than 10 s | `502 gateway_unavailable`. The screen shows the fallback. |
| Two requests at the same time | The partial unique index refuses the second insert. The route returns the row that won. |

### Poll: `GET /api/orders/:id/hitpay-status`

Runs `confirmHitpayPayment` for the open row of the order, then returns
`{ payment, orderStatus, expiresAt }`, where `payment` is the row status or `none`.

### Webhook: `POST /api/hitpay/webhook/:token`

1. Find the shop from the token. An unknown token: `200`, and nothing happens.
2. Read `payment_request_id` from the JSON body. Nothing else in the body is used. No ID, or no
   `order_payments` row with that ID **and** that shop: `200`, and nothing happens.
3. Run `confirmHitpayPayment`.

The status code is for HitPay, not for a person. Only a failed database read or write answers
`500`, so that HitPay sends the signal again. `confirmHitpayPayment` is safe to run two times.

### `confirmHitpayPayment(merchant, row)`

1. Call `GET /v1/payment-requests/{row.gateway_request_id}` with the key of the shop that owns the
   row.
2. Continue only if all of these agree: `status = completed`, `amount` = `row.amount`, `currency` =
   `row.currency`, `reference_number` = the order ID. If HitPay reports `expired`, `failed` or
   `canceled`, store that status on the row and stop.
3. One `withTransaction()`. Lock the order row with `for update`, then:

| Order status at the lock | Action |
|---|---|
| `pending_payment` | Move to `new`. Mark the row `completed` with `paid_at`. Write `payment_confirmed` and a `status_changed` (both actor `system`), the same pair a payment proof writes today. |
| `cancelled` | Keep the status. Mark the row `completed`. Write `payment_after_cancel`. |
| Any other status (the merchant moved it already) | Mark the row `completed`. Write `payment_confirmed`, so the log shows that the money arrived. No alert. |
| The row is already `completed` | Do nothing. |

4. **After the commit**, and only when this call changed the row, send the merchant alert. A
   Telegram or email failure does not undo a paid order. This is the same rule as the Telegram
   send after an order today.

| Case | Result |
|---|---|
| The amount, the currency or the reference does not agree | No change. `console.error` with the request ID. A person must look at it. The QR route then answers `409 payment_needs_review` and makes no new QR. |
| HitPay is down during the check | No change. The next poll or the next signal tries again. |

## Notifications

- **Merchant, at the time of the order:** `notifyOrderPlaced` (Telegram) and `emailMerchantOrder`
  skip an order from a shop with `hitpay_connected`. The one-shot `merchant_emailed_at` claim stays
  unused, so the alert after the payment can use it.
- **Merchant, after the payment:** the same Telegram message and the same email, with the line
  "Paid by DuitNow (HitPay)". The email uses the `merchant_emailed_at` claim, so it goes out once.
  A `payment_after_cancel` sends a different message: "A customer paid a cancelled order. Refund
  them."
- **Merchant, when the customer cannot get a QR** (decided 2026-10-03): the QR route releases the
  held alert for an unpaid order when it answers `502`, `503`, or `409 not_payable` because the
  shop disconnected HitPay. The alert carries the warning "HitPay could not make a QR for this
  order", because the customer now sees the backup payment info. The stamp
  `orders.hitpay_fallback_alerted_at` makes it go out once. An order that is no longer
  `pending_payment` releases nothing.
- **Customer receipt:** for a HitPay order, the receipt says "Pay with the QR on your order page"
  and gives the link. It does not show the static QR: a payment to that QR gets no automatic
  confirmation.

## UI

### Merchant: Settings → Payment

- A new card, "DuitNow by HitPay", above the static fields.
- Not connected: a key field, "Connect", a link to the HitPay API Keys page, and the line "The money
  goes to your HitPay account. TinyOrder takes no commission."
- Connected: "Connected · key ending a1b2" and "Disconnect".
- Currency is not MYR: the card is disabled and says why.
- The static QR, bank and note fields stay, with the label "Backup payment info".
- The order detail shows "Paid by DuitNow (HitPay)" from the `payment_confirmed` event, through the
  event log that exists.

### Customer: `store/HitpayQrPanel.tsx`

It goes in the place of `PaymentInstructions` on the order-placed screen and in `OrderHistory`, for
an order from a shop with `hitpay_connected`.

| State | The screen shows |
|---|---|
| Loading | The space for the QR, with the amount |
| Live QR | The QR (`qrcode.react`, already a dependency), the amount, a countdown, "Save QR" (canvas → PNG download), and "Open your banking app and scan, or upload the saved image". |
| Expired | "This QR expired." and "Get a new QR" |
| Paid | "Payment received". The screen then shows the normal confirmation, with the invoice button, because the status is `new`. |
| `502` | `PaymentInstructions` and `PaymentProofUpload`, as today |

- The panel polls every 3 s while the QR is live and the tab is visible. A hidden tab does not poll;
  the webhook covers that case.
- All text uses `t(en, zh)`.
- "Save QR" matters: most customers order on a phone and cannot scan the screen they hold.

## Tests

| Suite | What it proves |
|---|---|
| `tests/unit/hitpay.test.ts` | The adapter sends the correct form fields and headers. It maps 401/403 to `invalid_key`, and 5xx or a timeout to `unavailable`. |
| `tests/unit/hitpayPayment.test.ts` | A QR is live or expired. The check refuses a wrong amount, currency, reference or status. |
| `tests/api/hitpay.test.ts` (real Postgres, `hitpayDeps` stub) | Connect and disconnect. One live QR only, also with two requests at the same time. A webhook for shop X with a request ID of shop Y changes nothing. A second confirmation does nothing. A paid cancelled order stays `cancelled`. The merchant alert goes out once. No route returns the key. |
| `tests/rls/` | The browser roles cannot read or write `order_payments`. |
| Run-and-verify | The HitPay sandbox. The HitPay CLI (`@hit-pay/cli`, `listen`) sends sandbox webhooks to localhost. |

## Checks before the build

1. **Does a DuitNow charge event carry `payment_request_id`?** The documentation examples show POS
   charges with `payment_request_id: null`. Test it in the sandbox. If it does not, the design
   stays the same, but confirmation works only while the customer keeps the page open. A customer
   who closes the tab then needs the merchant to move the order by hand.
2. **Can a HitPay account with no SSM accept DuitNow?** HitPay lets a sole owner sign up with a
   personal ID, but "certain payment methods" can need SSM. Ask HitPay support. Many home bakers
   have no SSM.

## Not in this version

- An automatic cancel of unpaid orders.
- Refunds through HitPay.
- Other gateways. The `gateway` column leaves space for them.
- FPX and cards.
- The HitPay Platform account and commissions.

## Sources

- HitPay, Domestic QR: https://docs.hitpayapp.com/apis/guide/embedded-qr-code-payments/domestic-qr
- HitPay, Webhooks: https://docs.hitpayapp.com/apis/guide/events
- HitPay, Create Webhook Event: https://docs.hitpayapp.com/apis/webhook-events/create-webhook-event
- HitPay, Create Payment Request: https://docs.hitpayapp.com/apis/payment-request/create-request
- HitPay, Get Payment Status: https://docs.hitpayapp.com/apis/payment-request/get-payment-status
- HitPay, Platform APIs: https://docs.hitpayapp.com/apis/guide/platform-apis
