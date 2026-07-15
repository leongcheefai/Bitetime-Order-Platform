# PRD: Referral reward — a free month for bringing in a paying shop

Closes the decision half of #70 (child of #66). **This is a billing-layer program, not an
order-pricing one.** The `referral` input and `referralDiscount` in `priceOrder` were a
legacy *customer-order* discount from the deleted single-tenant order form; they are not
this program and are removed here (see FR-9).

## Introduction

BiteTime already has **referral capture**: a merchant signs up under another member's code,
which is stamped on `merchants.referred_by_code`, and the referrer can list the shops they
brought in (`GET /api/referrals/shops`). That is live, display-only, and grants no reward
(`apps/backend/src/referrals.ts`, migration `20260704130000_referral_capture.sql`).

This PRD turns that capture into a reward. **When a merchant a member referred pays their
first real invoice, the referring member earns one month free of their own current plan
(Basic or Pro).** The referred merchant gets nothing. The reward is delivered as a credit on
the referrer's Stripe customer balance, so it is consumed automatically against their next
invoice(s).

This is deliberately the *merchant-acquisition* referral (member → shop → subscription), the
inverse of the abandoned *customer-order* referral (customer → order → discount) that #70
started from. The order-pricing plumbing for the latter is dead and is deleted here.

## Goals

- A member earns **one free month of their current plan** for each referred merchant that
  converts to a **paying** subscription.
- The reward fires on **real revenue** (first paid invoice), never on a trial that may churn.
- The reward is valued at and delivered against the **referrer's** plan, in the **referrer's**
  billing currency — independent of what the referred shop pays.
- Each referred merchant grants **at most one** reward, ever (idempotent).
- Rewards **stack with no cap**: three converted referrals = three free months.
- Remove the dead `referral` / `referralDiscount` path from `priceOrder` and trim
  `CONTEXT.md` → Referral to the capture half plus this reward.

## Locked decisions (from #70 grilling, 2026-07-15)

| Question | Decision |
|----------|----------|
| Reward level | **Subscription**, not order. One month free of the referrer's plan. |
| Who earns | The **referrer** only. The referred merchant gets nothing. |
| Trigger | The referred merchant's **first paid invoice** (trial → paid conversion). |
| Reward value | The **referrer's current plan monthly price at trigger time** (Basic or Pro). |
| Delivery | Credit on the referrer's **Stripe customer balance**; auto-applied to next invoice(s). |
| Referrer not on a paid plan at trigger | **Forfeit** (no reward, no hold) — MVP. |
| Clawback if referred shop later cancels/refunds | **None.** Once earned, the month stays. |
| Multiple referrals | **Stack, no cap.** |

## User Stories

### US-001: Persist earned rewards (idempotency ledger)
**Description:** As the platform, I need a record of which referred merchant has already
granted a reward, so a shop can never mint a second free month for its referrer on a later
billing cycle.

**Acceptance Criteria:**
- [ ] Migration adds `referral_rewards` with **primary key `referred_merchant_id`** (uuid,
      references `merchants(id)`), plus `referrer_merchant_id uuid`, `amount integer`,
      `currency text`, `stripe_customer_id text`, `stripe_balance_txn_id text`,
      `created_at timestamptz not null default now()`.
- [ ] RLS enabled; **no** write policy — service-role (webhook) writes only, mirroring
      `merchant_billing`. Read policy: the referrer's owner (or superadmin) may read their own
      earned rewards.
- [ ] `grant insert on referral_rewards to service_role` only; `select` to `authenticated`
      constrained by the read policy.
- [ ] Migration applied via `db:migrate`; typecheck passes.

### US-002: Index the reverse code→referrer lookup
**Description:** As the reward handler, I need to resolve a `referred_by_code` back to the
referring merchant, because the reward has to land on *that* member's Stripe customer.

**Acceptance Criteria:**
- [ ] Migration adds a **stored generated column** `referral_code` on `merchants`,
      `= upper(left(replace(owner_id::text, '-', ''), 8))`, byte-identical to
      `referralCodeOf()` and to what signup stamps.
- [ ] Index on `merchants(referral_code)`.
- [ ] A shared helper resolves a code to the referrer merchant that is the reward target —
      **the referrer's shop with an active/paying `merchant_billing` row** (see Open
      Questions on multi-shop members). Returns null if none.
- [ ] Unit test proves `referral_code` matches `referralCodeOf(owner_id)` for sample ids.

### US-003: Detect the first paid invoice and grant the reward
**Description:** As the platform, when a referred merchant's first real payment succeeds, I
credit the referrer one month of their current plan.

**Acceptance Criteria:**
- [ ] New `invoice.paid` (a.k.a. `invoice.payment_succeeded`) case in the Stripe webhook
      (`app.ts`), guarded so it only acts on `amount_paid > 0` and a
      `billing_reason` of `subscription_create` or `subscription_cycle`.
- [ ] Resolve the paying merchant from invoice → subscription metadata `merchant_id`, using
      the same new-location/legacy fallback as the existing `invoice.payment_failed` case.
- [ ] Look up that merchant's `referred_by_code`; if null, do nothing (not every shop was
      referred).
- [ ] If `referral_rewards` already has a row for this `referred_merchant_id`, do nothing
      (idempotent — later cycles never re-fire).
- [ ] Resolve the referrer merchant (US-002). If none, or the referrer has **no active paid
      plan**, do nothing (forfeit) and do **not** write a ledger row (so a later state could
      still... — see Open Questions on forfeit permanence).
- [ ] Reward amount = the referrer's **current plan monthly price**, read from the referrer's
      **active Stripe subscription** (authoritative amount lives in Stripe, per the
      location-based-pricing rule), in the subscription's currency.
- [ ] Apply the credit via `stripe.customers.createBalanceTransaction(referrerCustomerId,
      { amount: -<monthlyPrice>, currency })` — negative amount = credit.
- [ ] Insert the `referral_rewards` row with the returned balance-transaction id **in the same
      handler**, after the Stripe credit succeeds, so the ledger reflects real credits only.
- [ ] A thrown error 500s the webhook so Stripe retries (matches existing handler contract);
      the idempotency PK makes a retry after a partial success safe.

### US-004: Surface earned rewards to the referrer
**Description:** As a referring member, I want to see the free months I've earned, so the
program is visible and not just a silent balance change.

**Acceptance Criteria:**
- [ ] The existing referral tab (that renders `GET /api/referrals/shops`) also shows earned
      rewards: count of free months and/or a list (shop name, date, amount).
- [ ] Endpoint returns only the caller's own rewards (derived from the caller's verified
      identity — never a code from the request, same rule as `listReferredShops`).
- [ ] Amount shown in the referrer's billing currency via the existing `Intl.NumberFormat`
      currency seam.
- [ ] Typecheck/lint pass; verify in browser using the verify skill.

### US-005: Remove the dead order-level referral discount
**Description:** As a maintainer, I need `priceOrder`'s `referral` input and `referralDiscount`
gone, because this program is billing-level and that path has no caller and never will.

**Acceptance Criteria:**
- [ ] `referral` input and `referralDiscount` removed from `priceOrder` in
      `packages/shared/src/pricing.ts`, and from its result type / all callers.
- [ ] Their tests removed; remaining pricing tests pass.
- [ ] `CONTEXT.md` → Referral keeps the **capture** half and gains the **reward** half from
      this PRD; the "referral discount" order-pricing paragraph and the
      "`referral` input has no caller" note are deleted.
- [ ] `pnpm typecheck && pnpm test` green.

## Functional Requirements

- **FR-1:** The reward beneficiary is the **referrer** (the member whose `referral_code`
  equals the referred merchant's `referred_by_code`). The referred merchant receives nothing.
- **FR-2:** The reward triggers on the referred merchant's **first paid invoice**
  (`amount_paid > 0`, `billing_reason ∈ {subscription_create, subscription_cycle}`), never on
  trial start, sub creation, or approval.
- **FR-3:** The reward is granted **at most once per referred merchant**, enforced by the
  `referral_rewards` primary key on `referred_merchant_id`.
- **FR-4:** The reward value is the referrer's **current plan monthly price at trigger time**,
  read from the referrer's active Stripe subscription, in that subscription's currency.
- **FR-5:** The reward is delivered as a **negative Stripe customer balance transaction** on
  the referrer's customer, consumed automatically against future invoices.
- **FR-6:** If the referrer has **no active paid plan** at trigger time, the reward is
  **forfeited** — no credit, no ledger row.
- **FR-7:** Rewards **stack without cap**: N converted referrals credit N months.
- **FR-8:** There is **no clawback**: a referred merchant cancelling or refunding after the
  trigger does not reverse an earned reward.
- **FR-9:** `priceOrder` no longer accepts `referral` and no longer returns
  `referralDiscount`; the customer-order referral discount is deleted, not migrated.
- **FR-10:** All referrer/reward lookups derive the referrer from a **stored, un-choosable**
  code (`merchants.referral_code`, generated from `owner_id`) — never from a request body —
  preserving the security property that made `listReferredShops` safe across tenants.

## Non-Goals

- **No referred-side benefit.** The referred merchant gets no discount, no free trial
  extension, nothing.
- **No order-level / customer referral discount.** Explicitly deleted (FR-9). A customer
  typing a code at checkout to get money off their food order is **not** part of this and is
  not being rebuilt.
- **No clawback / dispute reversal** on referred-merchant churn (FR-8).
- **No cap or anti-stacking cap** in MVP (FR-7).
- **No cash payout / withdrawal.** The reward exists only as account credit against future
  invoices.
- **No change to referral capture itself** — codes, signup stamping, and
  `GET /api/referrals/shops` listing are untouched except for the added reward view.
- **No email/notification** on reward earned in MVP (candidate follow-up).

## Technical Considerations

- **Seams that already exist:** `merchant_billing` (webhook-authoritative sub state,
  service-role write), `billingFromSubscription`/`upsertBilling` (`billing.ts`),
  `referralCodeOf` + `listReferredShops` (`referrals.ts`), the Stripe webhook switch in
  `app.ts` (currently handles `checkout.session.completed`, `subscription.updated/deleted`,
  `invoice.payment_failed`, `trial_will_end` — **no `invoice.paid` handler yet**; this PRD
  adds it).
- **Amount authority:** read the referrer's plan price from **Stripe**, not from
  `merchants.plan` alone — location-based pricing means the MYR/USD amount is Stripe's truth
  (see `docs/` location-based pricing work / #24).
- **Idempotency & retries:** the webhook contract is "throw → 500 → Stripe retries". The
  `referral_rewards` PK makes retries after a partial success safe: a second delivery finds
  the row and no-ops before touching Stripe.
- **Metadata drift:** the paying merchant is resolved from invoice/subscription metadata using
  the same `parent.subscription_details` new-location + legacy fallback already used in the
  `invoice.payment_failed` case.
- **Ordering:** credit Stripe first, then insert the ledger row with the returned
  balance-transaction id, so the ledger never claims a credit that did not happen.

## Success Metrics

- Every referred merchant that pays a first invoice credits its referrer exactly one month,
  once — verifiable by reconciling `referral_rewards` rows against paid first invoices.
- Zero double-credits across billing cycles (idempotency PK holds).
- Referrers can see earned free months in the dashboard without contacting support.

## Open Questions

1. **Multi-shop members.** `merchants.owner_id` is nullable and **not unique** — a member can
   own several shops (`SessionContext` resolves with `limit 1`), and each shop has its own
   Stripe customer and possibly a different plan. Which shop's customer/plan is "the
   referrer's current plan"? MVP proposal: the referrer's shop with an **active/paying**
   `merchant_billing` row; if several, the highest-tier (Pro > Basic). Confirm.
2. **Forfeit permanence.** FR-6 forfeits when the referrer has no active paid plan at trigger,
   and writes no ledger row. Should a forfeited reward be *recoverable* if the referrer later
   subscribes (i.e. hold instead of forfeit)? Locked answer is forfeit; re-confirm we don't
   want a pending state.
3. **Sybil / self-referral.** With first-paid-invoice + no-clawback, an abuser must actually
   pay a full month on a second account to earn a free month on the first — roughly
   revenue-neutral and rate-limited by real card charges. Is that acceptable, or do we want a
   same-owner / same-card guard (e.g. block reward when referred and referrer share a Stripe
   customer or payment fingerprint)?
4. **Referrer on a yearly cycle.** "One month free" against a yearly plan — credit one month's
   worth (annual price ÷ 12) of balance, or one twelfth-of-year handled as a proration note on
   the next annual invoice? Proposal: credit `min(monthly-equivalent, ...)` as a plain balance
   amount; confirm the annual-cycle math.
5. **Currency of a stacked credit.** If a referrer changes billing region between two earned
   rewards, balance transactions in two currencies can coexist on one customer. Stripe applies
   credits per-currency against matching-currency invoices — acceptable, or normalise?
