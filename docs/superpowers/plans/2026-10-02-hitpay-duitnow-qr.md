# HitPay Dynamic DuitNow QR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop connects its own HitPay account with one API key. Its customers then pay each order with a dynamic DuitNow QR, the order moves from `pending_payment` to `new` with no merchant action, and the merchant gets an alert after the payment.

**Architecture:** A pure HitPay adapter (`hitpay.ts`) and pure rules (`hitpayPayment.ts`) sit under an SQL module (`hitpayPaymentDb.ts`) and one confirmation function (`hitpayConfirm.ts`). The backend never trusts a webhook body: a webhook and a browser poll both only trigger `confirmHitpayPayment`, which asks HitPay for the status with the shop's own key and settles the order in one `withTransaction()`. A new `order_payments` table holds one row for each HitPay payment request, and a partial unique index allows one live QR for each order.

**Tech Stack:** Hono, postgres.js (`db.ts`), Supabase migrations, Vitest, React 19, `qrcode.react` (already a frontend dependency), HitPay REST API v1 over `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-02-hitpay-duitnow-qr-design.md`

## Global Constraints

- No route returns the HitPay API key. The browser gets `{ connected, keyLast4 }` only.
- The backend never acts on a webhook body. It reads `payment_request_id` and nothing else, then verifies with `GET /v1/payment-requests/{id}` and the key of the shop that owns the `order_payments` row.
- Every `db.ts` query on `order_payments` or `merchant_secrets` states `merchant_id`. `db.ts` is RLS-exempt; tenancy on this path is a TypeScript rule.
- No route reads a merchant id from a request body. The webhook finds the shop from the URL token; the order routes find it from the order row.
- `POST /api/hitpay/webhook/:token` answers `200` for every ignored signal. Only a failed database read or write answers `500`.
- The merchant alert goes out only **after** the transaction commits. A Telegram or email failure never undoes a paid order.
- QR lifetime: `15` minutes (`QR_LIFETIME_MINUTES`). Status poll interval in the browser: `3000` ms. HitPay request timeout: `10_000` ms.
- `payment_methods[]=duitnow`, `generate_qr=true`, `allow_repeated_payments` left at its default (`false`).
- No new backend runtime dependency: the adapter uses `fetch`, so the esbuild `--external:` list does not change.
- Every UI string goes through `t(en, zh)`.
- Migration file: `apps/backend/supabase/migrations/20261002140000_hitpay_duitnow_qr.sql`. Apply it with `pnpm --filter @bitetime/backend db:migrate`. **Never run `db:push`.**
- New env vars, both optional: `HITPAY_API_BASE` (sandbox `https://api.sandbox.hit-pay.com/v1`, live `https://api.hit-pay.com/v1`) and `BACKEND_PUBLIC_URL` (the public HTTPS origin of the backend). When either one is empty, the HitPay routes answer `503 hitpay_not_configured`.
- Commit messages use ASD-STE100 Simplified Technical English and end with the line `Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB`.

## Review Focus

1. **A payment at the expiry boundary.** A customer pays the old QR at minute 14:59 and then taps "Get a new QR". Expected: the backend checks the old request with HitPay first and answers `completed`; it never creates a second QR that can take a second payment. Test: Task 6, "checks the expired QR with HitPay before it makes a new one".
2. **A signal that names a different shop's request.** A webhook on shop X's token carries a request ID that belongs to shop Y. Expected: nothing changes, `200`. Test: Task 6, "ignores a request id that belongs to a different shop".
3. **The merchant cancels while the QR is live, then the customer pays.** Expected: the order stays `cancelled`, a `payment_after_cancel` event is written, and the merchant gets the refund alert once. Test: Task 6 and Task 7.
4. **HitPay formats money and currency differently from Postgres.** HitPay sends `"26.00"` and `"myr"`; Postgres gives `"26"` or `"26.00"` and `"MYR"`. Expected: they are equal. Test: Task 3, `judgePayment` cases.
5. **The merchant disconnects HitPay while a QR is open.** Expected: a later poll or signal answers without an error and changes nothing; the order stays `pending_payment` for the merchant to move by hand. Test: Task 6, "does nothing after the shop disconnects".

---

## File map

| File | Create / Modify | Responsibility |
|---|---|---|
| `apps/backend/supabase/migrations/20261002140000_hitpay_duitnow_qr.sql` | Create | Secret columns, `merchants.hitpay_connected`, `order_payments`, two event kinds |
| `packages/shared/src/orderEvents.ts` | Modify | Add `payment_confirmed`, `payment_after_cancel` |
| `apps/frontend/src/merchant/orderDetail/orderEventLine.ts` | Modify | Sentences for the two kinds |
| `apps/backend/tests/rls/order-payments-grant.test.ts` | Create | Browser roles cannot reach `order_payments` |
| `apps/backend/src/hitpay.ts` | Create | HitPay REST adapter (pure, injected `fetch`) |
| `apps/backend/tests/unit/hitpay.test.ts` | Create | Adapter request shape and error mapping |
| `apps/backend/src/hitpayPayment.ts` | Create | Pure rules: QR live, judge a remote status, money compare, token, banners |
| `apps/backend/tests/unit/hitpayPayment.test.ts` | Create | The pure rules |
| `apps/backend/src/hitpayPaymentDb.ts` | Create | SQL for the connection, `order_payments`, and the settle transaction |
| `apps/backend/src/hitpayConfirm.ts` | Create | `confirmHitpayPayment` — the one function both paths call |
| `apps/backend/src/env.ts` | Modify | `hitpayApiBase`, `backendPublicUrl` |
| `apps/backend/src/quotaWindows.ts` | Modify | Two IP windows for the public order routes |
| `apps/backend/src/orders.ts` | Modify | An order of a connected shop starts `pending_payment` |
| `apps/backend/src/orderNotice.ts` | Modify | `AlertBanner` type |
| `apps/backend/src/notify.ts` | Modify | Optional banner on the Telegram message |
| `apps/backend/src/orderEmails.ts` | Modify | Optional banner on the merchant email; dynamic-QR line on the receipt |
| `apps/backend/src/app.ts` | Modify | `hitpayDeps`, connect/disconnect/status routes, QR/status/webhook routes, alert hold |
| `apps/backend/tests/api/hitpay-connect.test.ts` | Create | Connect, disconnect, key never returned, intake rule |
| `apps/backend/tests/api/hitpay-payment.test.ts` | Create | QR, poll, webhook, settle, tenancy, concurrency |
| `apps/backend/tests/api/hitpay-alerts.test.ts` | Create | Held alert at placement, paid alert once, refund alert, receipt line |
| `apps/backend/.env.example` | Modify | Document the two env vars |
| `apps/frontend/src/types.ts` | Modify | `Merchant.hitpay_connected` |
| `apps/frontend/src/store.ts` | Modify | Five API calls |
| `apps/frontend/src/merchant/HitpayCard.tsx` | Create | Settings → Payment connect card |
| `apps/frontend/src/merchant/ShopSettings.tsx` | Modify | Mount the card; rename the static card |
| `apps/frontend/src/hitpayQr.ts` | Create | Pure view rules for the customer panel |
| `apps/frontend/src/hitpayQr.test.ts` | Create | The pure view rules |
| `apps/frontend/src/store/HitpayQrPanel.tsx` | Create | The customer QR panel |
| `apps/frontend/src/store/Storefront.tsx` | Modify | Mount the panel on the order-placed screen |
| `apps/frontend/src/store/OrderHistory.tsx` | Modify | Mount the panel for an unpaid order |
| `CLAUDE.md`, `CONTEXT.md` | Modify | Document the feature and its rules |

---

### Task 0: Sandbox probe (human-assisted, no code committed)

This task answers the spec's check 1 and confirms the request formats the adapter uses. It needs a HitPay **sandbox** account and its API key. If no key is available, record "not run" in the spec and continue: Tasks 1–10 do not depend on the answer, and the adapter is the only file to adjust if the probe disagrees.

- [ ] **Step 1: Ask the human for a sandbox API key and a public HTTPS URL that can receive a webhook** (for example `https://webhook.site/<id>`). Do not write the key to any file in the repo.

- [ ] **Step 2: Register a webhook**

```bash
curl -s -X POST https://api.sandbox.hit-pay.com/v1/webhook-events \
  -H "X-BUSINESS-API-KEY: $HITPAY_SANDBOX_KEY" -H "X-Requested-With: XMLHttpRequest" \
  -H "Content-Type: application/json" \
  -d '{"name":"tinyorder-probe","url":"<PUBLIC_URL>","event_types":["charge.created","charge.updated"]}'
```

Expected: JSON with `id`. Record whether JSON was accepted. If it was refused, repeat with `-H "Content-Type: application/x-www-form-urlencoded" --data-urlencode name=... --data-urlencode url=... -d 'event_types[]=charge.created' -d 'event_types[]=charge.updated'` and record that form instead.

- [ ] **Step 3: Create a DuitNow QR**

```bash
curl -s -X POST https://api.sandbox.hit-pay.com/v1/payment-requests \
  -H "X-BUSINESS-API-KEY: $HITPAY_SANDBOX_KEY" -H "X-Requested-With: XMLHttpRequest" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d amount=1.00 -d currency=myr -d 'payment_methods[]=duitnow' -d generate_qr=true \
  -d 'expires_after=15 minutes' -d reference_number=probe-1
```

Expected: `id`, `status: "pending"`, `qr_code_data.qr_code`. Record the exact path of the QR string.

- [ ] **Step 4: Pay it in the sandbox** (open the `qr_code` URL that the sandbox returns and complete the test payment). Then read the status:

```bash
curl -s https://api.sandbox.hit-pay.com/v1/payment-requests/<id> \
  -H "X-BUSINESS-API-KEY: $HITPAY_SANDBOX_KEY" -H "X-Requested-With: XMLHttpRequest"
```

Expected: `status: "completed"`, `amount`, `currency`, `reference_number: "probe-1"`.

- [ ] **Step 5: Read the webhook that arrived** at the public URL. Record whether the `charge.*` body carries `payment_request_id` (top level) or `payment_request.id`. This is the spec's check 1.

- [ ] **Step 6: Remove the probe webhook**

```bash
curl -s -X DELETE https://api.sandbox.hit-pay.com/v1/webhook-events/<webhook id> \
  -H "X-BUSINESS-API-KEY: $HITPAY_SANDBOX_KEY" -H "X-Requested-With: XMLHttpRequest"
```

Record the status code.

- [ ] **Step 7: Write the results** under "Checks before the build" in the spec (one line for each check, with the date), and commit:

```bash
git add docs/superpowers/specs/2026-10-02-hitpay-duitnow-qr-design.md
git commit -m "docs(hitpay): record the results of the sandbox probe

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

If any result differs from the request shapes in Task 2, change Task 2's code and its test to match before you do Task 2.

---

### Task 1: Schema, event kinds, and the grant test

**Files:**
- Create: `apps/backend/supabase/migrations/20261002140000_hitpay_duitnow_qr.sql`
- Modify: `packages/shared/src/orderEvents.ts` (the `ORDER_EVENT_KINDS` list)
- Modify: `apps/frontend/src/merchant/orderDetail/orderEventLine.ts` (the switch)
- Modify: `apps/frontend/src/types.ts` (`interface Merchant`)
- Create: `apps/backend/tests/rls/order-payments-grant.test.ts`

**Interfaces:**
- Produces: table `order_payments`, column `merchants.hitpay_connected`, columns `merchant_secrets.hitpay_api_key | hitpay_webhook_id | hitpay_webhook_token`, event kinds `'payment_confirmed' | 'payment_after_cancel'`, `Merchant.hitpay_connected?: boolean | null`.

- [ ] **Step 1: Write the failing grant test**

```ts
// tests/rls/order-payments-grant.test.ts
// order_payments is read and written by the backend only (db.ts). A browser role must not SELECT
// or INSERT a row — not the shop owner, not an anonymous visitor. Mirrors order-events-grant.test.ts:
// if this ever passes with rows, a policy or a grant crept in.
import { describe, it, expect } from 'vitest'
import { anonClient, makeUser, serviceClient, seedMerchant, resetMerchant } from './helpers.js'

const SLUG = 'order-payments-grant-shop'

async function seedOrderWithPayment() {
  const svc = serviceClient()
  const owner = await makeUser('order-payments-grant-owner@example.com', 'password123')
  const { data: session } = await owner.auth.getSession()
  await resetMerchant(SLUG)
  const merchantId = await seedMerchant({ slug: SLUG, owner_id: session.session!.user.id, status: 'active' })
  const { data: order, error } = await svc.from('orders').insert({
    merchant_id: merchantId,
    order_number: `OP-${crypto.randomUUID().slice(0, 8)}`,
    status: 'pending_payment',
    customer_name: 'Ah Meng',
    customer_wa: '60123456789',
  }).select('id').single()
  if (error) throw new Error(`seeding order: ${error.message}`)
  const { error: pErr } = await svc.from('order_payments').insert({
    order_id: order!.id, merchant_id: merchantId, gateway: 'hitpay',
    gateway_request_id: `req-${crypto.randomUUID()}`, qr_payload: 'x', amount: 10, currency: 'MYR',
    status: 'pending', expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  })
  if (pErr) throw new Error(`seeding payment: ${pErr.message}`)
  return { orderId: order!.id as string, merchantId, owner }
}

describe('order_payments is not reachable by the browser', () => {
  it('denies an anonymous SELECT', async () => {
    await seedOrderWithPayment()
    const { data, error } = await anonClient().from('order_payments').select('*')
    expect(error !== null || (data ?? []).length === 0).toBe(true)
  })

  it('denies the shop owner a SELECT and an INSERT', async () => {
    const { orderId, merchantId, owner } = await seedOrderWithPayment()
    const read = await owner.from('order_payments').select('*').eq('order_id', orderId)
    expect(read.error).not.toBeNull()
    const write = await owner.from('order_payments').insert({
      order_id: orderId, merchant_id: merchantId, gateway: 'hitpay', gateway_request_id: 'forged',
      qr_payload: 'x', amount: 1, currency: 'MYR', status: 'completed', expires_at: new Date().toISOString(),
    })
    expect(write.error).not.toBeNull()
  })

  it('allows only one pending row for each order', async () => {
    const { orderId, merchantId } = await seedOrderWithPayment()
    const { error } = await serviceClient().from('order_payments').insert({
      order_id: orderId, merchant_id: merchantId, gateway: 'hitpay',
      gateway_request_id: `req-${crypto.randomUUID()}`, qr_payload: 'y', amount: 10, currency: 'MYR',
      status: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(error?.code).toBe('23505')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @bitetime/backend test:db -- tests/rls/order-payments-grant.test.ts`
Expected: FAIL — `relation "public.order_payments" does not exist` (or the schema-cache equivalent).

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261002140000_hitpay_duitnow_qr.sql
--
-- Dynamic DuitNow QR through each merchant's OWN HitPay account (spec:
-- docs/superpowers/specs/2026-10-02-hitpay-duitnow-qr-design.md). TinyOrder never holds money.
--
-- 1. The merchant's HitPay key and the webhook TinyOrder registered with it. merchant_secrets has
--    no browser grants (20260718130000_revoke_all_browser_grants.sql); only the backend reads it.
alter table public.merchant_secrets
  add column if not exists hitpay_api_key       text,
  add column if not exists hitpay_webhook_id    text,
  add column if not exists hitpay_webhook_token text;

create unique index if not exists merchant_secrets_hitpay_webhook_token_key
  on public.merchant_secrets (hitpay_webhook_token) where hitpay_webhook_token is not null;

-- 2. What the storefront reads to choose the dynamic QR. Written by the backend only, at connect
--    and disconnect; deliberately NOT in the merchant config write allowlist (writes.ts).
alter table public.merchants
  add column if not exists hitpay_connected boolean not null default false;

-- 3. One row for each HitPay payment request. Many rows for one order over time (a QR expires and
--    the customer asks for a new one); at most ONE pending row, which the partial index enforces
--    against two concurrent requests.
create table if not exists public.order_payments (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete cascade,
  merchant_id        uuid not null references public.merchants (id) on delete cascade,
  gateway            text not null check (gateway in ('hitpay')),
  gateway_request_id text not null unique,
  qr_payload         text not null,
  amount             numeric(12,2) not null,
  currency           text not null,
  status             text not null check (status in ('pending', 'completed', 'expired', 'failed')),
  expires_at         timestamptz not null,
  paid_at            timestamptz,
  created_at         timestamptz not null default now()
);

create unique index if not exists order_payments_one_pending
  on public.order_payments (order_id) where status = 'pending';
create index if not exists order_payments_order_created
  on public.order_payments (order_id, created_at desc);

alter table public.order_payments enable row level security;
revoke all on public.order_payments from anon, authenticated;

-- 4. Two order log kinds. Same shape as 20260917120100_order_events_fulfil_time.sql: drop the
--    constraint by name and re-add it with the new members.
alter table public.order_events drop constraint if exists order_events_kind_check;

alter table public.order_events
  add constraint order_events_kind_check check (kind in (
    'created',
    'payment_proof_uploaded',
    'merchant_payment_proof_uploaded',
    'status_changed',
    'note_changed',
    'courier_changed',
    'awb_changed',
    'fulfil_date_changed',
    'fulfil_time_changed',
    'voucher_released',
    'voucher_restored',
    'payment_confirmed',
    'payment_after_cancel'
  ));
```

- [ ] **Step 4: Apply it locally**

Run: `cd apps/backend && pnpm db:migrate` (LOCAL stack only).
Expected: `Applying migration 20261002140000_hitpay_duitnow_qr.sql...` and no error.

- [ ] **Step 5: Add the two kinds to the shared list.** In `packages/shared/src/orderEvents.ts`, change the constraint pointer in the header comment from `20260917120100_order_events_fulfil_time.sql` to `20261002140000_hitpay_duitnow_qr.sql`, and append to `ORDER_EVENT_KINDS` after `'voucher_restored',`:

```ts
  /** HitPay confirmed the payment (spec 2026-10-02). `detail.gateway`, `detail.request_id`. Actor `system`. */
  'payment_confirmed',
  /** HitPay confirmed a payment on an order that was already cancelled. The shop must refund it. */
  'payment_after_cancel',
```

- [ ] **Step 6: Add the two sentences.** In `apps/frontend/src/merchant/orderDetail/orderEventLine.ts`, before `default:`:

```ts
    case 'payment_confirmed':
      return t('Payment received by DuitNow (HitPay)', '已通过 DuitNow（HitPay）收款')
    case 'payment_after_cancel':
      return t('Customer paid after you cancelled. Refund them in HitPay.', '顾客在您取消后付款。请在 HitPay 退款。')
```

- [ ] **Step 7: Add the column to the frontend type.** In `apps/frontend/src/types.ts`, inside `interface Merchant`, after `payment_note?: string | null`:

```ts
  /** The shop connected its own HitPay account (spec 2026-10-02). Written by the backend only. */
  hitpay_connected?: boolean | null
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @bitetime/backend test:db -- tests/rls/order-payments-grant.test.ts && pnpm --filter @bitetime/frontend test && pnpm typecheck`
Expected: PASS (the frontend `orderEventLine` sweep passes because both kinds have sentences).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/supabase/migrations/20261002140000_hitpay_duitnow_qr.sql packages/shared/src/orderEvents.ts \
  apps/frontend/src/merchant/orderDetail/orderEventLine.ts apps/frontend/src/types.ts \
  apps/backend/tests/rls/order-payments-grant.test.ts
git commit -m "feat(hitpay): add the order_payments table and two order event kinds

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

---

### Task 2: The HitPay adapter

**Files:**
- Create: `apps/backend/src/hitpay.ts`
- Test: `apps/backend/tests/unit/hitpay.test.ts`

**Interfaces:**
- Produces:
  - `class HitpayKeyRejected extends Error`, `class HitpayUnavailable extends Error`
  - `interface RemotePaymentRequest { id: string; status: string; amount: string; currency: string; referenceNumber: string | null }`
  - `interface Hitpay { registerWebhook(apiBase: string, apiKey: string, url: string): Promise<{ id: string }>; removeWebhook(apiBase: string, apiKey: string, webhookId: string): Promise<void>; createQr(apiBase: string, apiKey: string, input: { amount: string; currency: string; reference: string; expiresAfterMinutes: number }): Promise<{ id: string; qrPayload: string }>; getPaymentRequest(apiBase: string, apiKey: string, id: string): Promise<RemotePaymentRequest> }`
  - `function createHitpay(fetchImpl?: typeof fetch, timeoutMs?: number): Hitpay`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/hitpay.test.ts
import { describe, it, expect } from 'vitest'
import { createHitpay, HitpayKeyRejected, HitpayUnavailable } from '../../src/hitpay.js'

const BASE = 'https://api.sandbox.hit-pay.com/v1'

function fakeFetch(reply: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = reply(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const headersOf = (init: RequestInit) => new Headers(init.headers as HeadersInit)

describe('hitpay adapter', () => {
  it('registers a charge webhook with the merchant key and returns its id', async () => {
    const f = fakeFetch(() => ({ body: { id: 'wh_1', business_id: 'b', name: 'TinyOrder', url: 'u', event_types: [] } }))
    const hp = createHitpay(f.impl)
    expect(await hp.registerWebhook(BASE, 'KEY', 'https://api.example.com/api/hitpay/webhook/tok')).toEqual({ id: 'wh_1' })
    expect(f.calls[0].url).toBe(`${BASE}/webhook-events`)
    expect(f.calls[0].init.method).toBe('POST')
    expect(headersOf(f.calls[0].init).get('X-BUSINESS-API-KEY')).toBe('KEY')
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      name: 'TinyOrder',
      url: 'https://api.example.com/api/hitpay/webhook/tok',
      event_types: ['charge.created', 'charge.updated'],
    })
  })

  it('creates a DuitNow QR with form fields and returns the raw payload', async () => {
    const f = fakeFetch(() => ({ body: { id: 'pr_1', status: 'pending', qr_code_data: { qr_code: '000201...', qr_code_expiry: null } } }))
    const hp = createHitpay(f.impl)
    const out = await hp.createQr(BASE, 'KEY', { amount: '26.00', currency: 'myr', reference: 'order-uuid', expiresAfterMinutes: 15 })
    expect(out).toEqual({ id: 'pr_1', qrPayload: '000201...' })
    expect(f.calls[0].url).toBe(`${BASE}/payment-requests`)
    expect(headersOf(f.calls[0].init).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(String(f.calls[0].init.body))
    expect(form.get('amount')).toBe('26.00')
    expect(form.get('currency')).toBe('myr')
    expect(form.getAll('payment_methods[]')).toEqual(['duitnow'])
    expect(form.get('generate_qr')).toBe('true')
    expect(form.get('expires_after')).toBe('15 minutes')
    expect(form.get('reference_number')).toBe('order-uuid')
    expect(form.has('allow_repeated_payments')).toBe(false)
  })

  it('reads a payment request and maps reference_number', async () => {
    const f = fakeFetch(() => ({ body: { id: 'pr_1', status: 'completed', amount: '26.00', currency: 'myr', reference_number: 'order-uuid', payments: [] } }))
    const hp = createHitpay(f.impl)
    expect(await hp.getPaymentRequest(BASE, 'KEY', 'pr_1')).toEqual({
      id: 'pr_1', status: 'completed', amount: '26.00', currency: 'myr', referenceNumber: 'order-uuid',
    })
    expect(f.calls[0].url).toBe(`${BASE}/payment-requests/pr_1`)
    expect(f.calls[0].init.method).toBe('GET')
  })

  it('maps 401 and 403 to HitpayKeyRejected', async () => {
    for (const status of [401, 403]) {
      const hp = createHitpay(fakeFetch(() => ({ status, body: { message: 'Unauthenticated.' } })).impl)
      await expect(hp.registerWebhook(BASE, 'BAD', 'https://x')).rejects.toBeInstanceOf(HitpayKeyRejected)
    }
  })

  it('maps a 5xx, a 422 and a network failure to HitpayUnavailable', async () => {
    const hp5 = createHitpay(fakeFetch(() => ({ status: 503, body: {} })).impl)
    await expect(hp5.getPaymentRequest(BASE, 'KEY', 'pr')).rejects.toBeInstanceOf(HitpayUnavailable)
    const hp422 = createHitpay(fakeFetch(() => ({ status: 422, body: { message: 'bad' } })).impl)
    await expect(hp422.createQr(BASE, 'KEY', { amount: '1.00', currency: 'myr', reference: 'r', expiresAfterMinutes: 15 }))
      .rejects.toBeInstanceOf(HitpayUnavailable)
    const broken = createHitpay((async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)
    await expect(broken.getPaymentRequest(BASE, 'KEY', 'pr')).rejects.toBeInstanceOf(HitpayUnavailable)
  })

  it('refuses a QR response with no payload', async () => {
    const hp = createHitpay(fakeFetch(() => ({ body: { id: 'pr_1', status: 'pending', qr_code_data: null } })).impl)
    await expect(hp.createQr(BASE, 'KEY', { amount: '1.00', currency: 'myr', reference: 'r', expiresAfterMinutes: 15 }))
      .rejects.toBeInstanceOf(HitpayUnavailable)
  })

  it('removes a webhook by id', async () => {
    const f = fakeFetch(() => ({ status: 204, body: {} }))
    await createHitpay(f.impl).removeWebhook(BASE, 'KEY', 'wh_1')
    expect(f.calls[0].url).toBe(`${BASE}/webhook-events/wh_1`)
    expect(f.calls[0].init.method).toBe('DELETE')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @bitetime/backend exec vitest run tests/unit/hitpay.test.ts`
Expected: FAIL — `Cannot find module '../../src/hitpay.js'`.

- [ ] **Step 3: Write the adapter**

```ts
// The HitPay REST calls (spec: docs/superpowers/specs/2026-10-02-hitpay-duitnow-qr-design.md).
//
// Every call is made with the MERCHANT's own key: TinyOrder never holds money and has no HitPay
// account of its own in this flow. The key and the API base are parameters, never read from
// env.ts, and this module imports nothing from supabase.ts or db.ts — the same posture as the
// Claude adapters — so a unit test drives it with a fake fetch.
//
// Two failure classes, and the routes treat them differently: a REJECTED key is the merchant's
// error to fix (400 at connect), anything else is HitPay being unreachable (502, try again).

export class HitpayKeyRejected extends Error {}
export class HitpayUnavailable extends Error {}

export interface RemotePaymentRequest {
  id: string
  status: string
  amount: string
  currency: string
  referenceNumber: string | null
}

export interface Hitpay {
  registerWebhook(apiBase: string, apiKey: string, url: string): Promise<{ id: string }>
  removeWebhook(apiBase: string, apiKey: string, webhookId: string): Promise<void>
  createQr(
    apiBase: string,
    apiKey: string,
    input: { amount: string; currency: string; reference: string; expiresAfterMinutes: number },
  ): Promise<{ id: string; qrPayload: string }>
  getPaymentRequest(apiBase: string, apiKey: string, id: string): Promise<RemotePaymentRequest>
}

export function createHitpay(fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Hitpay {
  async function call(apiBase: string, apiKey: string, path: string, init: { method: string; body?: string; contentType?: string }) {
    const headers: Record<string, string> = { 'X-BUSINESS-API-KEY': apiKey, 'X-Requested-With': 'XMLHttpRequest' }
    if (init.contentType) headers['Content-Type'] = init.contentType
    let res: Response
    try {
      res = await fetchImpl(`${apiBase.replace(/\/$/, '')}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new HitpayUnavailable(`HitPay ${init.method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.status === 401 || res.status === 403) throw new HitpayKeyRejected(`HitPay refused the key (${res.status})`)
    if (!res.ok) throw new HitpayUnavailable(`HitPay ${init.method} ${path} answered ${res.status}`)
    return (await res.json().catch(() => ({}))) as any
  }

  return {
    async registerWebhook(apiBase, apiKey, url) {
      const body = JSON.stringify({ name: 'TinyOrder', url, event_types: ['charge.created', 'charge.updated'] })
      const r = await call(apiBase, apiKey, '/webhook-events', { method: 'POST', body, contentType: 'application/json' })
      if (!r?.id) throw new HitpayUnavailable('HitPay returned no webhook id')
      return { id: String(r.id) }
    },
    async removeWebhook(apiBase, apiKey, webhookId) {
      await call(apiBase, apiKey, `/webhook-events/${encodeURIComponent(webhookId)}`, { method: 'DELETE' })
    },
    async createQr(apiBase, apiKey, input) {
      const form = new URLSearchParams()
      form.set('amount', input.amount)
      form.set('currency', input.currency)
      form.append('payment_methods[]', 'duitnow')
      form.set('generate_qr', 'true')
      form.set('expires_after', `${input.expiresAfterMinutes} minutes`)
      form.set('reference_number', input.reference)
      const r = await call(apiBase, apiKey, '/payment-requests', {
        method: 'POST', body: form.toString(), contentType: 'application/x-www-form-urlencoded',
      })
      const qr = r?.qr_code_data?.qr_code
      if (!r?.id || typeof qr !== 'string' || !qr) throw new HitpayUnavailable('HitPay returned no QR payload')
      return { id: String(r.id), qrPayload: qr }
    },
    async getPaymentRequest(apiBase, apiKey, id) {
      const r = await call(apiBase, apiKey, `/payment-requests/${encodeURIComponent(id)}`, { method: 'GET' })
      return {
        id: String(r?.id ?? id),
        status: String(r?.status ?? ''),
        amount: String(r?.amount ?? ''),
        currency: String(r?.currency ?? ''),
        referenceNumber: r?.reference_number == null ? null : String(r.reference_number),
      }
    },
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @bitetime/backend exec vitest run tests/unit/hitpay.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/hitpay.ts apps/backend/tests/unit/hitpay.test.ts
git commit -m "feat(hitpay): add the HitPay API adapter

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

---

### Task 3: The pure payment rules

**Files:**
- Create: `apps/backend/src/hitpayPayment.ts`
- Modify: `apps/backend/src/orderNotice.ts` (add `AlertBanner`)
- Test: `apps/backend/tests/unit/hitpayPayment.test.ts`

**Interfaces:**
- Consumes: `RemotePaymentRequest` from Task 2.
- Produces:
  - `const QR_LIFETIME_MINUTES = 15`
  - `type PaymentRowStatus = 'pending' | 'completed' | 'expired' | 'failed'`
  - `function isLive(row: { status: PaymentRowStatus; expiresAt: Date }, now: Date): boolean`
  - `function moneyString(value: number | string): string`
  - `type Verdict = { kind: 'paid' } | { kind: 'pending' } | { kind: 'closed'; status: 'expired' | 'failed' } | { kind: 'mismatch'; reason: string }`
  - `function judgePayment(remote: RemotePaymentRequest, expected: { amount: number | string; currency: string; orderId: string }): Verdict`
  - `function readSignalRequestId(body: unknown): string | null`
  - `function newWebhookToken(): string`
  - `function keyLast4(apiKey: string): string`
  - `const PAID_BANNER: AlertBanner`, `const PAID_AFTER_CANCEL_BANNER: AlertBanner`
  - In `orderNotice.ts`: `interface AlertBanner { line: string; subjectPrefix: string }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/hitpayPayment.test.ts
import { describe, it, expect } from 'vitest'
import {
  isLive, moneyString, judgePayment, readSignalRequestId, newWebhookToken, keyLast4, QR_LIFETIME_MINUTES,
} from '../../src/hitpayPayment.js'

const now = new Date('2026-10-02T10:00:00Z')
const remote = (over: Partial<{ status: string; amount: string; currency: string; referenceNumber: string | null }> = {}) => ({
  id: 'pr_1', status: 'completed', amount: '26.00', currency: 'myr', referenceNumber: 'order-1', ...over,
})
const expected = { amount: '26', currency: 'MYR', orderId: 'order-1' }

describe('isLive', () => {
  it('is live only while pending and before expiry', () => {
    expect(isLive({ status: 'pending', expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(true)
    expect(isLive({ status: 'pending', expiresAt: now }, now)).toBe(false)
    expect(isLive({ status: 'expired', expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(false)
    expect(isLive({ status: 'completed', expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(false)
  })
  it('uses a 15 minute lifetime', () => {
    expect(QR_LIFETIME_MINUTES).toBe(15)
  })
})

describe('moneyString', () => {
  it('always gives two decimals', () => {
    expect(moneyString(26)).toBe('26.00')
    expect(moneyString('26.5')).toBe('26.50')
    expect(moneyString('0.30')).toBe('0.30')
  })
})

describe('judgePayment', () => {
  it('accepts a completed request whose money and reference agree, across formats and case', () => {
    expect(judgePayment(remote(), expected)).toEqual({ kind: 'paid' })
    expect(judgePayment(remote({ amount: '26' }), { ...expected, amount: 26 })).toEqual({ kind: 'paid' })
  })
  it('keeps waiting on pending', () => {
    expect(judgePayment(remote({ status: 'pending' }), expected)).toEqual({ kind: 'pending' })
  })
  it('closes expired, failed, canceled and inactive', () => {
    expect(judgePayment(remote({ status: 'expired' }), expected)).toEqual({ kind: 'closed', status: 'expired' })
    for (const s of ['failed', 'canceled', 'inactive']) {
      expect(judgePayment(remote({ status: s }), expected)).toEqual({ kind: 'closed', status: 'failed' })
    }
  })
  it('refuses a wrong amount, currency or reference', () => {
    expect(judgePayment(remote({ amount: '25.99' }), expected).kind).toBe('mismatch')
    expect(judgePayment(remote({ currency: 'sgd' }), expected).kind).toBe('mismatch')
    expect(judgePayment(remote({ referenceNumber: 'order-2' }), expected).kind).toBe('mismatch')
    expect(judgePayment(remote({ referenceNumber: null }), expected).kind).toBe('mismatch')
  })
  it('treats an unknown status as pending, never as paid', () => {
    expect(judgePayment(remote({ status: 'something-new' }), expected)).toEqual({ kind: 'pending' })
  })
})

describe('readSignalRequestId', () => {
  it('reads a top-level payment_request_id or a nested payment_request.id', () => {
    expect(readSignalRequestId({ payment_request_id: 'pr_1' })).toBe('pr_1')
    expect(readSignalRequestId({ payment_request: { id: 'pr_2' } })).toBe('pr_2')
  })
  it('returns null for anything else', () => {
    for (const b of [null, 'x', {}, { payment_request_id: null }, { payment_request_id: 12 }, { payment_request_id: '' }]) {
      expect(readSignalRequestId(b)).toBeNull()
    }
  })
})

describe('tokens and keys', () => {
  it('makes a url-safe token of at least 32 characters, different each time', () => {
    const a = newWebhookToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(newWebhookToken()).not.toBe(a)
  })
  it('shows only the last four characters of a key', () => {
    expect(keyLast4('abcdef123456')).toBe('3456')
    expect(keyLast4('ab')).toBe('ab')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @bitetime/backend exec vitest run tests/unit/hitpayPayment.test.ts`
Expected: FAIL — `Cannot find module '../../src/hitpayPayment.js'`.

- [ ] **Step 3: Add the banner type to `orderNotice.ts`** (append at the end of the file):

```ts
/**
 * A line put at the top of the merchant's alert, and the word put before its email subject. Used
 * when the alert is sent after a HitPay payment rather than at the time of the order.
 */
export interface AlertBanner {
  line: string
  subjectPrefix: string
}
```

- [ ] **Step 4: Write the rules**

```ts
// The pure half of the HitPay payment flow: no I/O, so `pnpm test` reaches all of it.
// `hitpayPaymentDb.ts` holds the SQL and `hitpayConfirm.ts` joins the two.
import { randomBytes } from 'node:crypto'
import type { RemotePaymentRequest } from './hitpay.js'
import type { AlertBanner } from './orderNotice.js'

/** How long one QR stays valid. HitPay gets the same figure as `expires_after`. */
export const QR_LIFETIME_MINUTES = 15

export type PaymentRowStatus = 'pending' | 'completed' | 'expired' | 'failed'

/** A QR the customer can still pay: the row is pending and its time has not run out. */
export function isLive(row: { status: PaymentRowStatus; expiresAt: Date }, now: Date): boolean {
  return row.status === 'pending' && row.expiresAt.getTime() > now.getTime()
}

/** Money as HitPay takes it: a string with exactly two decimals. */
export function moneyString(value: number | string): string {
  return Number(value).toFixed(2)
}

function cents(value: number | string): number {
  return Math.round(Number(value) * 100)
}

export type Verdict =
  | { kind: 'paid' }
  | { kind: 'pending' }
  | { kind: 'closed'; status: 'expired' | 'failed' }
  | { kind: 'mismatch'; reason: string }

/**
 * What HitPay's own answer means for this order. `paid` only when the request is completed AND
 * its amount, currency and reference all agree with what we asked for: a completed request for a
 * different sum or a different order is a fault for a person to look at, never a payment.
 *
 * An unknown status reads as `pending` — it is a status this module has not been taught, and
 * reading it as paid would move an order on a guess.
 */
export function judgePayment(
  remote: RemotePaymentRequest,
  expected: { amount: number | string; currency: string; orderId: string },
): Verdict {
  const status = remote.status.toLowerCase()
  if (status === 'expired') return { kind: 'closed', status: 'expired' }
  if (status === 'failed' || status === 'canceled' || status === 'inactive') return { kind: 'closed', status: 'failed' }
  if (status !== 'completed') return { kind: 'pending' }
  if (cents(remote.amount) !== cents(expected.amount)) {
    return { kind: 'mismatch', reason: `amount ${remote.amount} != ${moneyString(expected.amount)}` }
  }
  if (remote.currency.toLowerCase() !== expected.currency.toLowerCase()) {
    return { kind: 'mismatch', reason: `currency ${remote.currency} != ${expected.currency}` }
  }
  if (remote.referenceNumber !== expected.orderId) {
    return { kind: 'mismatch', reason: `reference ${remote.referenceNumber} != ${expected.orderId}` }
  }
  return { kind: 'paid' }
}

/**
 * The ONE field the backend reads from a webhook body. Everything else in the body is ignored:
 * the payload carries no signature we can check (spec → "Why the trust model is verify by
 * fetch"), so it is a hint about which request to ask HitPay about, and nothing more.
 */
export function readSignalRequestId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { payment_request_id?: unknown; payment_request?: { id?: unknown } | null }
  const id = typeof b.payment_request_id === 'string' ? b.payment_request_id
    : typeof b.payment_request?.id === 'string' ? b.payment_request.id
    : null
  return id ? id : null
}

/** The random part of a shop's webhook URL. It names the shop; it is not a credential. */
export function newWebhookToken(): string {
  return randomBytes(24).toString('base64url')
}

export function keyLast4(apiKey: string): string {
  return apiKey.slice(-4)
}

export const PAID_BANNER: AlertBanner = { line: '✅ Paid by DuitNow (HitPay)', subjectPrefix: 'Paid' }

export const PAID_AFTER_CANCEL_BANNER: AlertBanner = {
  line: '⚠️ The customer paid after you cancelled this order. Refund them in your HitPay dashboard.',
  subjectPrefix: 'Refund needed',
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @bitetime/backend exec vitest run tests/unit/hitpayPayment.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/hitpayPayment.ts apps/backend/src/orderNotice.ts apps/backend/tests/unit/hitpayPayment.test.ts
git commit -m "feat(hitpay): add the pure rules that judge a HitPay payment

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

---

### Task 4: Connect, disconnect, and the intake rule

**Files:**
- Create: `apps/backend/src/hitpayPaymentDb.ts` (the connection half; Task 5 adds the payment half)
- Modify: `apps/backend/src/env.ts`
- Modify: `apps/backend/src/app.ts` (imports, `hitpayDeps`, three routes)
- Modify: `apps/backend/src/orders.ts:665-717` (`assertOrderableMerchant`)
- Modify: `apps/backend/.env.example`
- Test: `apps/backend/tests/api/hitpay-connect.test.ts`

**Interfaces:**
- Consumes: `Hitpay`, `createHitpay`, `HitpayKeyRejected` (Task 2); `newWebhookToken`, `keyLast4` (Task 3).
- Produces:
  - `interface HitpayConnection { apiKey: string; webhookId: string; token: string }`
  - `readHitpayConnection(merchantId: string): Promise<HitpayConnection | null>`
  - `saveHitpayConnection(merchantId: string, c: HitpayConnection): Promise<void>`
  - `clearHitpayConnection(merchantId: string): Promise<void>`
  - `merchantByWebhookToken(token: string): Promise<string | null>`
  - `export const hitpayDeps: { hitpay: Hitpay; config: { apiBase: string; publicBackendUrl: string } }` on `app.ts`
  - Routes: `GET|PUT|DELETE /api/merchants/:id/hitpay` → `{ connected: boolean; keyLast4: string | null }`

- [ ] **Step 1: Write the failing API test**

```ts
// tests/api/hitpay-connect.test.ts
// Connect / disconnect a shop's own HitPay account. HitPay itself is faked through the exported
// `hitpayDeps` seam; Postgres is real, because what this suite proves is what lands in
// merchant_secrets and merchants — and that the key never comes back out.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { app, hitpayDeps } from '../../src/app.js'
import { HitpayKeyRejected, HitpayUnavailable, type Hitpay } from '../../src/hitpay.js'
import { makeUser, seedMerchant, seedProduct, serviceClient } from '../rls/helpers.js'

const realDeps = { ...hitpayDeps }
const calls: string[] = []

function fakeHitpay(over: Partial<Hitpay> = {}): Hitpay {
  return {
    async registerWebhook(_b, key, url) { calls.push(`register ${key} ${url}`); return { id: `wh_${calls.length}` } },
    async removeWebhook(_b, key, id) { calls.push(`remove ${key} ${id}`) },
    async createQr() { throw new Error('not used') },
    async getPaymentRequest() { throw new Error('not used') },
    ...over,
  }
}

beforeEach(() => {
  calls.length = 0
  hitpayDeps.hitpay = fakeHitpay()
  hitpayDeps.config = { apiBase: 'https://hitpay.test/v1', publicBackendUrl: 'https://api.tinyorder.test' }
})
afterAll(() => Object.assign(hitpayDeps, realDeps))

let n = 0
async function ownerShop(currency = 'MYR') {
  n += 1
  const owner = await makeUser(`hitpay-connect-${n}@example.com`, 'password123')
  const { data } = await owner.auth.getSession()
  const merchantId = await seedMerchant({ slug: `hitpay-connect-${n}`, owner_id: data.session!.user.id })
  if (currency !== 'MYR') await serviceClient().from('merchants').update({ currency }).eq('id', merchantId)
  return { merchantId, token: data.session!.access_token }
}

const call = (method: string, path: string, token: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })

describe('HitPay connection', () => {
  it('registers the webhook with the key, stores it, and flags the shop', async () => {
    const { merchantId, token } = await ownerShop()
    const res = await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: '  live_key_9876  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connected: true, keyLast4: '9876' })
    expect(calls[0]).toMatch(/^register live_key_9876 https:\/\/api\.tinyorder\.test\/api\/hitpay\/webhook\/[A-Za-z0-9_-]{32,}$/)

    const { data: m } = await serviceClient().from('merchants').select('hitpay_connected').eq('id', merchantId).single()
    expect(m!.hitpay_connected).toBe(true)
    const { data: s } = await serviceClient().from('merchant_secrets')
      .select('hitpay_api_key, hitpay_webhook_id, hitpay_webhook_token').eq('merchant_id', merchantId).single()
    expect(s!.hitpay_api_key).toBe('live_key_9876')
    expect(s!.hitpay_webhook_id).toBe('wh_1')
  })

  it('never returns the key from any read route', async () => {
    const { merchantId, token } = await ownerShop()
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'secret_key_ABCD' })
    for (const path of [`/api/merchants/${merchantId}/hitpay`, `/api/merchants/${merchantId}/secret`]) {
      const text = await (await call('GET', path, token)).text()
      expect(text).not.toContain('secret_key_ABCD')
    }
    expect(await (await call('GET', `/api/merchants/${merchantId}/hitpay`, token)).json())
      .toEqual({ connected: true, keyLast4: 'ABCD' })
  })

  it('answers 400 invalid_key and stores nothing when HitPay rejects the key', async () => {
    hitpayDeps.hitpay = fakeHitpay({ async registerWebhook() { throw new HitpayKeyRejected('no') } })
    const { merchantId, token } = await ownerShop()
    const res = await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'bad' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_key')
    const { data: m } = await serviceClient().from('merchants').select('hitpay_connected').eq('id', merchantId).single()
    expect(m!.hitpay_connected).toBe(false)
  })

  it('answers 502 gateway_unavailable when HitPay is down', async () => {
    hitpayDeps.hitpay = fakeHitpay({ async registerWebhook() { throw new HitpayUnavailable('down') } })
    const { merchantId, token } = await ownerShop()
    const res = await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'k' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('gateway_unavailable')
  })

  it('refuses a shop whose currency is not MYR', async () => {
    const { merchantId, token } = await ownerShop('SGD')
    const res = await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'k' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('currency_not_supported')
    expect(calls).toEqual([])
  })

  it('answers 503 when the platform has no HitPay config', async () => {
    hitpayDeps.config = { apiBase: '', publicBackendUrl: '' }
    const { merchantId, token } = await ownerShop()
    expect((await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'k' })).status).toBe(503)
  })

  it('refuses an empty key', async () => {
    const { merchantId, token } = await ownerShop()
    expect((await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: '   ' })).status).toBe(400)
  })

  it('replaces the old webhook on a second connect', async () => {
    const { merchantId, token } = await ownerShop()
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'first_1111' })
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'second_2222' })
    expect(calls).toContain('remove first_1111 wh_1')
  })

  it('disconnects: removes the webhook, clears the secret, unflags the shop', async () => {
    const { merchantId, token } = await ownerShop()
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'key_5555' })
    const res = await call('DELETE', `/api/merchants/${merchantId}/hitpay`, token)
    expect(await res.json()).toEqual({ connected: false, keyLast4: null })
    expect(calls).toContain('remove key_5555 wh_1')
    const { data: s } = await serviceClient().from('merchant_secrets')
      .select('hitpay_api_key, hitpay_webhook_token').eq('merchant_id', merchantId).single()
    expect(s).toEqual({ hitpay_api_key: null, hitpay_webhook_token: null })
  })

  it('disconnects even when HitPay cannot remove the webhook', async () => {
    const { merchantId, token } = await ownerShop()
    await call('PUT', `/api/merchants/${merchantId}/hitpay`, token, { apiKey: 'key_6666' })
    hitpayDeps.hitpay = fakeHitpay({ async removeWebhook() { throw new HitpayUnavailable('down') } })
    expect((await call('DELETE', `/api/merchants/${merchantId}/hitpay`, token)).status).toBe(200)
  })

  it("refuses another merchant's shop", async () => {
    const a = await ownerShop()
    const b = await ownerShop()
    expect((await call('PUT', `/api/merchants/${a.merchantId}/hitpay`, b.token, { apiKey: 'k' })).status).toBe(403)
  })

  it('makes a connected shop take orders as pending_payment, with no static payment info', async () => {
    const { merchantId } = await ownerShop()
    await serviceClient().from('merchants').update({ hitpay_connected: true }).eq('id', merchantId)
    const productId = await seedProduct({ merchant_id: merchantId, name: 'Cookie', price: 10 })
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId, customerName: 'Ah Meng', customerWa: '60123456789', mode: 'pickup',
        cart: [{ productId, qty: 1, selections: [] }], quotedTotal: 10,
        fulfilDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('pending_payment')
  })
})
```

> `seedProduct` returns the product id (read its last lines in `tests/rls/helpers.ts` to confirm). If `POST /api/orders` refuses the date, copy `tomorrowInShopZone()` from `tests/api/notifyOrder.test.ts`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @bitetime/backend test:db -- tests/api/hitpay-connect.test.ts`
Expected: FAIL — `hitpayDeps` is not exported from `app.ts`.

- [ ] **Step 3: Add the env vars.** In `apps/backend/src/env.ts`, after `googleMapsApiKey`:

```ts
  // HitPay (spec 2026-10-02): each merchant's OWN account, reached with the merchant's own key —
  // TinyOrder holds no HitPay credential. These two only say WHERE: the API base (sandbox in local
  // work, live in production) and this backend's public HTTPS origin, which starts the webhook URL
  // registered on each merchant's account. Optional: unset, the HitPay routes answer 503 and a
  // shop with no connection is not affected.
  hitpayApiBase: process.env.HITPAY_API_BASE || '',
  backendPublicUrl: process.env.BACKEND_PUBLIC_URL || '',
```

And in `apps/backend/.env.example`, add:

```bash
# HitPay dynamic DuitNow QR (optional). Sandbox: https://api.sandbox.hit-pay.com/v1
HITPAY_API_BASE=
# Public HTTPS origin of this backend, for the HitPay webhook URL. HitPay rejects localhost.
BACKEND_PUBLIC_URL=
```

- [ ] **Step 4: Write the connection half of `hitpayPaymentDb.ts`**

```ts
// The HitPay flow's SQL (spec 2026-10-02). `db.ts` is RLS-EXEMPT, so every statement here names
// the merchant it acts for: on this path, which shop a row belongs to is a TypeScript rule, not a
// Postgres one. The pure half is hitpayPayment.ts.
import { sql, withTransaction } from './db.js'

export interface HitpayConnection {
  apiKey: string
  webhookId: string
  token: string
}

export async function readHitpayConnection(merchantId: string): Promise<HitpayConnection | null> {
  const rows = await sql<{ hitpay_api_key: string | null; hitpay_webhook_id: string | null; hitpay_webhook_token: string | null }[]>`
    select hitpay_api_key, hitpay_webhook_id, hitpay_webhook_token
    from merchant_secrets where merchant_id = ${merchantId}
  `
  const r = rows[0]
  if (!r?.hitpay_api_key || !r.hitpay_webhook_id || !r.hitpay_webhook_token) return null
  return { apiKey: r.hitpay_api_key, webhookId: r.hitpay_webhook_id, token: r.hitpay_webhook_token }
}

/** The secret row and the shop's flag move together, or not at all. */
export async function saveHitpayConnection(merchantId: string, c: HitpayConnection): Promise<void> {
  await withTransaction(async (tx) => {
    await tx`
      insert into merchant_secrets (merchant_id, hitpay_api_key, hitpay_webhook_id, hitpay_webhook_token)
      values (${merchantId}, ${c.apiKey}, ${c.webhookId}, ${c.token})
      on conflict (merchant_id) do update set
        hitpay_api_key = excluded.hitpay_api_key,
        hitpay_webhook_id = excluded.hitpay_webhook_id,
        hitpay_webhook_token = excluded.hitpay_webhook_token
    `
    await tx`update merchants set hitpay_connected = true where id = ${merchantId}`
  })
}

export async function clearHitpayConnection(merchantId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx`
      update merchant_secrets
      set hitpay_api_key = null, hitpay_webhook_id = null, hitpay_webhook_token = null
      where merchant_id = ${merchantId}
    `
    await tx`update merchants set hitpay_connected = false where id = ${merchantId}`
  })
}

/** The shop a webhook URL names, or null. */
export async function merchantByWebhookToken(token: string): Promise<string | null> {
  const rows = await sql<{ merchant_id: string }[]>`
    select merchant_id from merchant_secrets where hitpay_webhook_token = ${token}
  `
  return rows[0]?.merchant_id ?? null
}
```

- [ ] **Step 5: Add the seam and the three routes to `app.ts`.** Add the imports at the top with the other local imports:

```ts
import { createHitpay, HitpayKeyRejected, type Hitpay } from './hitpay.js'
import { keyLast4, newWebhookToken } from './hitpayPayment.js'
import { clearHitpayConnection, readHitpayConnection, saveHitpayConnection } from './hitpayPaymentDb.js'
```

Then add this block directly after the `PUT /api/merchants/:id/secret` route:

```ts
// ── HitPay: a shop's OWN account (spec 2026-10-02-hitpay-duitnow-qr-design.md) ─────────────────
// The merchant pastes one API key. TinyOrder registers its own webhook on the merchant's account
// with that key — which is also the key test — and stores the key server-side only. No route
// ever returns it: the browser gets `keyLast4`.
//
// Same mutable seam as supportDeps: production uses the real adapter and env, an API test swaps
// in a fake and turns the feature on without env vars.
export const hitpayDeps: { hitpay: Hitpay; config: { apiBase: string; publicBackendUrl: string } } = {
  hitpay: createHitpay(),
  config: { apiBase: env.hitpayApiBase, publicBackendUrl: env.backendPublicUrl },
}

const hitpayConfigured = () => Boolean(hitpayDeps.config.apiBase && hitpayDeps.config.publicBackendUrl)

app.get('/api/merchants/:id/hitpay', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  try {
    const conn = await readHitpayConnection(m.id)
    return c.json({ connected: Boolean(conn), keyLast4: conn ? keyLast4(conn.apiKey) : null })
  } catch (e: any) {
    console.error('HitPay status read failed:', e?.message ?? e)
    return c.json({ error: 'lookup_failed' }, 500)
  }
})

app.put('/api/merchants/:id/hitpay', requireMerchantOwns, async (c) => {
  if (!hitpayConfigured()) return c.json({ error: 'hitpay_not_configured' }, 503)
  const m = c.get('merchant')
  // DuitNow settles in MYR only. `currency` cannot change after signup (writes.ts), so this check
  // holds for as long as the connection does.
  if ((m.currency ?? 'MYR') !== 'MYR') return c.json({ error: 'currency_not_supported' }, 400)
  const b = await c.req.json().catch(() => ({}) as any)
  const apiKey = typeof b?.apiKey === 'string' ? b.apiKey.trim() : ''
  if (!apiKey || apiKey.length > 255) return c.json({ error: 'invalid_key' }, 400)

  const { apiBase, publicBackendUrl } = hitpayDeps.config
  const token = newWebhookToken()
  const url = `${publicBackendUrl.replace(/\/$/, '')}/api/hitpay/webhook/${token}`
  let previous: Awaited<ReturnType<typeof readHitpayConnection>>
  let webhook: { id: string }
  try {
    previous = await readHitpayConnection(m.id)
  } catch (e: any) {
    console.error('HitPay connect lookup failed:', e?.message ?? e)
    return c.json({ error: 'lookup_failed' }, 500)
  }
  try {
    webhook = await hitpayDeps.hitpay.registerWebhook(apiBase, apiKey, url)
  } catch (e) {
    if (e instanceof HitpayKeyRejected) return c.json({ error: 'invalid_key' }, 400)
    console.error('HitPay connect failed:', e instanceof Error ? e.message : String(e))
    return c.json({ error: 'gateway_unavailable' }, 502)
  }
  try {
    await saveHitpayConnection(m.id, { apiKey, webhookId: webhook.id, token })
  } catch (e: any) {
    console.error('HitPay connect store failed:', e?.message ?? e)
    return c.json({ error: 'store_failed' }, 500)
  }
  // Best effort, after the new one is stored: a webhook left behind on the merchant's account
  // only points at a token that no longer names a shop.
  if (previous) {
    hitpayDeps.hitpay.removeWebhook(apiBase, previous.apiKey, previous.webhookId)
      .catch(e => console.error('HitPay old webhook removal failed:', e?.message ?? e))
  }
  return c.json({ connected: true, keyLast4: keyLast4(apiKey) })
})

app.delete('/api/merchants/:id/hitpay', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  try {
    const conn = await readHitpayConnection(m.id)
    if (conn && hitpayDeps.config.apiBase) {
      await hitpayDeps.hitpay.removeWebhook(hitpayDeps.config.apiBase, conn.apiKey, conn.webhookId)
        .catch(e => console.error('HitPay webhook removal failed:', e?.message ?? e))
    }
    await clearHitpayConnection(m.id)
  } catch (e: any) {
    console.error('HitPay disconnect failed:', e?.message ?? e)
    return c.json({ error: 'store_failed' }, 500)
  }
  return c.json({ connected: false, keyLast4: null })
})
```

- [ ] **Step 6: Change the intake rule in `orders.ts`.** In `assertOrderableMerchant`, add `hitpay_connected: boolean | null` to `MerchantRow`, add `hitpay_connected` to the `select` column list after `payment_note`, and replace the `hasPaymentInfo` line with:

```ts
    // #182: an order is born pending_payment only when the customer will actually SEE somewhere
    // to pay — the static bank/QR/note with its proof upload, or (spec 2026-10-02) the shop's own
    // HitPay QR. A shop with none of these has no payment surface, so gating it would strand
    // every order.
    hasPaymentInfo: Boolean(merchant.payment_bank || merchant.payment_qr || merchant.payment_note || merchant.hitpay_connected),
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @bitetime/backend test:db -- tests/api/hitpay-connect.test.ts tests/api/orders.test.ts tests/api/writes-secret.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/env.ts apps/backend/.env.example apps/backend/src/hitpayPaymentDb.ts apps/backend/src/app.ts \
  apps/backend/src/orders.ts apps/backend/tests/api/hitpay-connect.test.ts
git commit -m "feat(hitpay): let a merchant connect their own HitPay account

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

---

### Task 5: The QR, the poll, the webhook, and the settle transaction

**Files:**
- Modify: `apps/backend/src/hitpayPaymentDb.ts` (append the payment half)
- Create: `apps/backend/src/hitpayConfirm.ts`
- Modify: `apps/backend/src/quotaWindows.ts`
- Modify: `apps/backend/src/app.ts` (three routes)
- Test: `apps/backend/tests/api/hitpay-payment.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `interface OrderPaymentRow { id: string; orderId: string; merchantId: string; gateway: 'hitpay'; gatewayRequestId: string; qrPayload: string; amount: string; currency: string; status: PaymentRowStatus; expiresAt: Date; paidAt: Date | null }`
  - `interface PayableOrder { id: string; merchantId: string; status: string; total: string; currency: string; hitpayConnected: boolean }`
  - `payableOrder(orderId: string): Promise<PayableOrder | null>`
  - `latestOrderPayment(orderId: string, merchantId: string): Promise<OrderPaymentRow | null>`
  - `orderPaymentByRequestId(requestId: string, merchantId: string): Promise<OrderPaymentRow | null>`
  - `insertOrderPayment(row: Omit<OrderPaymentRow, 'id' | 'paidAt' | 'status'>): Promise<OrderPaymentRow | 'conflict'>`
  - `closeOrderPayment(id: string, merchantId: string, status: 'expired' | 'failed'): Promise<void>`
  - `type SettleOutcome = 'paid' | 'paid_after_cancel' | 'recorded' | 'already'`
  - `settleOrderPayment(paymentId: string, merchantId: string): Promise<{ outcome: SettleOutcome; orderNumber: string }>`
  - In `hitpayConfirm.ts`: `type ConfirmOutcome = SettleOutcome | 'pending' | 'closed' | 'mismatch' | 'unavailable' | 'disconnected'`, `interface PaymentAlert { merchantId: string; orderNumber: string; outcome: 'paid' | 'paid_after_cancel' }`, `interface ConfirmDeps { hitpay: Hitpay; apiBase: string; alert: (a: PaymentAlert) => Promise<void> }`, `confirmHitpayPayment(deps: ConfirmDeps, row: OrderPaymentRow): Promise<ConfirmOutcome>`
  - In `quotaWindows.ts`: `hitpayQrIpWindow`, `hitpayStatusIpWindow`
  - On `app.ts`: `export const hitpayAlertDeps: { alert: (a: PaymentAlert) => Promise<void> }` (Task 6 replaces its body)
  - Routes: `POST /api/orders/:orderId/hitpay-qr` → `{ status: 'live'; qrPayload: string; amount: string; currency: string; expiresAt: string } | { status: 'completed' }`; `GET /api/orders/:orderId/hitpay-status` → `{ payment: 'none' | PaymentRowStatus; orderStatus: string; expiresAt: string | null }`; `POST /api/hitpay/webhook/:token` → `{ ok: true }`

- [ ] **Step 1: Write the failing API test**

```ts
// tests/api/hitpay-payment.test.ts
// The customer's QR, the poll, the webhook, and the one transaction that settles an order. HitPay
// is faked through `hitpayDeps`; Postgres is real, because the properties here are row locks,
// a partial unique index, and tenancy on an RLS-exempt connection.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { app, hitpayDeps, hitpayAlertDeps } from '../../src/app.js'
import type { Hitpay, RemotePaymentRequest } from '../../src/hitpay.js'
import type { PaymentAlert } from '../../src/hitpayConfirm.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

const svc = () => serviceClient()
const realDeps = { ...hitpayDeps }
const realAlert = hitpayAlertDeps.alert
const alerts: PaymentAlert[] = []
let created = 0
let remoteStatus: Record<string, Partial<RemotePaymentRequest>> = {}
let remoteOrder: Record<string, string> = {}

function fakeHitpay(): Hitpay {
  return {
    async registerWebhook() { return { id: 'wh' } },
    async removeWebhook() {},
    async createQr(_b, _k, input) {
      created += 1
      const id = `pr_${crypto.randomUUID()}`
      remoteOrder[id] = input.reference
      return { id, qrPayload: `000201-${id}` }
    },
    async getPaymentRequest(_b, _k, id) {
      return {
        id, status: 'pending', amount: '10.00', currency: 'myr', referenceNumber: remoteOrder[id] ?? null,
        ...remoteStatus[id],
      }
    },
  }
}

beforeEach(() => {
  created = 0
  remoteStatus = {}
  remoteOrder = {}
  alerts.length = 0
  hitpayDeps.hitpay = fakeHitpay()
  hitpayDeps.config = { apiBase: 'https://hitpay.test/v1', publicBackendUrl: 'https://api.tinyorder.test' }
  hitpayAlertDeps.alert = async (a) => { alerts.push(a) }
})
afterAll(() => {
  Object.assign(hitpayDeps, realDeps)
  hitpayAlertDeps.alert = realAlert
})

let n = 0
async function connectedShop() {
  n += 1
  const owner = await makeUser(`hitpay-pay-${n}@example.com`, 'password123')
  const { data } = await owner.auth.getSession()
  const merchantId = await seedMerchant({ slug: `hitpay-pay-${n}`, owner_id: data.session!.user.id })
  const token = `tok_${crypto.randomUUID().replace(/-/g, '')}`
  await svc().from('merchant_secrets').upsert({
    merchant_id: merchantId, hitpay_api_key: `key_${n}`, hitpay_webhook_id: 'wh', hitpay_webhook_token: token,
  })
  await svc().from('merchants').update({ hitpay_connected: true }).eq('id', merchantId)
  return { merchantId, token }
}

async function order(merchantId: string, status = 'pending_payment') {
  const { data, error } = await svc().from('orders').insert({
    merchant_id: merchantId, order_number: `HP-${crypto.randomUUID().slice(0, 8)}`, status,
    customer_name: 'Ah Meng', customer_wa: '60123456789', total: 10, currency: 'MYR',
  }).select('id, order_number').single()
  if (error) throw new Error(error.message)
  return data as { id: string; order_number: string }
}

const postQr = (orderId: string) => app.request(`/api/orders/${orderId}/hitpay-qr`, { method: 'POST' })
const getStatus = (orderId: string) => app.request(`/api/orders/${orderId}/hitpay-status`)
const signal = (token: string, body: unknown) => app.request(`/api/hitpay/webhook/${token}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const payment = async (orderId: string) =>
  (await svc().from('order_payments').select('*').eq('order_id', orderId).order('created_at')).data ?? []
const orderStatus = async (orderId: string) =>
  (await svc().from('orders').select('status').eq('id', orderId).single()).data!.status

describe('POST /api/orders/:id/hitpay-qr', () => {
  it('creates one QR for the order total and returns the same QR on a second call', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    const first = await (await postQr(o.id)).json()
    expect(first).toMatchObject({ status: 'live', amount: '10.00', currency: 'MYR' })
    expect(first.qrPayload).toMatch(/^000201-pr_/)
    const second = await (await postQr(o.id)).json()
    expect(second.qrPayload).toBe(first.qrPayload)
    expect(created).toBe(1)
  })

  it('makes only one live QR for two requests at the same time', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    const [a, b] = await Promise.all([postQr(o.id), postQr(o.id)])
    const [ja, jb] = [await a.json(), await b.json()]
    expect(ja.qrPayload).toBe(jb.qrPayload)
    expect((await payment(o.id)).filter(r => r.status === 'pending')).toHaveLength(1)
  })

  it('checks the expired QR with HitPay before it makes a new one', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    await svc().from('order_payments').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', row.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    expect(await (await postQr(o.id)).json()).toEqual({ status: 'completed' })
    expect(created).toBe(1)
    expect(await orderStatus(o.id)).toBe('new')
  })

  it('makes a new QR after the old one expired unpaid', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    await svc().from('order_payments').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', row.id)
    remoteStatus[row.gateway_request_id] = { status: 'expired' }
    expect((await (await postQr(o.id)).json()).status).toBe('live')
    expect(created).toBe(2)
    expect((await payment(o.id)).map(r => r.status)).toEqual(['expired', 'pending'])
  })

  it('answers 409 not_payable for an order that is not pending_payment, or a shop not connected', async () => {
    const { merchantId } = await connectedShop()
    expect((await postQr((await order(merchantId, 'new')).id)).status).toBe(409)
    const o = await order(merchantId)
    await svc().from('merchants').update({ hitpay_connected: false }).eq('id', merchantId)
    expect((await postQr(o.id)).status).toBe(409)
  })

  it('answers 502 when HitPay cannot make the QR', async () => {
    hitpayDeps.hitpay = { ...fakeHitpay(), async createQr() { throw new Error('down') } }
    const { merchantId } = await connectedShop()
    const res = await postQr((await order(merchantId)).id)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('gateway_unavailable')
  })

  it('answers 404 for an unknown or malformed order id', async () => {
    expect((await postQr(crypto.randomUUID())).status).toBe(404)
    expect((await postQr('nope')).status).toBe(404)
  })
})

describe('confirmation', () => {
  it('a poll moves a paid order to new, logs it, and alerts once', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }

    expect(await (await getStatus(o.id)).json()).toMatchObject({ payment: 'completed', orderStatus: 'new' })
    await getStatus(o.id)
    expect(alerts).toEqual([{ merchantId, orderNumber: o.order_number, outcome: 'paid' }])
    const { data: events } = await svc().from('order_events').select('kind, actor_kind').eq('order_id', o.id).order('id')
    expect(events).toEqual([
      { kind: 'payment_confirmed', actor_kind: 'system' },
      { kind: 'status_changed', actor_kind: 'system' },
    ])
  })

  it('a webhook signal does the same, and a repeat signal does nothing', async () => {
    const { merchantId, token } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    expect((await signal(token, { id: 'ch_1', payment_request_id: row.gateway_request_id })).status).toBe(200)
    expect((await signal(token, { id: 'ch_1', payment_request_id: row.gateway_request_id })).status).toBe(200)
    expect(await orderStatus(o.id)).toBe('new')
    expect(alerts).toHaveLength(1)
  })

  it('ignores a request id that belongs to a different shop', async () => {
    const x = await connectedShop()
    const y = await connectedShop()
    const oy = await order(y.merchantId)
    await postQr(oy.id)
    const [row] = await payment(oy.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    expect((await signal(x.token, { payment_request_id: row.gateway_request_id })).status).toBe(200)
    expect(await orderStatus(oy.id)).toBe('pending_payment')
    expect(alerts).toEqual([])
  })

  it('answers 200 to an unknown token and to a body with no request id', async () => {
    expect((await signal('unknown-token', { payment_request_id: 'pr_x' })).status).toBe(200)
    const { token } = await connectedShop()
    expect((await signal(token, { hello: 'world' })).status).toBe(200)
  })

  it('refuses a completed request whose amount does not agree', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed', amount: '1.00' }
    expect((await (await getStatus(o.id)).json()).orderStatus).toBe('pending_payment')
    expect(alerts).toEqual([])
  })

  it('keeps a cancelled order cancelled and records the payment for a refund', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    await svc().from('orders').update({ status: 'cancelled' }).eq('id', o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    await getStatus(o.id)
    expect(await orderStatus(o.id)).toBe('cancelled')
    expect(alerts).toEqual([{ merchantId, orderNumber: o.order_number, outcome: 'paid_after_cancel' }])
    const { data: events } = await svc().from('order_events').select('kind').eq('order_id', o.id)
    expect(events).toEqual([{ kind: 'payment_after_cancel' }])
  })

  it('does nothing after the shop disconnects', async () => {
    const { merchantId } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    await svc().from('merchant_secrets').update({ hitpay_api_key: null, hitpay_webhook_id: null, hitpay_webhook_token: null }).eq('merchant_id', merchantId)
    const res = await getStatus(o.id)
    expect(res.status).toBe(200)
    expect(await orderStatus(o.id)).toBe('pending_payment')
  })

  it("a webhook still confirms after the screen's local expiry", async () => {
    const { merchantId, token } = await connectedShop()
    const o = await order(merchantId)
    await postQr(o.id)
    const [row] = await payment(o.id)
    await svc().from('order_payments').update({ status: 'expired' }).eq('id', row.id)
    remoteStatus[row.gateway_request_id] = { status: 'completed' }
    await signal(token, { payment_request_id: row.gateway_request_id })
    expect(await orderStatus(o.id)).toBe('new')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @bitetime/backend test:db -- tests/api/hitpay-payment.test.ts`
Expected: FAIL — `hitpayAlertDeps` is not exported from `app.ts`.

- [ ] **Step 3: Append the payment half to `hitpayPaymentDb.ts`**

```ts
import type { PaymentRowStatus } from './hitpayPayment.js'
import { recordOrderEvents, SYSTEM_ACTOR } from './orderEventsDb.js'

export interface OrderPaymentRow {
  id: string
  orderId: string
  merchantId: string
  gateway: 'hitpay'
  gatewayRequestId: string
  qrPayload: string
  amount: string
  currency: string
  status: PaymentRowStatus
  expiresAt: Date
  paidAt: Date | null
}

type PaymentDbRow = {
  id: string; order_id: string; merchant_id: string; gateway: 'hitpay'; gateway_request_id: string
  qr_payload: string; amount: string; currency: string; status: PaymentRowStatus; expires_at: Date; paid_at: Date | null
}

function toRow(r: PaymentDbRow): OrderPaymentRow {
  return {
    id: r.id, orderId: r.order_id, merchantId: r.merchant_id, gateway: r.gateway,
    gatewayRequestId: r.gateway_request_id, qrPayload: r.qr_payload, amount: String(r.amount),
    currency: r.currency, status: r.status, expiresAt: r.expires_at, paidAt: r.paid_at,
  }
}

export interface PayableOrder {
  id: string
  merchantId: string
  status: string
  total: string
  currency: string
  hitpayConnected: boolean
}

/**
 * The order the public QR routes act on, with its shop's flag. `null` for a missing OR malformed
 * id — the same `22P02` carve-out as `orderMerchantId` in orders.ts, and only that one: any other
 * error is a real database failure and is rethrown.
 */
export async function payableOrder(orderId: string): Promise<PayableOrder | null> {
  try {
    const rows = await sql<{ id: string; merchant_id: string; status: string | null; total: string; currency: string | null; hitpay_connected: boolean }[]>`
      select o.id, o.merchant_id, o.status, o.total, o.currency, m.hitpay_connected
      from orders o join merchants m on m.id = o.merchant_id
      where o.id = ${orderId}
    `
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id, merchantId: r.merchant_id, status: r.status ?? 'new', total: String(r.total),
      currency: r.currency ?? 'MYR', hitpayConnected: r.hitpay_connected,
    }
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === '22P02') return null
    throw err
  }
}

const PAYMENT_COLUMNS = sql`id, order_id, merchant_id, gateway, gateway_request_id, qr_payload, amount, currency, status, expires_at, paid_at`

export async function latestOrderPayment(orderId: string, merchantId: string): Promise<OrderPaymentRow | null> {
  const rows = await sql<PaymentDbRow[]>`
    select ${PAYMENT_COLUMNS} from order_payments
    where order_id = ${orderId} and merchant_id = ${merchantId}
    order by created_at desc limit 1
  `
  return rows[0] ? toRow(rows[0]) : null
}

export async function orderPaymentByRequestId(requestId: string, merchantId: string): Promise<OrderPaymentRow | null> {
  const rows = await sql<PaymentDbRow[]>`
    select ${PAYMENT_COLUMNS} from order_payments
    where gateway_request_id = ${requestId} and merchant_id = ${merchantId}
  `
  return rows[0] ? toRow(rows[0]) : null
}

/** `'conflict'` when another request already holds the order's one pending row. */
export async function insertOrderPayment(
  row: Omit<OrderPaymentRow, 'id' | 'paidAt' | 'status'>,
): Promise<OrderPaymentRow | 'conflict'> {
  try {
    const rows = await sql<PaymentDbRow[]>`
      insert into order_payments (order_id, merchant_id, gateway, gateway_request_id, qr_payload, amount, currency, status, expires_at)
      values (${row.orderId}, ${row.merchantId}, ${row.gateway}, ${row.gatewayRequestId}, ${row.qrPayload},
              ${row.amount}, ${row.currency}, 'pending', ${row.expiresAt})
      returning ${PAYMENT_COLUMNS}
    `
    return toRow(rows[0])
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') return 'conflict'
    throw err
  }
}

/** Never touches a completed row: a payment that landed stays landed. */
export async function closeOrderPayment(id: string, merchantId: string, status: 'expired' | 'failed'): Promise<void> {
  await sql`
    update order_payments set status = ${status}
    where id = ${id} and merchant_id = ${merchantId} and status <> 'completed'
  `
}

export type SettleOutcome = 'paid' | 'paid_after_cancel' | 'recorded' | 'already'

/**
 * HitPay said this request is paid. One transaction: lock the payment row, then the order, then
 * decide from the order's status AT THE LOCK. Lock order is payment → order; no other path locks
 * order_payments, so this cannot deadlock against a merchant's order PATCH.
 *
 *   pending_payment → new, `payment_confirmed` + `status_changed` (both by the system)
 *   cancelled       → stays cancelled, `payment_after_cancel` — the shop must refund it
 *   any other       → the merchant moved it already; `payment_confirmed` only
 *   row completed   → nothing: a second signal or poll is safe
 */
export async function settleOrderPayment(
  paymentId: string,
  merchantId: string,
): Promise<{ outcome: SettleOutcome; orderNumber: string }> {
  return withTransaction(async (tx) => {
    const [p] = await tx<{ id: string; order_id: string; status: string; gateway: string; gateway_request_id: string }[]>`
      select id, order_id, status, gateway, gateway_request_id from order_payments
      where id = ${paymentId} and merchant_id = ${merchantId} for update
    `
    if (!p) throw new Error(`order payment ${paymentId} not found for merchant ${merchantId}`)
    const [o] = await tx<{ status: string | null; order_number: string }[]>`
      select status, order_number from orders where id = ${p.order_id} and merchant_id = ${merchantId} for update
    `
    if (!o) throw new Error(`order ${p.order_id} not found for merchant ${merchantId}`)
    if (p.status === 'completed') return { outcome: 'already' as const, orderNumber: o.order_number }

    await tx`update order_payments set status = 'completed', paid_at = now() where id = ${p.id}`
    const order = { id: p.order_id, merchantId }
    const detail = { gateway: p.gateway, request_id: p.gateway_request_id }
    const status = o.status ?? 'new'
    if (status === 'pending_payment') {
      await tx`update orders set status = 'new' where id = ${p.order_id}`
      await recordOrderEvents(tx, order, SYSTEM_ACTOR, [
        { kind: 'payment_confirmed', detail },
        { kind: 'status_changed', detail: { from: 'pending_payment', to: 'new' } },
      ])
      return { outcome: 'paid' as const, orderNumber: o.order_number }
    }
    if (status === 'cancelled') {
      await recordOrderEvents(tx, order, SYSTEM_ACTOR, [{ kind: 'payment_after_cancel', detail }])
      return { outcome: 'paid_after_cancel' as const, orderNumber: o.order_number }
    }
    await recordOrderEvents(tx, order, SYSTEM_ACTOR, [{ kind: 'payment_confirmed', detail }])
    return { outcome: 'recorded' as const, orderNumber: o.order_number }
  })
}
```

Move the two new `import` lines to the top of the file, next to the existing `import { sql, withTransaction } from './db.js'`.

- [ ] **Step 4: Write `hitpayConfirm.ts`**

```ts
// The ONE function both confirmation paths call — the webhook signal and the browser's poll — so
// the two cannot drift apart (spec 2026-10-02 → "confirmHitpayPayment").
//
// It trusts nothing it was handed except the row it was given: it asks HitPay with the key of the
// shop that OWNS that row, judges the answer with the pure rules, and settles in one transaction.
// The alert runs only after the commit, and its failure is logged, never thrown: a Telegram
// outage must not look like an unpaid order.
import type { Hitpay } from './hitpay.js'
import { judgePayment } from './hitpayPayment.js'
import {
  closeOrderPayment, readHitpayConnection, settleOrderPayment,
  type OrderPaymentRow, type SettleOutcome,
} from './hitpayPaymentDb.js'

export type ConfirmOutcome = SettleOutcome | 'pending' | 'closed' | 'mismatch' | 'unavailable' | 'disconnected'

export interface PaymentAlert {
  merchantId: string
  orderNumber: string
  outcome: 'paid' | 'paid_after_cancel'
}

export interface ConfirmDeps {
  hitpay: Hitpay
  apiBase: string
  alert: (a: PaymentAlert) => Promise<void>
}

export async function confirmHitpayPayment(deps: ConfirmDeps, row: OrderPaymentRow): Promise<ConfirmOutcome> {
  if (row.status === 'completed') return 'already'
  const conn = await readHitpayConnection(row.merchantId)
  if (!conn) return 'disconnected'

  let remote
  try {
    remote = await deps.hitpay.getPaymentRequest(deps.apiBase, conn.apiKey, row.gatewayRequestId)
  } catch (e) {
    console.error(`HitPay status read failed for ${row.gatewayRequestId}:`, e instanceof Error ? e.message : String(e))
    return 'unavailable'
  }

  const verdict = judgePayment(remote, { amount: row.amount, currency: row.currency, orderId: row.orderId })
  if (verdict.kind === 'pending') return 'pending'
  if (verdict.kind === 'closed') {
    await closeOrderPayment(row.id, row.merchantId, verdict.status)
    return 'closed'
  }
  if (verdict.kind === 'mismatch') {
    console.error(`HitPay payment ${row.gatewayRequestId} does not match order ${row.orderId}: ${verdict.reason}`)
    return 'mismatch'
  }

  const settled = await settleOrderPayment(row.id, row.merchantId)
  if (settled.outcome === 'paid' || settled.outcome === 'paid_after_cancel') {
    await deps.alert({ merchantId: row.merchantId, orderNumber: settled.orderNumber, outcome: settled.outcome })
      .catch(e => console.error('HitPay payment alert failed:', e?.message ?? e))
  }
  return settled.outcome
}
```

- [ ] **Step 5: Add the two IP windows.** In `apps/backend/src/quotaWindows.ts`, after `reviewSubmitIpWindow`:

```ts
// The customer's HitPay QR door (spec 2026-10-02). Addressed by an order UUID, unauthenticated
// like the payment-proof door. A QR costs a HitPay call, so it gets the guest-door bound; the
// status poll runs every 3 s for up to 15 minutes, so its bound is set above that (20/minute,
// 300 per QR) with room for a second open tab.
export const hitpayQrIpWindow = createIpDoorWindow(10, 60)
export const hitpayStatusIpWindow = createIpDoorWindow(45, 1200)
```

- [ ] **Step 6: Add the routes to `app.ts`.** Extend the imports from Task 4:

```ts
import { createHitpay, HitpayKeyRejected, type Hitpay } from './hitpay.js'
import { isLive, keyLast4, moneyString, newWebhookToken, QR_LIFETIME_MINUTES, readSignalRequestId } from './hitpayPayment.js'
import {
  clearHitpayConnection, closeOrderPayment, insertOrderPayment, latestOrderPayment, merchantByWebhookToken,
  orderPaymentByRequestId, payableOrder, readHitpayConnection, saveHitpayConnection, type OrderPaymentRow,
} from './hitpayPaymentDb.js'
import { confirmHitpayPayment, type PaymentAlert } from './hitpayConfirm.js'
```

Add `hitpayQrIpWindow, hitpayStatusIpWindow` to the existing `./quotaWindows.js` import. Then add after the `DELETE /api/merchants/:id/hitpay` route:

```ts
// The merchant's alert after a HitPay payment. A seam so the payment suite can count alerts
// without the notify fan-out; Task 6 fills the real body.
export const hitpayAlertDeps: { alert: (a: PaymentAlert) => Promise<void> } = {
  alert: async () => {},
}

const confirmDeps = () => ({
  hitpay: hitpayDeps.hitpay,
  apiBase: hitpayDeps.config.apiBase,
  alert: (a: PaymentAlert) => hitpayAlertDeps.alert(a),
})

const qrBody = (row: OrderPaymentRow) => ({
  status: 'live' as const,
  qrPayload: row.qrPayload,
  amount: moneyString(row.amount),
  currency: row.currency,
  expiresAt: row.expiresAt.toISOString(),
})

// The customer's QR. Unauthenticated and addressed by the order UUID, exactly like the
// payment-proof door: a guest has no token, and a UUID is not guessable.
app.post('/api/orders/:orderId/hitpay-qr', async (c) => {
  if (!hitpayQrIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)
  if (!hitpayDeps.config.apiBase) return c.json({ error: 'hitpay_not_configured' }, 503)
  try {
    const order = await payableOrder(c.req.param('orderId'))
    if (!order) return c.json({ error: 'not_found' }, 404)
    if (order.status !== 'pending_payment' || !order.hitpayConnected) return c.json({ error: 'not_payable' }, 409)
    const conn = await readHitpayConnection(order.merchantId)
    if (!conn) return c.json({ error: 'not_payable' }, 409)

    const now = new Date()
    const latest = await latestOrderPayment(order.id, order.merchantId)
    if (latest && isLive(latest, now)) return c.json(qrBody(latest))
    if (latest && latest.status !== 'completed') {
      // The old QR's time ran out on OUR clock. Ask HitPay before making a second one: a customer
      // who paid at 14:59 must not be handed a QR that can take a second payment.
      const outcome = await confirmHitpayPayment(confirmDeps(), latest)
      if (outcome === 'paid' || outcome === 'paid_after_cancel' || outcome === 'recorded' || outcome === 'already') {
        return c.json({ status: 'completed' as const })
      }
      if (outcome === 'unavailable') return c.json({ error: 'gateway_unavailable' }, 502)
      await closeOrderPayment(latest.id, order.merchantId, 'expired')
    }

    let created: { id: string; qrPayload: string }
    try {
      created = await hitpayDeps.hitpay.createQr(hitpayDeps.config.apiBase, conn.apiKey, {
        amount: moneyString(order.total),
        currency: order.currency.toLowerCase(),
        reference: order.id,
        expiresAfterMinutes: QR_LIFETIME_MINUTES,
      })
    } catch (e) {
      console.error('HitPay QR create failed:', e instanceof Error ? e.message : String(e))
      return c.json({ error: 'gateway_unavailable' }, 502)
    }
    const inserted = await insertOrderPayment({
      orderId: order.id, merchantId: order.merchantId, gateway: 'hitpay', gatewayRequestId: created.id,
      qrPayload: created.qrPayload, amount: moneyString(order.total), currency: order.currency,
      expiresAt: new Date(now.getTime() + QR_LIFETIME_MINUTES * 60_000),
    })
    if (inserted === 'conflict') {
      // A concurrent request won the order's one pending row. Hand back ITS QR; the request we
      // just made at HitPay expires unseen, and allow_repeated_payments=false keeps it harmless.
      const winner = await latestOrderPayment(order.id, order.merchantId)
      return winner && winner.status === 'pending' ? c.json(qrBody(winner)) : c.json({ error: 'gateway_unavailable' }, 502)
    }
    return c.json(qrBody(inserted))
  } catch (e: any) {
    console.error('HitPay QR route failed:', e?.message ?? e)
    return c.json({ error: 'lookup_failed' }, 500)
  }
})

// The browser's poll while the QR is on screen. Each call runs the same confirmation as the
// webhook, so a payment confirms even when HitPay's signal is late or lost.
app.get('/api/orders/:orderId/hitpay-status', async (c) => {
  if (!hitpayStatusIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)
  try {
    const order = await payableOrder(c.req.param('orderId'))
    if (!order) return c.json({ error: 'not_found' }, 404)
    let row = await latestOrderPayment(order.id, order.merchantId)
    if (!row) return c.json({ payment: 'none', orderStatus: order.status, expiresAt: null })
    if (row.status !== 'completed' && hitpayDeps.config.apiBase) {
      await confirmHitpayPayment(confirmDeps(), row)
      row = (await latestOrderPayment(order.id, order.merchantId)) ?? row
    }
    const fresh = (await payableOrder(order.id)) ?? order
    return c.json({ payment: row.status, orderStatus: fresh.status, expiresAt: row.expiresAt.toISOString() })
  } catch (e: any) {
    console.error('HitPay status route failed:', e?.message ?? e)
    return c.json({ error: 'lookup_failed' }, 500)
  }
})

// HitPay's signal. The status code is a conversation with HitPay, not with a person: any non-2xx
// makes HitPay send it again. So an ignored signal gets 200, and only a database failure gets
// 500. The body is NOT trusted — it carries no signature we can check — so the only thing read
// from it is which request to ask HitPay about, and the request must belong to the shop the
// URL token names.
app.post('/api/hitpay/webhook/:token', async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    const merchantId = await merchantByWebhookToken(c.req.param('token'))
    if (!merchantId) return c.json({ ok: true })
    const requestId = readSignalRequestId(body)
    if (!requestId) return c.json({ ok: true })
    const row = await orderPaymentByRequestId(requestId, merchantId)
    if (!row || !hitpayDeps.config.apiBase) return c.json({ ok: true })
    await confirmHitpayPayment(confirmDeps(), row)
    return c.json({ ok: true })
  } catch (e: any) {
    console.error('HitPay webhook failed:', e?.message ?? e)
    return c.json({ error: 'store_failed' }, 500)
  }
})
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @bitetime/backend test:db -- tests/api/hitpay-payment.test.ts tests/api/hitpay-connect.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/hitpayPaymentDb.ts apps/backend/src/hitpayConfirm.ts apps/backend/src/quotaWindows.ts \
  apps/backend/src/app.ts apps/backend/tests/api/hitpay-payment.test.ts
git commit -m "feat(hitpay): make a QR for an order and confirm its payment with HitPay

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

---

### Task 6: Notifications — hold, paid alert, refund alert, receipt line

**Files:**
- Modify: `apps/backend/src/notify.ts` (`buildOrderMessage`, `notifyOrderPlaced`)
- Modify: `apps/backend/src/orderEmails.ts` (`buildMerchantOrderEmail`, `emailMerchantOrder`, `emailOrderConfirmation`)
- Modify: `apps/backend/src/hitpayPaymentDb.ts` (add `merchantAlertHeld`)
- Modify: `apps/backend/src/app.ts` (`/api/notify/order`, `hitpayAlertDeps`)
- Modify: `apps/backend/tests/unit/notify.test.ts`, `apps/backend/tests/unit/merchantOrderEmail.test.ts`
- Test: `apps/backend/tests/api/hitpay-alerts.test.ts`

**Interfaces:**
- Consumes: `AlertBanner` (Task 3), `PAID_BANNER`, `PAID_AFTER_CANCEL_BANNER` (Task 3), `hitpayAlertDeps`, `PaymentAlert` (Task 5).
- Produces:
  - `buildOrderMessage(order: any, merchantName?: string, banner?: AlertBanner): string`
  - `notifyOrderPlaced(db: any, send: TelegramSend, input: NotifyOrderInput, banner?: AlertBanner): Promise<NotifyResult>`
  - `buildMerchantOrderEmail(order: any, shopName: string, dashboardUrl: string, banner?: AlertBanner): OrderConfirmationEmail`
  - `emailMerchantOrder(db: any, admin: any, send: EmailSend, input: NotifyOrderInput, cfg: EmailOrderConfig, banner?: AlertBanner): Promise<NotifyResult>`
  - `merchantAlertHeld(merchantId: string, orderNumber: string): Promise<boolean>`

- [ ] **Step 1: Write the failing unit tests.** Append to `tests/unit/notify.test.ts`:

```ts
describe('buildOrderMessage with a banner', () => {
  it('puts the banner line first and keeps the order', () => {
    const msg = buildOrderMessage(
      { order_number: 'BT-261002-0050', customer_name: 'Sam', items: [], total: 10, currency: 'MYR' },
      'Sunny Bakes',
      { line: '✅ Paid by DuitNow (HitPay)', subjectPrefix: 'Paid' },
    )
    expect(msg.startsWith('✅ Paid by DuitNow (HitPay)\n')).toBe(true)
    expect(msg).toContain('BT-261002-0050')
  })
})
```

Append to `tests/unit/merchantOrderEmail.test.ts`:

```ts
describe('buildMerchantOrderEmail with a banner', () => {
  it('prefixes the subject and puts the line at the top of both parts', () => {
    const banner = { line: '✅ Paid by DuitNow (HitPay)', subjectPrefix: 'Paid' }
    const mail = buildMerchantOrderEmail(PICKUP_ORDER, 'Sunny Bakes', 'https://x/merchant', banner)
    expect(mail.subject.startsWith('Paid: New order BT-260629-0052')).toBe(true)
    expect(mail.text.split('\n')[0]).toBe('✅ Paid by DuitNow (HitPay)')
    expect(mail.html).toContain('✅ Paid by DuitNow (HitPay)')
  })
  it('does not change the mail when there is no banner', () => {
    const mail = buildMerchantOrderEmail(PICKUP_ORDER, 'Sunny Bakes', 'https://x/merchant')
    expect(mail.subject.startsWith('New order')).toBe(true)
  })
})
```

> If `notify.test.ts` does not import `buildOrderMessage` or `describe`, add them to its existing import lines.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @bitetime/backend exec vitest run tests/unit/notify.test.ts tests/unit/merchantOrderEmail.test.ts`
Expected: FAIL — the banner line is absent.

- [ ] **Step 3: Add the banner to `notify.ts`.** Import the type: change the first import to also take `type AlertBanner` from `./orderNotice.js`. Change the signature and the line that starts `msg` in `buildOrderMessage`:

```ts
export function buildOrderMessage(order: any, merchantName?: string, banner?: AlertBanner): string {
```

```ts
  // A banner (a HitPay payment) goes first, as plain text: no `*` markers, because an unclosed
  // one turns the whole Markdown send into a 400.
  let msg = banner ? `${banner.line}\n\n` : ''
  msg += `🛎️ *New order${merchantName ? ` — ${merchantName}` : ''}*\n\n`
```

And in `notifyOrderPlaced`, add the parameter `banner?: AlertBanner` after `input`, and pass it in the send: `buildOrderMessage(order, merchant?.name, banner)`.

- [ ] **Step 4: Add the banner to `orderEmails.ts`.** Import `type AlertBanner` from `./orderNotice.js`. In `buildMerchantOrderEmail`, add the parameter `banner?: AlertBanner` and change three places:

```ts
  const subject = `${banner ? `${banner.subjectPrefix}: ` : ''}New order ${order.order_number} — ${total}`
```

```ts
  const textLines: string[] = []
  if (banner) { textLines.push(banner.line); textLines.push('') }
  textLines.push(`New order — ${shopName}`)
```

```ts
  const html = emailShell(`  ${banner ? `<p style="font-size:15px;font-weight:bold;margin:0 0 12px;">${esc(banner.line)}</p>` : ''}
  <h1 style="font-size:20px;margin:0 0 4px;">New order — ${esc(shopName)}</h1>
```

In `emailMerchantOrder`, add the parameter `banner?: AlertBanner` after `cfg`, and pass it: `buildMerchantOrderEmail(order, merchant.name ?? '', \`${cfg.frontendUrl}/merchant\`, banner)`.

In `emailOrderConfirmation`, change the merchant select to `'name, slug, payment_bank, payment_note, payment_qr, hitpay_connected'` and replace the `const payment: PaymentInstructionsInput = {...}` block with:

```ts
  // A HitPay shop's unpaid order is paid with the dynamic QR on the order page, never with the
  // static QR: a payment to that one gets no automatic confirmation (spec 2026-10-02). The line
  // is the shop-agnostic sentence, in the customer's language, through the note slot.
  const dynamicQr = Boolean(merchant?.hitpay_connected) && order.status === 'pending_payment'
  const payment: PaymentInstructionsInput = dynamicQr
    ? { note: lang === 'zh' ? '请在订单页面使用 DuitNow 二维码付款。' : 'Pay with the DuitNow QR on your order page.' }
    : {
        bank: merchant?.payment_bank ?? null,
        note: merchant?.payment_note ?? null,
        qrUrl: qr && cfg.qrBaseUrl ? paymentQrUrl(cfg.qrBaseUrl, qr) : null,
      }
```

- [ ] **Step 5: Run the unit tests**

Run: `pnpm --filter @bitetime/backend test`
Expected: PASS.

- [ ] **Step 6: Write the failing API test**

```ts
// tests/api/hitpay-alerts.test.ts
// Who hears about a HitPay order, and when. The notify adapters are faked through `notifyDeps`;
// HitPay through `hitpayDeps`; Postgres is real, because the merchant email's one-shot claim is a
// row update that only Postgres can prove.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { app, hitpayDeps, notifyDeps } from '../../src/app.js'
import type { Hitpay } from '../../src/hitpay.js'
import { makeUser, seedMerchant, serviceClient } from '../rls/helpers.js'

const svc = () => serviceClient()
const realHitpay = { ...hitpayDeps }
const realNotify = { ...notifyDeps }
const telegrams: string[] = []
const emails: { to: string; subject: string; text: string }[] = []
let paid = new Set<string>()

const fakeHitpay: Hitpay = {
  async registerWebhook() { return { id: 'wh' } },
  async removeWebhook() {},
  async createQr(_b, _k, input) { return { id: `pr_${input.reference}`, qrPayload: 'qr' } },
  async getPaymentRequest(_b, _k, id) {
    const orderId = id.slice(3)
    return { id, status: paid.has(orderId) ? 'completed' : 'pending', amount: '10.00', currency: 'myr', referenceNumber: orderId }
  },
}

beforeEach(() => {
  telegrams.length = 0
  emails.length = 0
  paid = new Set()
  hitpayDeps.hitpay = fakeHitpay
  hitpayDeps.config = { apiBase: 'https://hitpay.test/v1', publicBackendUrl: 'https://api.tinyorder.test' }
  notifyDeps.telegram = async (_t, _c, text) => { telegrams.push(text) }
  notifyDeps.email = (async (to: string, subject: string, body: { text: string }) => { emails.push({ to, subject, text: body.text }) }) as any
})
afterAll(() => {
  Object.assign(hitpayDeps, realHitpay)
  Object.assign(notifyDeps, realNotify)
})

let n = 0
async function connectedShopWithOrder(status = 'pending_payment') {
  n += 1
  const owner = await makeUser(`hitpay-alert-${n}@example.com`, 'password123')
  const { data } = await owner.auth.getSession()
  const merchantId = await seedMerchant({ slug: `hitpay-alert-${n}`, owner_id: data.session!.user.id })
  await svc().from('merchant_secrets').upsert({
    merchant_id: merchantId, tg_token: 'TG', tg_chat_id: '1',
    hitpay_api_key: 'k', hitpay_webhook_id: 'wh', hitpay_webhook_token: `tok_${crypto.randomUUID().replace(/-/g, '')}`,
  })
  await svc().from('merchants').update({ hitpay_connected: true }).eq('id', merchantId)
  const { data: o } = await svc().from('orders').insert({
    merchant_id: merchantId, order_number: `HA-${crypto.randomUUID().slice(0, 8)}`, status,
    customer_name: 'Ah Meng', customer_wa: '60123456789', total: 10, currency: 'MYR', items: [],
  }).select('id, order_number').single()
  return { merchantId, orderId: o!.id as string, orderNumber: o!.order_number as string }
}

const notify = (merchantId: string, orderNumber: string) => app.request('/api/notify/order', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merchantId, orderNumber }),
})

describe('HitPay merchant alerts', () => {
  it('holds the merchant alert when the order is placed', async () => {
    const s = await connectedShopWithOrder()
    const res = await notify(s.merchantId, s.orderNumber)
    expect(res.status).toBe(200)
    expect(telegrams).toEqual([])
    expect(emails.filter(e => e.subject.includes('New order'))).toEqual([])
  })

  it('sends the alert once, with the paid banner, after the payment', async () => {
    const s = await connectedShopWithOrder()
    await notify(s.merchantId, s.orderNumber)
    await app.request(`/api/orders/${s.orderId}/hitpay-qr`, { method: 'POST' })
    paid.add(s.orderId)
    await app.request(`/api/orders/${s.orderId}/hitpay-status`)
    await app.request(`/api/orders/${s.orderId}/hitpay-status`)
    expect(telegrams).toHaveLength(1)
    expect(telegrams[0].startsWith('✅ Paid by DuitNow (HitPay)')).toBe(true)
    const merchantMails = emails.filter(e => e.subject.includes('New order'))
    expect(merchantMails).toHaveLength(1)
    expect(merchantMails[0].subject.startsWith('Paid: ')).toBe(true)
  })

  it('sends the refund alert for a payment on a cancelled order', async () => {
    const s = await connectedShopWithOrder()
    await app.request(`/api/orders/${s.orderId}/hitpay-qr`, { method: 'POST' })
    await svc().from('orders').update({ status: 'cancelled' }).eq('id', s.orderId)
    paid.add(s.orderId)
    await app.request(`/api/orders/${s.orderId}/hitpay-status`)
    expect(telegrams[0]).toContain('Refund them in your HitPay dashboard')
    expect(emails.some(e => e.subject.startsWith('Refund needed: '))).toBe(true)
  })

  it('does not hold the alert for a shop that is not connected', async () => {
    const s = await connectedShopWithOrder('new')
    await svc().from('merchants').update({ hitpay_connected: false }).eq('id', s.merchantId)
    await notify(s.merchantId, s.orderNumber)
    expect(telegrams).toHaveLength(1)
  })
})
```

- [ ] **Step 7: Run it and see it fail**

Run: `pnpm --filter @bitetime/backend test:db -- tests/api/hitpay-alerts.test.ts`
Expected: FAIL — the first test gets a Telegram message at placement.

- [ ] **Step 8: Add `merchantAlertHeld` to `hitpayPaymentDb.ts`**

```ts
/**
 * True when the merchant's "new order" alert must wait for the payment: the shop takes HitPay and
 * this order is still unpaid. The alert then goes out from `confirmHitpayPayment`, after the
 * commit, with the paid banner (spec 2026-10-02 → Notifications).
 */
export async function merchantAlertHeld(merchantId: string, orderNumber: string): Promise<boolean> {
  const rows = await sql<{ held: boolean }[]>`
    select (m.hitpay_connected and o.status = 'pending_payment') as held
    from orders o join merchants m on m.id = o.merchant_id
    where o.merchant_id = ${merchantId} and o.order_number = ${orderNumber}
  `
  return rows[0]?.held === true
}
```

- [ ] **Step 9: Wire the hold and the alert in `app.ts`.** Add `merchantAlertHeld` to the `./hitpayPaymentDb.js` import and `PAID_BANNER, PAID_AFTER_CANCEL_BANNER` to the `./hitpayPayment.js` import. In `/api/notify/order`, replace the `Promise.all` block with:

```ts
  // A HitPay shop's unpaid order: the merchant hears about it after the payment, not now
  // (spec 2026-10-02). A failed lookup falls back to sending — a duplicate alert is cheaper than
  // a lost one. The customer's receipt is not held.
  const held = await merchantAlertHeld(merchantId, orderNumber).catch(() => false)
  const skipped = { ok: true, skipped: true } as const
  const [telegram, email, merchantEmail] = await Promise.all([
    held ? Promise.resolve(skipped) : notifyOrderPlaced(admin, notifyDeps.telegram, { merchantId, orderNumber }),
    emailOrderConfirmation(admin, admin, notifyDeps.email, { merchantId, orderNumber, lang }, emailCfg),
    held ? Promise.resolve(skipped) : emailMerchantOrder(admin, admin, notifyDeps.email, { merchantId, orderNumber }, emailCfg),
  ])
```

> The 404 check below that block compares `telegram.error`; a `skipped` result has no `error`, so the check stays correct. If TypeScript complains about the union, type `skipped` as `NotifyResult` (import it from `./orderNotice.js`).

Then replace the body of `hitpayAlertDeps` (from Task 5) with the real alert. `hitpayAlertDeps` is defined above `notifyDeps` in the file, so the function reads `notifyDeps` at call time:

```ts
export const hitpayAlertDeps: { alert: (a: PaymentAlert) => Promise<void> } = {
  // The same two merchant arms as the order fan-out, with a banner. The email's one-shot claim
  // (`merchant_emailed_at`) was never taken at placement — the alert was held — so it is free
  // here, and it is what makes a repeated confirmation send one email.
  alert: async (a) => {
    const banner = a.outcome === 'paid' ? PAID_BANNER : PAID_AFTER_CANCEL_BANNER
    const emailCfg = { frontendUrl: env.frontendUrl, emailFrom: env.emailFrom, qrBaseUrl: env.supabaseUrl }
    const input = { merchantId: a.merchantId, orderNumber: a.orderNumber }
    await Promise.all([
      notifyOrderPlaced(admin, notifyDeps.telegram, input, banner),
      emailMerchantOrder(admin, admin, notifyDeps.email, input, emailCfg, banner),
    ])
  },
}
```

- [ ] **Step 10: Run all backend suites**

Run: `pnpm --filter @bitetime/backend test && pnpm --filter @bitetime/backend test:db`
Expected: PASS (all suites, including `notifyOrder.test.ts`, which must not change behaviour for a shop with no HitPay).

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/notify.ts apps/backend/src/orderEmails.ts apps/backend/src/hitpayPaymentDb.ts apps/backend/src/app.ts \
  apps/backend/tests/unit/notify.test.ts apps/backend/tests/unit/merchantOrderEmail.test.ts apps/backend/tests/api/hitpay-alerts.test.ts
git commit -m "feat(hitpay): alert the merchant after the payment, not at the order

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

---

### Task 7: Merchant UI — the connect card

**Files:**
- Modify: `apps/frontend/src/store.ts` (append after `upsertMerchantSecret`)
- Create: `apps/frontend/src/merchant/HitpayCard.tsx`
- Modify: `apps/frontend/src/merchant/ShopSettings.tsx` (`PaymentTab`)

**Interfaces:**
- Consumes: routes from Task 4.
- Produces (in `store.ts`): `type HitpayConnection = { connected: boolean; keyLast4: string | null }`, `fetchHitpayConnection(merchantId: string): Promise<Result<HitpayConnection>>`, `connectHitpay(merchantId: string, apiKey: string): Promise<Result<HitpayConnection>>`, `disconnectHitpay(merchantId: string): Promise<Result<HitpayConnection>>`.

UI is verified by running the app (CLAUDE.md), so this task has no component test.

- [ ] **Step 1: Add the store functions**

```ts
// ── HitPay: the shop's own account (spec 2026-10-02) ──────────────────────────────────────────
// The key goes up once and never comes back: every answer carries `keyLast4` only.
export type HitpayConnection = { connected: boolean; keyLast4: string | null }

export async function fetchHitpayConnection(merchantId: string): Promise<Result<HitpayConnection>> {
  return apiGet<HitpayConnection>(`/api/merchants/${merchantId}/hitpay`, { auth: 'required' })
}

export async function connectHitpay(merchantId: string, apiKey: string): Promise<Result<HitpayConnection>> {
  return apiSend<HitpayConnection>(`/api/merchants/${merchantId}/hitpay`, 'PUT', { apiKey }, { auth: 'required' })
}

export async function disconnectHitpay(merchantId: string): Promise<Result<HitpayConnection>> {
  return apiSend<HitpayConnection>(`/api/merchants/${merchantId}/hitpay`, 'DELETE', undefined, { auth: 'required' })
}
```

- [ ] **Step 2: Write `HitpayCard.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { connectHitpay, disconnectHitpay, fetchHitpayConnection, type HitpayConnection } from '../store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const HITPAY_KEYS_URL = 'https://dashboard.hit-pay.com/'

/**
 * Settings → Payment → "DuitNow by HitPay" (spec 2026-10-02). The merchant pastes ONE key; the
 * backend registers the webhook with it. Outside the Payment form on purpose: connecting is its
 * own action with its own answer from HitPay, not a field that waits for "Save payment".
 */
export default function HitpayCard({ className }: { className?: string }) {
  const { t, merchant, refreshMerchant } = useSession()
  const [conn, setConn] = useState<HitpayConnection | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const myr = (merchant?.currency ?? 'MYR') === 'MYR'

  useEffect(() => {
    if (!merchant?.id) return
    fetchHitpayConnection(merchant.id).then(r => { if (r.ok) setConn(r.data) })
  }, [merchant?.id])

  const ERRORS: Record<string, string> = {
    invalid_key: t('HitPay did not accept this key. Copy it again from your HitPay dashboard.', 'HitPay 不接受此密钥。请从 HitPay 后台重新复制。'),
    gateway_unavailable: t('We could not reach HitPay. Try again in a minute.', '无法连接 HitPay。请稍后再试。'),
    currency_not_supported: t('DuitNow works only for a shop in MYR.', 'DuitNow 仅适用于以马币（MYR）结算的商店。'),
    hitpay_not_configured: t('HitPay is not available yet.', 'HitPay 暂不可用。'),
  }

  async function connect() {
    if (!merchant || !key.trim()) return
    setBusy(true)
    const r = await connectHitpay(merchant.id, key.trim())
    setBusy(false)
    if (!r.ok) { toast.error(ERRORS[r.error.code ?? ''] ?? t('Could not connect HitPay', '无法连接 HitPay')); return }
    setConn(r.data)
    setKey('')
    await refreshMerchant()
    toast.success(t('HitPay connected', 'HitPay 已连接'))
  }

  async function disconnect() {
    if (!merchant) return
    setBusy(true)
    const r = await disconnectHitpay(merchant.id)
    setBusy(false)
    if (!r.ok) { toast.error(t('Could not disconnect HitPay', '无法断开 HitPay')); return }
    setConn(r.data)
    await refreshMerchant()
    toast.success(t('HitPay disconnected', 'HitPay 已断开'))
  }

  return (
    <div className={className}>
      <h3 className="text-[15px] font-semibold text-foreground mb-2">{t('DuitNow by HitPay', 'DuitNow（HitPay）')}</h3>
      <p className="text-[13px] text-muted-foreground leading-[1.5] mb-3">
        {t('Customers pay each order with a DuitNow QR for the exact amount. The order is marked paid by itself. The money goes to your HitPay account. TinyOrder takes no commission.',
           '顾客用金额准确的 DuitNow 二维码为每笔订单付款，订单会自动标记为已付款。款项直接进入您的 HitPay 账户，TinyOrder 不收佣金。')}
      </p>
      {!myr ? (
        <p className="text-[13px] text-muted-foreground">{ERRORS.currency_not_supported}</p>
      ) : conn?.connected ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[14px] text-foreground">
            {t(`Connected · key ending ${conn.keyLast4}`, `已连接 · 密钥尾号 ${conn.keyLast4}`)}
          </span>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={disconnect}>
            {t('Disconnect', '断开')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-[6px] max-w-[420px]">
          <Label htmlFor="hitpay-key">{t('HitPay API key', 'HitPay API 密钥')}</Label>
          <Input id="hitpay-key" type="password" autoComplete="off" value={key}
            onChange={e => setKey(e.target.value)} variant="compact" />
          <p className="text-[12px] text-muted-foreground leading-[1.5]">
            {t('In HitPay, open Settings → Payment Gateway → API Keys, and copy the API key.',
               '在 HitPay 中打开 设置 → 支付网关 → API 密钥，复制 API 密钥。')}{' '}
            <a href={HITPAY_KEYS_URL} target="_blank" rel="noreferrer" className="underline">
              {t('Open HitPay', '打开 HitPay')}
            </a>
          </p>
          <div>
            <Button type="button" size="sm" disabled={busy || !key.trim()} onClick={connect}>
              {busy ? t('Connecting…', '连接中…') : t('Connect HitPay', '连接 HitPay')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
```

> Check the import paths for `toast`, `Button`, `Input` and `Label` against the top of `ShopSettings.tsx`, and use the same ones.

- [ ] **Step 3: Mount it in `PaymentTab`.** In `ShopSettings.tsx`, import `HitpayCard from './HitpayCard'`. Change the `return (` of `PaymentTab` so the card sits above the form, with the same card class:

```tsx
  return (
    <>
      <HitpayCard className={CARD} />
      <form onSubmit={save}>
```

and close with `</form>\n    </>`. Change the heading of the static payment card from `t('Payment', '付款')` to:

```tsx
{merchant!.hitpay_connected ? t('Backup payment info', '备用付款信息') : t('Payment', '付款')}
```

and add one line under that heading when connected:

```tsx
{merchant!.hitpay_connected && (
  <p className="text-[12px] text-muted-foreground leading-[1.5] mb-2">
    {t('Customers see this only when HitPay cannot make a QR.', '仅在 HitPay 无法生成二维码时向顾客显示。')}
  </p>
)}
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/store.ts apps/frontend/src/merchant/HitpayCard.tsx apps/frontend/src/merchant/ShopSettings.tsx
git commit -m "feat(hitpay): add the HitPay connect card to the payment settings

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

---

### Task 8: Customer UI — the QR panel

**Files:**
- Modify: `apps/frontend/src/store.ts` (append)
- Create: `apps/frontend/src/hitpayQr.ts`
- Test: `apps/frontend/src/hitpayQr.test.ts`
- Create: `apps/frontend/src/store/HitpayQrPanel.tsx`
- Modify: `apps/frontend/src/store/Storefront.tsx` (`SuccessState`, `setSuccess`, the payment block at line ~1045)
- Modify: `apps/frontend/src/store/OrderHistory.tsx` (`PaymentProofSection`, `Instructions`, the mount at line ~277)

**Interfaces:**
- Consumes: routes from Task 5.
- Produces:
  - In `store.ts`: `type HitpayQr = { status: 'live'; qrPayload: string; amount: string; currency: string; expiresAt: string } | { status: 'completed' }`, `type HitpayStatus = { payment: 'none' | 'pending' | 'completed' | 'expired' | 'failed'; orderStatus: string; expiresAt: string | null }`, `requestHitpayQr(orderId: string): Promise<Result<HitpayQr>>`, `fetchHitpayStatus(orderId: string): Promise<Result<HitpayStatus>>`
  - In `hitpayQr.ts`: `POLL_MS = 3000`, `secondsLeft(expiresAt: string, now: number): number`, `formatCountdown(seconds: number): string`, `paysWithHitpay(merchant: { hitpay_connected?: boolean | null }, status: string | null | undefined): boolean`, `isPaid(s: HitpayStatus): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// src/hitpayQr.test.ts
import { describe, it, expect } from 'vitest'
import { secondsLeft, formatCountdown, paysWithHitpay, isPaid, POLL_MS } from './hitpayQr'

describe('hitpayQr', () => {
  it('counts down to zero and never below', () => {
    const now = Date.parse('2026-10-02T10:00:00Z')
    expect(secondsLeft('2026-10-02T10:15:00Z', now)).toBe(900)
    expect(secondsLeft('2026-10-02T10:00:00.400Z', now)).toBe(1)
    expect(secondsLeft('2026-10-02T09:59:00Z', now)).toBe(0)
  })
  it('formats m:ss', () => {
    expect(formatCountdown(900)).toBe('15:00')
    expect(formatCountdown(61)).toBe('1:01')
    expect(formatCountdown(0)).toBe('0:00')
  })
  it('pays with HitPay only for a connected shop and an unpaid order', () => {
    expect(paysWithHitpay({ hitpay_connected: true }, 'pending_payment')).toBe(true)
    expect(paysWithHitpay({ hitpay_connected: true }, 'new')).toBe(false)
    expect(paysWithHitpay({ hitpay_connected: false }, 'pending_payment')).toBe(false)
    expect(paysWithHitpay({}, 'pending_payment')).toBe(false)
  })
  it('reads paid from the payment row or from an order that moved on', () => {
    expect(isPaid({ payment: 'completed', orderStatus: 'new', expiresAt: null })).toBe(true)
    expect(isPaid({ payment: 'pending', orderStatus: 'new', expiresAt: null })).toBe(true)
    expect(isPaid({ payment: 'pending', orderStatus: 'pending_payment', expiresAt: null })).toBe(false)
    expect(isPaid({ payment: 'expired', orderStatus: 'pending_payment', expiresAt: null })).toBe(false)
  })
  it('polls every 3 seconds', () => {
    expect(POLL_MS).toBe(3000)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @bitetime/frontend exec vitest run src/hitpayQr.test.ts`
Expected: FAIL — `Cannot find module './hitpayQr'`.

- [ ] **Step 3: Add the store functions** (append to `store.ts`, after the Task 7 block):

```ts
export type HitpayQr =
  | { status: 'live'; qrPayload: string; amount: string; currency: string; expiresAt: string }
  | { status: 'completed' }

export type HitpayStatus = {
  payment: 'none' | 'pending' | 'completed' | 'expired' | 'failed'
  orderStatus: string
  expiresAt: string | null
}

/** No auth: addressed by the order UUID, like the payment-proof upload. A guest has no token. */
export async function requestHitpayQr(orderId: string): Promise<Result<HitpayQr>> {
  return apiSend<HitpayQr>(`/api/orders/${orderId}/hitpay-qr`, 'POST', {})
}

export async function fetchHitpayStatus(orderId: string): Promise<Result<HitpayStatus>> {
  return apiGet<HitpayStatus>(`/api/orders/${orderId}/hitpay-status`)
}
```

- [ ] **Step 4: Write `hitpayQr.ts`**

```ts
import type { HitpayStatus } from './store'

/** How often the open QR asks whether it was paid. The webhook covers a hidden tab. */
export const POLL_MS = 3000

export function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** The dynamic QR replaces the static instructions only for a connected shop's unpaid order. */
export function paysWithHitpay(merchant: { hitpay_connected?: boolean | null }, status: string | null | undefined): boolean {
  return merchant.hitpay_connected === true && status === 'pending_payment'
}

/**
 * Paid when the payment row says so, OR when the order already left `pending_payment` — the
 * merchant may have marked it by hand, and a QR still asking for money then is wrong.
 */
export function isPaid(s: HitpayStatus): boolean {
  return s.payment === 'completed' || s.orderStatus !== 'pending_payment'
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @bitetime/frontend exec vitest run src/hitpayQr.test.ts`
Expected: PASS.

- [ ] **Step 6: Write `HitpayQrPanel.tsx`**

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { useSession } from '../SessionContext'
import { fetchHitpayStatus, requestHitpayQr } from '../store'
import { formatCountdown, isPaid, POLL_MS, secondsLeft } from '../hitpayQr'
import { formatMoney } from '../currency'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type View =
  | { kind: 'loading' }
  | { kind: 'live'; qrPayload: string; amount: string; currency: string; expiresAt: string }
  | { kind: 'expired' }
  | { kind: 'paid' }
  | { kind: 'fallback' }

/**
 * The customer pays this order with the shop's own HitPay DuitNow QR (spec 2026-10-02).
 *
 * The QR holds the exact total, so the backend can confirm the payment by itself: this panel polls
 * while the QR is on screen and the tab is visible, and the HitPay webhook covers the rest. When
 * HitPay cannot make a QR, `fallback` — the static instructions and the proof upload — takes its
 * place, so a customer is never left with no way to pay.
 *
 * "Save QR" is not decoration: most customers order on a phone and cannot scan the screen they
 * are holding. They save the image and open it in their banking app.
 */
export default function HitpayQrPanel({
  orderId,
  onPaid,
  fallback,
  className,
}: {
  orderId: string
  onPaid: () => void
  fallback: ReactNode
  className?: string
}) {
  const { t } = useSession()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onPaidRef = useRef(onPaid)
  onPaidRef.current = onPaid

  async function load() {
    setView({ kind: 'loading' })
    const r = await requestHitpayQr(orderId)
    if (!r.ok) { setView({ kind: 'fallback' }); return }
    if (r.data.status === 'completed') { setView({ kind: 'paid' }); onPaidRef.current(); return }
    setView({ kind: 'live', ...r.data })
  }

  useEffect(() => { load() }, [orderId]) // eslint-disable-line react-hooks/exhaustive-deps

  // One timer drives both the countdown and the poll. A hidden tab neither polls nor ticks.
  useEffect(() => {
    if (view.kind !== 'live') return
    let ticks = 0
    const id = setInterval(async () => {
      if (document.hidden) return
      setNow(Date.now())
      ticks += 1
      if (ticks % (POLL_MS / 1000) !== 0) return
      const r = await fetchHitpayStatus(orderId)
      if (!r.ok) return
      if (isPaid(r.data)) { setView({ kind: 'paid' }); onPaidRef.current() }
    }, 1000)
    return () => clearInterval(id)
  }, [view.kind, orderId])

  useEffect(() => {
    if (view.kind === 'live' && secondsLeft(view.expiresAt, now) === 0) setView({ kind: 'expired' })
  }, [view, now])

  function save() {
    const canvas = canvasRef.current
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `duitnow-${orderId.slice(0, 8)}.png`
    a.click()
  }

  if (view.kind === 'fallback') return <>{fallback}</>

  return (
    <div className={cn('text-center px-[14px] py-[12px] bg-card border-[0.5px] border-border rounded-md', className)}>
      <div className="font-semibold text-primary mb-2 text-[13px]">{t('Pay with DuitNow', '使用 DuitNow 付款')}</div>
      {view.kind === 'loading' && (
        <div className="mx-auto w-[220px] h-[220px] rounded-md bg-muted animate-pulse" aria-label={t('Loading QR', '正在加载二维码')} />
      )}
      {view.kind === 'live' && (
        <>
          <div className="mx-auto w-fit bg-white p-2 rounded-md">
            <QRCodeCanvas ref={canvasRef} value={view.qrPayload} size={220} marginSize={2} />
          </div>
          <p className="mt-2 text-[15px] font-medium text-foreground">{formatMoney(Number(view.amount), view.currency)}</p>
          <p className="text-[12px] text-muted-foreground tabular-nums">
            {t(`Valid for ${formatCountdown(secondsLeft(view.expiresAt, now))}`, `有效时间 ${formatCountdown(secondsLeft(view.expiresAt, now))}`)}
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={save}>
            {t('Save QR', '保存二维码')}
          </Button>
          <p className="mt-2 text-[12px] text-muted-foreground leading-[1.5]">
            {t('Open your banking app and scan this QR, or upload the saved image. This page updates by itself when you pay.',
               '打开您的银行应用扫描此二维码，或上传已保存的图片。付款后此页面会自动更新。')}
          </p>
        </>
      )}
      {view.kind === 'expired' && (
        <>
          <p className="text-[14px] text-foreground mb-2">{t('This QR expired.', '此二维码已过期。')}</p>
          <Button type="button" size="sm" onClick={load}>{t('Get a new QR', '获取新的二维码')}</Button>
        </>
      )}
      {view.kind === 'paid' && (
        <p className="text-[14px] font-medium text-foreground">{t('Payment received. Thank you!', '已收到付款，谢谢！')}</p>
      )}
    </div>
  )
}
```

> Check two facts before you run it: (1) the name of the money formatter that `Storefront.tsx` imports (it uses `formatMoney(value, currency)`), and use the same import path; (2) that the installed `qrcode.react` v4 `QRCodeCanvas` accepts `ref` and `marginSize` (read `node_modules/qrcode.react/lib/index.d.ts`). If `marginSize` is absent, remove that prop.

- [ ] **Step 7: Mount the panel on the order-placed screen.** In `Storefront.tsx`:

1. Import `HitpayQrPanel from './HitpayQrPanel'` and `{ paysWithHitpay } from '../hitpayQr'`.
2. Add `payWithHitpay: boolean` to the `SuccessState` type, and set it in `setSuccess({...})`: `payWithHitpay: paysWithHitpay(merchant, result.data.status),`. It is fixed at the time of the order, so the panel stays mounted after the payment and shows "Payment received".
3. Replace the `<PaymentInstructions …>` block at line ~1045 with:

```tsx
            {success.payWithHitpay ? (
              <HitpayQrPanel
                orderId={success.orderId}
                className="max-w-[360px] mx-auto mb-4"
                onPaid={() => setSuccess(s => (s ? { ...s, status: 'new' } : s))}
                fallback={
                  <PaymentInstructions merchant={merchant} className="max-w-[360px] mx-auto mb-4">
                    <PaymentProofUpload orderId={success.orderId} />
                  </PaymentInstructions>
                }
              />
            ) : (
              <PaymentInstructions merchant={merchant} className="max-w-[360px] mx-auto mb-4">
                <PaymentProofUpload orderId={success.orderId} />
              </PaymentInstructions>
            )}
```

`status: 'new'` makes `canIssueInvoice(success.status)` true, so the invoice button replaces the sentence after the payment.

- [ ] **Step 8: Mount the panel in order history.** In `OrderHistory.tsx`:

1. Import `HitpayQrPanel from './HitpayQrPanel'` and `{ paysWithHitpay } from '../hitpayQr'`.
2. Add the prop `onPaid: () => void` to `PaymentProofSection` and pass it from the mount at line ~277: `onPaid={() => patchLoadedOrder(o.id!, { status: 'new' })}`.
3. At the top of the `if (!hasProof) {` branch in `PaymentProofSection`, before the existing `return`, add:

```tsx
    // A HitPay shop's order is paid with its dynamic QR while unpaid, and asks for nothing after:
    // the backend confirmed the money, so a proof upload would be a question with no purpose.
    if (merchant.hitpay_connected) {
      if (!order.id || !paysWithHitpay(merchant, order.status)) return null
      return (
        <div className="mt-3">
          <HitpayQrPanel
            orderId={order.id}
            onPaid={onPaid}
            fallback={
              <>
                <PaymentInstructions merchant={merchant} className="mb-2.5" />
                <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-1.5">
                  {t('Payment proof', '付款凭证')}
                </div>
                <PaymentProofUpload orderId={order.id} onUploaded={saved => { setJustUploaded(true); onUploaded(saved) }} />
              </>
            }
          />
        </div>
      )
    }
```

4. In `Instructions`, add as the first line: `if (merchant.hitpay_connected) return null` — the static info of a HitPay shop is a fallback, not a second way to pay.

- [ ] **Step 9: Typecheck, lint, test**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/frontend/src/store.ts apps/frontend/src/hitpayQr.ts apps/frontend/src/hitpayQr.test.ts \
  apps/frontend/src/store/HitpayQrPanel.tsx apps/frontend/src/store/Storefront.tsx apps/frontend/src/store/OrderHistory.tsx
git commit -m "feat(hitpay): show the customer a DuitNow QR for the exact order total

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md` (a new `### Customer payments (HitPay DuitNow QR)` section after `### Support chat`)
- Modify: `CONTEXT.md` (one glossary entry next to the payment proof entry)

- [ ] **Step 1: Add the CLAUDE.md section**

```markdown
### Customer payments (HitPay DuitNow QR)

A shop can connect its **own** HitPay account (Settings → Payment). The customer then pays each order with a DuitNow QR for the exact total, and the order moves from `pending_payment` to `new` by itself. TinyOrder never holds money: the key is the merchant's, the money settles to the merchant, and Stripe stays subscription-only. Spec: `docs/superpowers/specs/2026-10-02-hitpay-duitnow-qr-design.md`.

Split: `hitpay.ts` (adapter, key as a parameter), `hitpayPayment.ts` (pure rules), `hitpayPaymentDb.ts` (SQL), `hitpayConfirm.ts` (the one confirmation function). `hitpayDeps` and `hitpayAlertDeps` on `app.ts` are the test seams.

Rules that are easy to break:

- **The webhook body is never trusted.** HitPay's API-registered webhooks carry no salt we can read, so the body is a hint: the backend reads `payment_request_id`, then asks `GET /v1/payment-requests/{id}` with the key of the shop that owns the row. Do not "optimise" this by reading `status` from the body.
- **No route returns the key.** The browser gets `keyLast4`. `GET /api/merchants/:id/secret` returns only the Telegram columns.
- **One live QR for each order** is a partial unique index (`order_payments_one_pending`), and a QR whose time ran out is checked with HitPay before a new one is made — a customer who paid at 14:59 must not get a second QR that can take a second payment.
- **The merchant alert waits for the payment.** `/api/notify/order` skips the merchant arms for a connected shop's unpaid order; `hitpayAlertDeps.alert` sends them after the commit, with a banner. The email's `merchant_emailed_at` claim makes a repeated confirmation send one email.
- **The webhook answers 200 for every ignored signal.** Only a database failure answers 500.
- **Local work needs the sandbox.** Set `HITPAY_API_BASE=https://api.sandbox.hit-pay.com/v1` and `BACKEND_PUBLIC_URL` to a public HTTPS tunnel to `:8787` — HitPay rejects localhost. Without a tunnel the browser poll still confirms payments; only the webhook path is missing.
```

- [ ] **Step 2: Add the CONTEXT.md entry** next to the payment proof entry:

```markdown
### Dynamic payment QR

A DuitNow QR that the shop's own HitPay account makes for **one** order, for its exact total, valid for 15 minutes. Paying it moves the order out of `pending_payment` by itself, because the backend confirms the payment with HitPay. Not the shop's **static payment QR** (`merchants.payment_qr`), which is one image for every order and needs a **payment proof** before anything moves. A shop with HitPay connected shows its static QR only when HitPay cannot make a dynamic one. _Avoid_: "HitPay QR" for the static image.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CONTEXT.md
git commit -m "docs(hitpay): document the dynamic DuitNow QR and its rules

Claude-Session: https://claude.ai/code/session_014gJetrpDgrys6eAJiZxdNB"
```

---

### Task 10: Run and verify

**Files:** none (verification only).

- [ ] **Step 1: Full checks**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @bitetime/backend test:db && pnpm build`
Expected: all PASS.

- [ ] **Step 2: Drive the flow with the `verify` skill.** Use the HitPay sandbox if the human gave a key in Task 0; if not, start the backend with a fake HitPay base and check only the fallback path. Steps:
  1. Sign in as a merchant on a MYR shop. Settings → Payment → paste the sandbox key → "Connect HitPay". Expected: "Connected · key ending ….".
  2. Open the storefront in a second (visible) tab and place an order. Expected: the order-placed screen shows a QR, the amount, a countdown and "Save QR". "Save QR" downloads a PNG.
  3. Pay the sandbox QR. Expected: within about 3 s the panel shows "Payment received" and the invoice button appears. The dashboard shows the order as New, and its log shows "Payment received by DuitNow (HitPay)".
  4. Expected: one merchant Telegram message and one merchant email, both with the paid banner, and none at the time of the order.
  5. Disconnect HitPay, set `HITPAY_API_BASE` to an unreachable URL, connect fails with "We could not reach HitPay". Place an order on a shop with `hitpay_connected` forced true in the local DB. Expected: the static instructions and the proof upload show.

- [ ] **Step 3: Report.** State which steps ran against the sandbox and which ran against a fake, and state that production still needs (a) the migration pushed by a human, (b) `HITPAY_API_BASE` and `BACKEND_PUBLIC_URL` set on Railway.
