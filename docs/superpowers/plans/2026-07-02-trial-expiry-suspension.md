# Trial Expiry & Suspension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cardless 7-day basic-plan trial started by superadmin approval, a persistent dashboard countdown banner (urgent at ≤72h) with a Stripe billing-portal CTA, a 72-hour reminder email via Resend, automatic suspension at trial end via Stripe's `missing_payment_method: 'cancel'`, and a pay-to-reactivate suspended dashboard with read-only orders.

**Architecture:** Two new pure seams carry all the logic: `apps/backend/src/billingLifecycle.ts` (trial-grant guard + reminder-email builder, unit-tested like `notify.ts`) and `apps/frontend/src/merchant/billingBanner.ts` (billing row + clock → banner state, unit-tested like `pricing.ts`). I/O stays thin at the edges: two new Hono endpoints (`/api/admin/approve-merchant`, `/api/billing/portal`), one new webhook case (`customer.subscription.trial_will_end`), a fetch-based Resend adapter, and thin React components. Stripe remains the single source of billing truth — suspension is driven by the existing `customer.subscription.deleted → suspended` webhook path, which the trial's `cancel` end-behavior triggers automatically. No cron.

**Tech Stack:** Hono + Stripe SDK v17 + Supabase service-role (backend), React 19 + Vite (frontend), Vitest, Resend REST API (plain fetch, no SDK), one SQL migration.

**Reference:** PRD is GitHub issue #28 (`gh issue view 28`).

## Global Constraints

- Every user-facing string is `t(englishString, chineseString)` — no i18n library (from CLAUDE.md).
- Backend relative imports keep `.js` specifiers (NodeNext resolution); frontend imports are extensionless (bundler resolution).
- Trial is **basic plan only**, **7 days**, granted **only** by the approval endpoint — never by Checkout.
- The trial banner is **not dismissible**.
- Urgent threshold is exactly **72 hours** (`msLeft <= 72 * 3_600_000`).
- All money/plan amounts come from Stripe Prices; never hardcode amounts.
- Run all commands from the repo root.
- Commit messages follow the existing `feat(scope): …` convention.

---

### Task 1: `merchants.billing_region` migration + signup records the region

The approval endpoint must create a subscription with a region-correct Stripe Price, but basic signup no longer goes through Checkout (which is where the region was previously passed). Record the region the signup page displayed on the merchant row.

**Files:**
- Create: `apps/backend/supabase/migrations/20260702090000_merchant_billing_region.sql`
- Modify: `apps/frontend/src/store.ts:90` (`createMerchant`)
- Modify: `apps/frontend/src/merchant/SignupScreen.tsx:56`

**Interfaces:**
- Produces: `merchants.billing_region text not null default 'US'` column; `createMerchant({ name, plan?, billing?, region? })` accepting a `region` string.

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260702090000_merchant_billing_region.sql`:

```sql
-- Billing region chosen at signup (drives which Stripe Price the trial
-- subscription uses). Recorded on the merchant because basic-plan signup no
-- longer goes through Checkout, so approval needs it server-side.
alter table public.merchants
  add column if not exists billing_region text not null default 'US';
```

- [ ] **Step 2: Apply it locally**

Run: `pnpm --filter @bitetime/backend db:migrate`
Expected: migration `20260702090000` applied. (Requires `supabase start` to be running; if it isn't, start it first.)

- [ ] **Step 3: Record the region at signup**

In `apps/frontend/src/store.ts`, change the `createMerchant` signature and insert (currently lines 90–104):

```ts
export async function createMerchant({ name, plan = 'basic', billing = 'monthly', region = 'US' }: { name: string; plan?: string; billing?: string; region?: string }) {
  const user = await getCurrentUser()
  if (!user) throw new Error('Not signed in')
  const taken = await listTakenSlugs()
  const slug = await resolveSlug(name, { taken, id: user.id })
  const { data, error } = await supabase
    .from('merchants')
    .insert({
      name, slug, order_prefix: orderPrefix(slug), owner_id: user.id, status: 'pending',
      plan, billing_cycle: billing, billing_region: region,
    })
    .select().single()
  if (error) throw error
  return data
}
```

In `apps/frontend/src/merchant/SignupScreen.tsx` line 56, pass the displayed region:

```ts
      await createMerchant({ name, plan, billing, region: pricing.region })
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/supabase/migrations/20260702090000_merchant_billing_region.sql apps/frontend/src/store.ts apps/frontend/src/merchant/SignupScreen.tsx
git commit -m "feat(billing): record signup billing region on the merchant"
```

---

### Task 2: Backend pure seam — `billingLifecycle.ts` (TDD)

The trial-grant guard and the reminder-email builder. Pure: rows in, decisions out. Prior art: `apps/backend/src/notify.ts` + `apps/backend/tests/unit/notify.test.ts`.

**Files:**
- Create: `apps/backend/src/billingLifecycle.ts`
- Test: `apps/backend/tests/unit/billingLifecycle.test.ts`

**Interfaces:**
- Produces: `canStartTrial(billing: BillingRow | null | undefined): boolean` and `buildTrialReminderEmail({ shopName, trialEndsAt, dashboardUrl }): { subject: string; text: string }`. Task 4 consumes `canStartTrial`; Task 7 consumes `buildTrialReminderEmail`.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/tests/unit/billingLifecycle.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { canStartTrial, buildTrialReminderEmail } from '../../src/billingLifecycle.js'

describe('canStartTrial', () => {
  it('allows a merchant with no billing row (never touched Stripe)', () => {
    expect(canStartTrial(null)).toBe(true)
    expect(canStartTrial(undefined)).toBe(true)
  })

  it('allows a merchant with a customer but no subscription (created, never subscribed)', () => {
    expect(canStartTrial({ stripe_customer_id: 'cus_1', stripe_subscription_id: null })).toBe(true)
  })

  it('refuses a merchant that has ever had a subscription — one trial ever', () => {
    expect(canStartTrial({ stripe_subscription_id: 'sub_1', status: 'canceled' })).toBe(false)
    expect(canStartTrial({ stripe_subscription_id: 'sub_1', status: 'trialing' })).toBe(false)
  })
})

describe('buildTrialReminderEmail', () => {
  const input = {
    shopName: 'Sunny Bakes',
    trialEndsAt: '2026-07-09T08:00:00.000Z',
    dashboardUrl: 'http://localhost:5173/merchant',
  }

  it('names the shop, links the dashboard, and states the deadline', () => {
    const { subject, text } = buildTrialReminderEmail(input)
    expect(subject).toContain('Sunny Bakes')
    expect(subject).toContain('3 days')
    expect(text).toContain('Sunny Bakes')
    expect(text).toContain('http://localhost:5173/merchant')
    expect(text).toContain('Jul 9, 2026')
  })

  it('warns that the shop is suspended if unpaid', () => {
    const { text } = buildTrialReminderEmail(input)
    expect(text.toLowerCase()).toContain('suspended')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bitetime/backend test`
Expected: FAIL — cannot resolve `../../src/billingLifecycle.js`.

- [ ] **Step 3: Implement the module**

Create `apps/backend/src/billingLifecycle.ts`:

```ts
// Pure billing-lifecycle decisions. No I/O: callers pass rows in; Stripe and
// Supabase effects stay in the route handlers (mirrors notify.ts).

export interface BillingRow {
  stripe_customer_id?: string | null
  stripe_subscription_id?: string | null
  status?: string | null
  trial_ends_at?: string | null
}

// One trial ever: a merchant that has ever had a subscription (trialing,
// canceled, anything) can't be granted another trial by approval.
export function canStartTrial(billing: BillingRow | null | undefined): boolean {
  return !billing?.stripe_subscription_id
}

export interface TrialReminderInput {
  shopName: string
  trialEndsAt: string // ISO timestamp
  dashboardUrl: string
}

// The 72-hour reminder sent when Stripe fires customer.subscription.trial_will_end.
export function buildTrialReminderEmail({ shopName, trialEndsAt, dashboardUrl }: TrialReminderInput) {
  const endsText =
    new Date(trialEndsAt).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) + ' UTC'
  const subject = `Your BiteTime trial for ${shopName} ends in 3 days`
  const text = `Hi,

The free trial for ${shopName} ends on ${endsText}.

Add a payment method before then to keep your shop open:
${dashboardUrl}

If no payment method is added, your shop will be suspended when the trial ends. You can reactivate it any time by subscribing.

— BiteTime`
  return { subject, text }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bitetime/backend test`
Expected: PASS (all suites, including existing notify/pricing/region).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/billingLifecycle.ts apps/backend/tests/unit/billingLifecycle.test.ts
git commit -m "feat(billing): pure billing-lifecycle seam — trial guard + reminder email"
```

---

### Task 3: Resend email adapter + env vars

Thin fetch adapter, same shape as `telegramSend` in `notify.ts`. No unit test (no logic) — typecheck gates it.

**Files:**
- Create: `apps/backend/src/email.ts`
- Modify: `apps/backend/src/env.ts:16-17` (append fields)
- Modify: `apps/backend/.env.example` (append vars)

**Interfaces:**
- Produces: `resendSend: EmailSend` where `type EmailSend = (to: string, subject: string, text: string) => Promise<void>`; `env.resendApiKey`, `env.emailFrom`. Task 7 consumes `resendSend`.

- [ ] **Step 1: Add env fields**

In `apps/backend/src/env.ts`, after the `supabaseServiceRoleKey` line, add:

```ts
  // Email (Resend). Optional: when the key is unset, sends are skipped with a
  // warning so local dev works without an email account.
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || 'BiteTime <onboarding@resend.dev>',
```

- [ ] **Step 2: Write the adapter**

Create `apps/backend/src/email.ts`:

```ts
// Server-side email via Resend's REST API — plain fetch, no SDK (mirrors the
// telegramSend adapter in notify.ts). Injected into handlers for testability.
import { env } from './env.js'

export type EmailSend = (to: string, subject: string, text: string) => Promise<void>

export const resendSend: EmailSend = async (to, subject, text) => {
  if (!env.resendApiKey) {
    console.warn(`RESEND_API_KEY unset — skipping email "${subject}" to ${to}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.resendApiKey}` },
    body: JSON.stringify({ from: env.emailFrom, to: [to], subject, text }),
  })
  if (!res.ok) throw new Error(`Resend send failed: ${res.status}`)
}
```

- [ ] **Step 3: Document the vars**

Append to `apps/backend/.env.example`:

```
# Resend (trial-reminder emails). Optional locally: unset = emails are skipped.
# Production needs a verified sending domain in Resend.
RESEND_API_KEY=re_...
EMAIL_FROM=BiteTime <billing@yourdomain.com>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/email.ts apps/backend/src/env.ts apps/backend/.env.example
git commit -m "feat(billing): Resend email adapter (optional in dev)"
```

---

### Task 4: Approval endpoint — `POST /api/admin/approve-merchant`

Approval is the abuse gate and the only place a trial is granted. It creates the Stripe customer + cardless trialing subscription and activates the shop. Pro shops are refused (they activate by paying through Checkout).

**Files:**
- Modify: `apps/backend/src/index.ts` (new route after `/api/checkout`, i.e. after line 104; extend imports at lines 6–8)

**Interfaces:**
- Consumes: `canStartTrial` (Task 2), `priceFor`/`isValidRegion`/`DEFAULT_REGION` (existing), `upsertBilling`/`setMerchantStatus`/`billingFromSubscription` (existing).
- Produces: `POST /api/admin/approve-merchant`, body `{ merchantId: string }`, header `Authorization: Bearer <supabase JWT>` (must resolve to a superadmin). Responses: `200 { ok: true, trial: boolean }`, `401/403/404`, `409` when not pending or when plan is pro. Task 5 consumes this endpoint.

- [ ] **Step 1: Extend imports**

In `apps/backend/src/index.ts`, add to the existing import block:

```ts
import { canStartTrial } from './billingLifecycle.js'
```

- [ ] **Step 2: Add the route**

Insert after the `/api/checkout` route (after line 104):

```ts
// ── Superadmin: approve a pending merchant → start its cardless trial ──────────
// Approval (not signup) is the abuse gate: signup alone never puts a live shop
// on the platform. The subscription is created with no payment method and
// cancels itself at trial end (missing_payment_method: 'cancel'), which drives
// the existing subscription.deleted → suspended webhook path. Trials are granted
// here and only here — Checkout never grants one.
app.post('/api/admin/approve-merchant', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const { data: callerProfile } = await admin
    .from('profiles').select('app_role').eq('id', user.id).maybeSingle()
  // TODO(P3): drop the email fallback once superadmin role is seeded (mirrors SessionContext).
  const isSuper = callerProfile?.app_role === 'superadmin' || user.email === 'bitetimeandco@gmail.com'
  if (!isSuper) return c.json({ error: 'Forbidden' }, 403)

  const { merchantId } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)

  const { data: merchant, error } = await admin
    .from('merchants')
    .select('id, name, status, plan, billing_cycle, billing_region, owner_id')
    .eq('id', merchantId)
    .maybeSingle()
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)
  if (merchant.status !== 'pending') return c.json({ error: 'Merchant is not pending' }, 409)
  if (merchant.plan === 'pro') {
    return c.json({ error: 'Pro shops activate via payment, not approval' }, 409)
  }

  const { data: billing } = await admin
    .from('merchant_billing').select('*').eq('merchant_id', merchant.id).maybeSingle()
  if (!canStartTrial(billing)) {
    // Had a subscription once already — approval re-activates, but never re-trials.
    await setMerchantStatus(merchant.id, 'active')
    return c.json({ ok: true, trial: false })
  }

  const { data: owner } = await admin
    .from('profiles').select('email').eq('id', merchant.owner_id).maybeSingle()

  let customerId = billing?.stripe_customer_id
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: owner?.email || undefined,
      name: merchant.name,
      metadata: { merchant_id: merchant.id },
    })
    customerId = customer.id
  }

  const plan = merchant.plan || 'basic'
  const cycle = merchant.billing_cycle || 'monthly'
  const region = isValidRegion(merchant.billing_region) ? merchant.billing_region : DEFAULT_REGION
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceFor(plan, cycle, region) }],
    trial_period_days: 7,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    metadata: { merchant_id: merchant.id, plan, billing: cycle, region },
  })
  await upsertBilling(merchant.id, billingFromSubscription(sub))
  await setMerchantStatus(merchant.id, 'active')
  return c.json({ ok: true, trial: true })
})
```

- [ ] **Step 3: Typecheck + full backend tests**

Run: `pnpm typecheck && pnpm --filter @bitetime/backend test`
Expected: clean, all PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/index.ts
git commit -m "feat(billing): approval endpoint creates the cardless trial subscription"
```

---

### Task 5: Admin UI approves through the backend

**Files:**
- Modify: `apps/frontend/src/store.ts` (add `approveMerchant` in the Billing section, after `fetchMyBilling`)
- Modify: `apps/frontend/src/admin/AdminMerchants.tsx:3,20-24,77-84`

**Interfaces:**
- Consumes: `POST /api/admin/approve-merchant` (Task 4).
- Produces: `approveMerchant(merchantId: string): Promise<{ ok: boolean; trial: boolean }>`.

- [ ] **Step 1: Add the store function**

In `apps/frontend/src/store.ts`, after `fetchMyBilling` (line 154), add:

```ts
// Superadmin approval goes through the backend: it creates the Stripe customer
// + cardless trialing subscription and flips the shop active in one step.
export async function approveMerchant(merchantId: string) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${API_URL}/api/admin/approve-merchant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ merchantId }),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || 'Approval failed')
  }
  return res.json()
}
```

- [ ] **Step 2: Wire the Approve button**

In `apps/frontend/src/admin/AdminMerchants.tsx`:

Change the store import (line 3):

```ts
import { fetchAllMerchants, setMerchantStatus, approveMerchant } from '../store'
```

Add a toast import after the existing imports:

```ts
import { toast } from 'sonner'
```

Add an `approve` helper next to `act` (after line 24):

```ts
  async function approve(id: string) {
    setBusy(id)
    try { await approveMerchant(id); await load() }
    catch (e) { toast.error(e instanceof Error ? e.message : t('Approval failed', '批准失败')) }
    finally { setBusy(null) }
  }
```

Change the pending-row Approve button's `onClick` (line 83):

```tsx
                        onClick={() => approve(m.id)}
```

(Reject/Suspend/Reactivate keep calling `act` — manual overrides stay direct.)

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/store.ts apps/frontend/src/admin/AdminMerchants.tsx
git commit -m "feat(admin): approve merchants through the backend trial endpoint"
```

---

### Task 6: Billing-portal endpoint + frontend helper

Where a trialing merchant adds a card and a past-due merchant fixes one.

**Files:**
- Modify: `apps/backend/src/index.ts` (new route after the approve route)
- Modify: `apps/frontend/src/store.ts` (add `openBillingPortal` after `approveMerchant`)

**Interfaces:**
- Produces: `POST /api/billing/portal` (merchant JWT → `{ url }`); `openBillingPortal(): Promise<string>` returning the portal URL. Task 10 consumes `openBillingPortal`.

- [ ] **Step 1: Add the backend route**

In `apps/backend/src/index.ts`, after the approve-merchant route:

```ts
// ── Stripe billing portal for the signed-in merchant ───────────────────────────
// Where a trialing merchant adds their card, and a past_due one updates it.
// Requires the portal to be enabled once in the Stripe Dashboard.
app.post('/api/billing/portal', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  const user = await getUserFromToken(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const { data: merchant } = await admin
    .from('merchants').select('id').eq('owner_id', user.id).maybeSingle()
  if (!merchant) return c.json({ error: 'No merchant for this account' }, 404)
  const { data: billing } = await admin
    .from('merchant_billing').select('stripe_customer_id').eq('merchant_id', merchant.id).maybeSingle()
  if (!billing?.stripe_customer_id) return c.json({ error: 'No billing account yet' }, 404)
  const session = await stripe.billingPortal.sessions.create({
    customer: billing.stripe_customer_id,
    return_url: `${env.frontendUrl}/merchant`,
  })
  return c.json({ url: session.url })
})
```

- [ ] **Step 2: Add the store helper**

In `apps/frontend/src/store.ts`, after `approveMerchant`:

```ts
// Open the Stripe billing portal for the signed-in merchant (add/update card).
export async function openBillingPortal(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${API_URL}/api/billing/portal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || 'Could not open billing portal')
  }
  const { url } = await res.json()
  return url
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/index.ts apps/frontend/src/store.ts
git commit -m "feat(billing): Stripe billing-portal endpoint + client helper"
```

---

### Task 7: Webhook — `customer.subscription.trial_will_end` sends the 72h email

Stripe fires this event exactly 3 days (72h) before trial end — no scheduler needed.

**Files:**
- Modify: `apps/backend/src/index.ts` (imports; new `case` in the webhook `switch` before the `default`, currently line 164)

**Interfaces:**
- Consumes: `buildTrialReminderEmail` (Task 2), `resendSend` (Task 3).

- [ ] **Step 1: Extend imports**

In `apps/backend/src/index.ts`, update the billingLifecycle import and add the email adapter:

```ts
import { canStartTrial, buildTrialReminderEmail } from './billingLifecycle.js'
import { resendSend } from './email.js'
```

- [ ] **Step 2: Add the webhook case**

In the webhook `switch`, after the `invoice.payment_failed` case and before `default`:

```ts
      case 'customer.subscription.trial_will_end': {
        // Fires 72h before trial end — the out-of-app reminder. A thrown send
        // error 500s the webhook so Stripe retries delivery.
        const sub = event.data.object
        const merchantId = sub.metadata?.merchant_id
        if (merchantId && sub.trial_end) {
          const { data: merchant } = await admin
            .from('merchants').select('name, owner_id').eq('id', merchantId).maybeSingle()
          const { data: owner } = merchant?.owner_id
            ? await admin.from('profiles').select('email').eq('id', merchant.owner_id).maybeSingle()
            : { data: null }
          if (owner?.email) {
            const { subject, text } = buildTrialReminderEmail({
              shopName: merchant?.name || 'your shop',
              trialEndsAt: new Date(sub.trial_end * 1000).toISOString(),
              dashboardUrl: `${env.frontendUrl}/merchant`,
            })
            await resendSend(owner.email, subject, text)
          }
        }
        break
      }
```

- [ ] **Step 3: Typecheck + backend tests**

Run: `pnpm typecheck && pnpm --filter @bitetime/backend test`
Expected: clean, all PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/index.ts
git commit -m "feat(billing): trial_will_end webhook sends the 72h reminder email"
```

---

### Task 8: Checkout stops granting trials

Checkout is now exclusively the paid path (pro signup + reactivation). Removing `trial_period_days` here is what makes "one trial ever" structural; the approval endpoint's `canStartTrial` guard is defense in depth.

**Files:**
- Modify: `apps/backend/src/index.ts:94-98`

**Interfaces:**
- Produces: Checkout Sessions with no trial and default payment collection. No signature changes.

- [ ] **Step 1: Remove the trial grant**

In the `/api/checkout` route, replace:

```ts
    payment_method_collection: 'always', // card upfront even for the Basic trial
    subscription_data: {
      metadata,
      ...(plan === 'basic' ? { trial_period_days: 7 } : {}),
    },
```

with:

```ts
    // No trial here: trials are granted only by superadmin approval (cardless).
    // Checkout is the paid path — pro signup and suspended-shop reactivation.
    subscription_data: { metadata },
```

- [ ] **Step 2: Typecheck + backend tests**

Run: `pnpm typecheck && pnpm --filter @bitetime/backend test`
Expected: clean, all PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/index.ts
git commit -m "feat(billing): checkout never grants a trial — one trial ever"
```

---

### Task 9: Frontend pure seam — `billingBanner.ts` (TDD)

Billing row + clock → banner state. Prior art: `apps/frontend/src/pricing.ts` discipline, colocated-test pattern of `apps/frontend/src/merchant/overviewStats.ts` / `overviewStats.test.ts`.

**Files:**
- Create: `apps/frontend/src/merchant/billingBanner.ts`
- Test: `apps/frontend/src/merchant/billingBanner.test.ts`

**Interfaces:**
- Produces:

```ts
interface BillingSnapshot { status?: string | null; trial_ends_at?: string | null }
type BannerState =
  | { kind: 'none' }
  | { kind: 'trial'; urgent: boolean; daysLeft: number; hoursLeft: number }
  | { kind: 'past-due' }
function billingBannerState(billing: BillingSnapshot | null | undefined, now: Date): BannerState
```

Task 10 consumes all three exports.

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/merchant/billingBanner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { billingBannerState } from './billingBanner'

const NOW = new Date('2026-07-02T12:00:00.000Z')
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString()

describe('billingBannerState', () => {
  it('is none with no billing row', () => {
    expect(billingBannerState(null, NOW)).toEqual({ kind: 'none' })
    expect(billingBannerState(undefined, NOW)).toEqual({ kind: 'none' })
  })

  it('is none for an active (paid) subscription', () => {
    expect(billingBannerState({ status: 'active' }, NOW)).toEqual({ kind: 'none' })
  })

  it('is none when trialing without a recorded trial end', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: null }, NOW)).toEqual({ kind: 'none' })
  })

  it('counts down a comfortable trial without urgency', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(73) }, NOW))
      .toEqual({ kind: 'trial', urgent: false, daysLeft: 3, hoursLeft: 1 })
  })

  it('turns urgent at exactly 72 hours', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(72) }, NOW))
      .toEqual({ kind: 'trial', urgent: true, daysLeft: 3, hoursLeft: 0 })
  })

  it('stays urgent through the final hours', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(2) }, NOW))
      .toEqual({ kind: 'trial', urgent: true, daysLeft: 0, hoursLeft: 2 })
  })

  it('clamps to zero after the trial end while the webhook lags', () => {
    expect(billingBannerState({ status: 'trialing', trial_ends_at: hoursFromNow(-1) }, NOW))
      .toEqual({ kind: 'trial', urgent: true, daysLeft: 0, hoursLeft: 0 })
  })

  it('flags past_due for the failed-renewal banner', () => {
    expect(billingBannerState({ status: 'past_due' }, NOW)).toEqual({ kind: 'past-due' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bitetime/frontend exec vitest run src/merchant/billingBanner.test.ts`
Expected: FAIL — cannot resolve `./billingBanner`.

- [ ] **Step 3: Implement the module**

Create `apps/frontend/src/merchant/billingBanner.ts`:

```ts
// Pure banner-state derivation for the merchant dashboard billing banner.
// Mirrors the Order pricing discipline: the billing row and the clock are
// passed in, no I/O. The component renders; this module decides.

export interface BillingSnapshot {
  status?: string | null
  trial_ends_at?: string | null
}

export type BannerState =
  | { kind: 'none' }
  | { kind: 'trial'; urgent: boolean; daysLeft: number; hoursLeft: number }
  | { kind: 'past-due' }

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const URGENT_WINDOW_MS = 72 * HOUR

export function billingBannerState(
  billing: BillingSnapshot | null | undefined,
  now: Date,
): BannerState {
  if (!billing) return { kind: 'none' }
  if (billing.status === 'past_due') return { kind: 'past-due' }
  if (billing.status !== 'trialing' || !billing.trial_ends_at) return { kind: 'none' }
  const msLeft = Math.max(0, new Date(billing.trial_ends_at).getTime() - now.getTime())
  return {
    kind: 'trial',
    urgent: msLeft <= URGENT_WINDOW_MS,
    daysLeft: Math.floor(msLeft / DAY),
    hoursLeft: Math.floor((msLeft % DAY) / HOUR),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bitetime/frontend exec vitest run src/merchant/billingBanner.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/billingBanner.ts apps/frontend/src/merchant/billingBanner.test.ts
git commit -m "feat(billing): pure banner-state seam with 72h urgency window"
```

---

### Task 10: `BillingBanner` component, mounted at the top of the dashboard

**Files:**
- Create: `apps/frontend/src/merchant/BillingBanner.tsx`
- Modify: `apps/frontend/src/merchant/Dashboard.tsx:45-56` (mount above the section switch)

**Interfaces:**
- Consumes: `billingBannerState`/`BillingSnapshot` (Task 9), `fetchMyBilling` (existing, store.ts:148), `openBillingPortal` (Task 6).

- [ ] **Step 1: Write the component**

Create `apps/frontend/src/merchant/BillingBanner.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMyBilling, openBillingPortal } from '../store'
import { billingBannerState, type BillingSnapshot } from './billingBanner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Persistent billing banner at the top of the merchant dashboard. Deliberately
// not dismissible: trial expiry and failed payments are the two states a
// merchant must not be able to hide from themselves.
export default function BillingBanner() {
  const { t, merchant } = useSession()
  const [billing, setBilling] = useState<BillingSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const merchantId = merchant?.id

  useEffect(() => {
    if (!merchantId) return
    let on = true
    fetchMyBilling(merchantId).then(b => { if (on) setBilling(b) })
    return () => { on = false }
  }, [merchantId])

  const state = billingBannerState(billing, new Date())
  if (state.kind === 'none') return null

  async function toPortal() {
    setBusy(true)
    try { window.location.assign(await openBillingPortal()) }
    catch { setBusy(false) }
  }

  const urgent = state.kind === 'past-due' || (state.kind === 'trial' && state.urgent)
  const countdown = state.kind === 'trial'
    ? (state.daysLeft > 0
        ? t(`${state.daysLeft} days ${state.hoursLeft}h`, `${state.daysLeft} 天 ${state.hoursLeft} 小时`)
        : t(`${state.hoursLeft} hours`, `${state.hoursLeft} 小时`))
    : ''

  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 flex-wrap px-4 py-3 mb-5 rounded-md border-[1.5px] text-[13px] leading-[1.5]',
        urgent ? 'bg-danger-bg text-danger-fg border-danger-fg/25' : 'bg-warn-bg text-warn-fg border-warn-fg/25',
      )}
    >
      <span className="flex-1 min-w-[200px] font-medium">
        {state.kind === 'past-due'
          ? t('Payment failed — update your card to keep your shop open.',
              '付款失败——请更新银行卡以保持店铺营业。')
          : state.urgent
            ? t(`Your free trial ends in ${countdown}. Add a payment method to keep your shop open.`,
                `免费试用将在 ${countdown} 后结束。请添加付款方式以保持店铺营业。`)
            : t(`Free trial — ${countdown} left.`, `免费试用——剩余 ${countdown}。`)}
      </span>
      <Button
        size="none"
        variant="outline"
        className="py-[5px] px-3 rounded-pill text-[12px] whitespace-nowrap bg-surface-raised hover:bg-oxblood-tint hover:text-oxblood hover:border-oxblood"
        disabled={busy}
        onClick={toPortal}
      >
        {busy
          ? t('Opening…', '打开中…')
          : state.kind === 'past-due'
            ? t('Update card', '更新银行卡')
            : t('Add payment method', '添加付款方式')}
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Mount it in the dashboard**

In `apps/frontend/src/merchant/Dashboard.tsx`, add the import:

```ts
import BillingBanner from './BillingBanner'
```

and render it as the first child inside `DashboardShell` (before `<AnimatePresence …>`):

```tsx
      <BillingBanner />
      <AnimatePresence mode="wait" initial={false}>
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/merchant/BillingBanner.tsx apps/frontend/src/merchant/Dashboard.tsx
git commit -m "feat(billing): persistent trial/past-due banner on the merchant dashboard"
```

---

### Task 11: Cardless basic signup — skip Checkout, wait for approval

**Files:**
- Modify: `apps/frontend/src/merchant/SignupScreen.tsx:56-61,82-87`
- Modify: `apps/frontend/src/merchant/PendingScreen.tsx:12-13,18`

**Interfaces:**
- Consumes: `createMerchant` with `region` (Task 1).

- [ ] **Step 1: Fork the signup flow by plan**

In `apps/frontend/src/merchant/SignupScreen.tsx`, replace the post-`createMerchant` section of `onSubmit` (currently lines 56–61):

```ts
      await createMerchant({ name, plan, billing, region: pricing.region })
      await refreshMerchant()
      if (plan === 'basic') {
        // Cardless trial: no Checkout. The shop waits for platform approval,
        // which is what starts the 7-day trial subscription.
        window.location.assign('/merchant')
        return
      }
      // Pro pays upfront: hand off to Stripe Checkout; webhook activates the shop.
      // Bill the region shown on this page so displayed price equals charged price.
      const url = await startCheckout({ plan, billing, region: pricing.region })
      window.location.assign(url)
```

- [ ] **Step 2: Say "no card required" on the plan banner**

In the same file, replace the trial `Badge` content (lines 82–86):

```tsx
          {plan === 'basic' && (
            <Badge variant="default" className="ml-auto py-[2px] tracking-[0.03em]">
              {t('7-day free trial — no card required', '7 天免费试用，无需信用卡')}
            </Badge>
          )}
```

- [ ] **Step 3: PendingScreen — basic waits for review, pro can finish paying**

In `apps/frontend/src/merchant/PendingScreen.tsx`, replace line 13:

```ts
  // Pro merchants that abandoned Checkout can finish paying here. Basic shops
  // are cardless: they wait for approval (which starts the trial), so they
  // always see the review notice.
  const hasPlan = !!merchant?.plan && merchant.plan !== 'basic'
```

and pass the recorded region in `completePayment` (line 18):

```ts
      const url = await startCheckout({ plan: merchant!.plan as string, billing: merchant!.billing_cycle || 'monthly', region: merchant!.billing_region })
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/SignupScreen.tsx apps/frontend/src/merchant/PendingScreen.tsx
git commit -m "feat(signup): cardless basic trial — no Checkout, pending until approval"
```

---

### Task 12: Suspended dashboard — reactivate CTA + read-only orders

**Files:**
- Create: `apps/frontend/src/merchant/SuspendedScreen.tsx`
- Modify: `apps/frontend/src/merchant/OrdersView.tsx:57,153-174` (add `readOnly` prop)
- Modify: `apps/frontend/src/merchant/MerchantHome.tsx:51` (+ import)

**Interfaces:**
- Consumes: `startCheckout` (existing), `OrdersView` (modified here to accept `readOnly?: boolean`).
- Produces: `<SuspendedScreen />`; `OrdersView({ readOnly?: boolean })`.

- [ ] **Step 1: Make OrdersView optionally read-only**

In `apps/frontend/src/merchant/OrdersView.tsx`, change the signature (line 57):

```ts
export default function OrdersView({ readOnly = false }: { readOnly?: boolean } = {}) {
```

and wrap the footer status-select block (lines 153–174, the `{/* ── Footer: status select ── */}` div) so it only renders when editable:

```tsx
            {/* ── Footer: status select (hidden for suspended read-only view) ── */}
            {!readOnly && (
              <div className="flex items-center gap-[10px] flex-wrap pt-[6px] border-t border-surface-sunken">
                <label className={LBL} htmlFor={`status-${o.id}`}>
                  {t('Status', '状态')}
                </label>
                {/* Self-contained stack wrapper (replaces admin-field--stack dependency) */}
                <div className="flex flex-col gap-1 min-w-[200px] items-start">
                  <select
                    id={`status-${o.id}`}
                    className={SELECT_CLS}
                    style={{ backgroundImage: CHEVRON_SVG, backgroundPosition: 'right 10px center' }}
                    value={o.status || 'new'}
                    onChange={e => handleStatusChange(o, e.target.value)}
                  >
                    {ORDER_STATUSES.map(s => (
                      <option key={s} value={s}>
                        {t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
```

- [ ] **Step 2: Write SuspendedScreen**

Create `apps/frontend/src/merchant/SuspendedScreen.tsx`:

```tsx
import { useState } from 'react'
import { useSession } from '../SessionContext'
import { startCheckout } from '../store'
import OrdersView from './OrdersView'
import { Button } from '@/components/ui/button'

// Suspended = the subscription lapsed (trial ended unpaid, dunning exhausted)
// or a superadmin action. The storefront is closed to customers; the merchant
// keeps read-only access to their order history and one path back: pay.
// Reactivation Checkout never grants a second trial (backend guarantees it).
export default function SuspendedScreen() {
  const { t, merchant } = useSession()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function reactivate() {
    setBusy(true); setErr('')
    try {
      const url = await startCheckout({
        plan: merchant?.plan || 'basic',
        billing: merchant?.billing_cycle || 'monthly',
        region: merchant?.billing_region,
      })
      window.location.assign(url)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Could not start checkout', '无法开始结账'))
      setBusy(false)
    }
  }

  return (
    <div className="w-full max-w-[720px] mx-auto pt-8 px-4 pb-12">
      <div
        role="status"
        className="flex items-center gap-3 flex-wrap px-4 py-3 mb-6 rounded-md border-[1.5px] text-[13px] leading-[1.5] bg-danger-bg text-danger-fg border-danger-fg/25"
      >
        <span className="flex-1 min-w-[200px] font-medium">
          {t('Your shop is suspended — your subscription has ended. Subscribe to reopen it.',
             '您的店铺已暂停——订阅已结束。重新订阅即可恢复营业。')}
        </span>
        <Button
          size="none"
          variant="outline"
          className="py-[5px] px-3 rounded-pill text-[12px] whitespace-nowrap bg-surface-raised hover:bg-oxblood-tint hover:text-oxblood hover:border-oxblood"
          disabled={busy}
          onClick={reactivate}
        >
          {busy ? t('Redirecting…', '跳转中…') : t('Reactivate — pay now', '恢复营业——立即付款')}
        </Button>
      </div>
      {err && (
        <div className="text-[13px] text-ink-soft bg-oxblood-tint border border-rose-border rounded-sm px-[13px] py-[10px] mb-4 leading-[1.5]">
          {err}
        </div>
      )}
      <h2 className="font-heading text-[18px] font-medium text-oxblood mb-3">
        {t('Your orders', '您的订单')}
      </h2>
      <OrdersView readOnly />
    </div>
  )
}
```

- [ ] **Step 3: Route suspended merchants to it**

In `apps/frontend/src/merchant/MerchantHome.tsx`, add the import:

```ts
import SuspendedScreen from './SuspendedScreen'
```

and replace line 51:

```tsx
  if (ownMerchant.status === 'suspended') return <SuspendedScreen />
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/SuspendedScreen.tsx apps/frontend/src/merchant/OrdersView.tsx apps/frontend/src/merchant/MerchantHome.tsx
git commit -m "feat(billing): suspended dashboard — reactivate CTA + read-only orders"
```

---

### Task 13: Copy — landing "no card required" + localized storefront closed page

**Files:**
- Modify: `apps/frontend/src/marketing/Landing.tsx:265,362`
- Modify: `apps/frontend/src/AppRouter.tsx:29-30,54-66`

**Interfaces:** none (copy only).

- [ ] **Step 1: Landing copy**

In `apps/frontend/src/marketing/Landing.tsx` line 265, replace the string pair with:

```ts
          {t('Start with a 7-day free trial — no card required. Upgrade when your shop grows.', '7 天免费试用开始，无需信用卡，店铺成长后再升级。')}
```

Line 362, replace with:

```ts
          {t('7-day free trial · No card required · Cancel anytime.', '7 天免费试用 · 无需信用卡 · 随时取消。')}
```

(Line 377 "Start your free trial" is already accurate — leave it.)

- [ ] **Step 2: Localize the storefront closed page**

In `apps/frontend/src/AppRouter.tsx`, add `useSession` to the existing SessionContext import (line 5):

```ts
import { SessionProvider, useSession } from './SessionContext'
```

In `StorefrontShell` (line 29), read `t`:

```ts
function StorefrontShell() {
  const { merchant, loading, notFound } = useMerchant()
  const { t } = useSession()
```

Replace the non-active branch body text (line 61–63) with:

```tsx
        <p className="text-rose-muted text-[14px] leading-[1.6] mt-1.5">
          {t('This shop is temporarily closed. Please check back later.', '本店暂时休息，请稍后再来。')}
        </p>
```

One message for both `pending` and `suspended` — customers never learn a shop's billing state.

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/marketing/Landing.tsx apps/frontend/src/AppRouter.tsx
git commit -m "feat(copy): no-card-required trial copy + localized shop-closed page"
```

---

### Task 14: Docs + full verification

**Files:**
- Modify: `apps/backend/README.md` (Routes + Stripe one-time config sections)
- Modify: `CONTEXT.md` (new glossary entry)

**Interfaces:** none.

- [ ] **Step 1: Update the backend README**

In `apps/backend/README.md` Routes section, replace the `/api/checkout` bullet's trailing sentence "Basic gets a 7-day trial; both collect a card upfront." with "Paid path only (pro signup + reactivation) — never grants a trial." and add bullets:

```md
- `POST /api/admin/approve-merchant` — body `{ merchantId }`, superadmin JWT.
  Creates the Stripe customer + 7-day cardless trialing subscription
  (`missing_payment_method: 'cancel'`) and flips the merchant `active`. The only
  place a trial is ever granted; refuses pro-plan and non-pending merchants.
- `POST /api/billing/portal` — merchant JWT. Returns `{ url }` to a Stripe
  billing-portal session (add/update card). Requires the portal to be enabled
  once in the Stripe Dashboard.
```

In the "Stripe products/prices (one-time)" section, replace the final paragraph about the trial with:

```md
One-time Stripe Dashboard setup beyond prices:

- **Billing portal**: Settings → Billing → Customer portal → enable (allow
  payment-method updates). `/api/billing/portal` fails until this is done.
- **Webhook events** (production endpoint): `checkout.session.completed`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `customer.subscription.trial_will_end`, `invoice.payment_failed`.
  (`stripe listen` forwards everything locally.)
- **Dunning**: Settings → Billing → Revenue recovery — after smart retries are
  exhausted, set "cancel the subscription" so the `subscription.deleted`
  webhook suspends the shop.
- Trials are applied per-subscription by the approve endpoint
  (`trial_period_days: 7`, cancel-if-no-card), not on the prices.
```

- [ ] **Step 2: Add the glossary entry**

Append to `CONTEXT.md`:

```md
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
`billingLifecycle` (backend) and `billingBanner` (frontend).
```

- [ ] **Step 3: Full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean/PASS.

- [ ] **Step 4: Run-and-verify (manual, per project convention)**

With `supabase start`, `pnpm dev`, and `stripe listen --forward-to localhost:8787/api/stripe/webhook` running:

1. Sign up a new basic-plan shop → lands on PendingScreen "under review" (no Checkout, no card).
2. As superadmin, `/admin/merchants` → Approve → row flips active; Stripe Dashboard shows a trialing subscription with trial end 7 days out.
3. Merchant dashboard shows the amber trial banner ("Free trial — 6 days 23h left").
4. In Supabase Studio, set `merchant_billing.trial_ends_at` to now + 48h → reload → banner turns red/urgent.
5. Click "Add payment method" → Stripe billing portal opens; add test card `4242 4242 4242 4242` → returns to `/merchant`.
6. `stripe trigger customer.subscription.trial_will_end` → backend logs the email send (or the skip warning when `RESEND_API_KEY` is unset).
7. In Stripe Dashboard, cancel the test subscription → webhook fires → merchant flips suspended → dashboard shows SuspendedScreen (red banner + read-only orders, no status selects) → storefront `/s/<slug>` shows "temporarily closed".
8. Click "Reactivate — pay now" → Checkout (verify **no trial line** on the Checkout page) → pay → shop active again.
9. Toggle language to 中文 and spot-check banner, suspended screen, closed page.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/README.md CONTEXT.md
git commit -m "docs(billing): trial lifecycle — routes, Stripe setup, glossary"
```
