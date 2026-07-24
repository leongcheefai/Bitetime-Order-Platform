# Plan entitlement follows the Stripe price

> **Amended by [ADR 0005](0005-winding-down-happens-in-the-dashboard.md).** Two things below no longer hold. The rejection of calling `stripe.subscriptions.update()` ourselves survives only for the **upgrade** — cancel, step-down-to-Basic and undo are now dashboard routes, because a change landing on a period boundary has no proration to argue about. And the accepted artifact leak in *Consequences* is **closed**: `revokeProArtifacts` deactivates vouchers and ends running promos at the transition, without a plan check on the order path.

A shop's tier (`merchants.plan`) was whatever the signup body claimed, and nothing ever checked it against what the shop paid. That was survivable while the tiers were indistinguishable, but #110 turned `plan` into a gate on real features, and #112 needed a way for a basic shop to *become* pro. Both problems have the same answer: **the tier is derived from the price on the live Stripe subscription**, and Stripe's Customer Portal is what changes that price.

`reconcileMerchantPlan` runs on the two money-moving webhook events — `customer.subscription.updated` (the portal's plan swap) and `checkout.session.completed` (paid signup) — reads `sub.items.data[0].price.id`, and maps it back to `(plan, cycle)` through `planFromPriceId`, the inverse of the `priceId` lookup the checkout path already used. Signup keeps writing a plan, but it is now **provisional**: the first webhook after money moves confirms or corrects it, so a body claiming `plan: 'pro'` that checked out at the basic price ends up on basic.

## Considered options

**Calling `stripe.subscriptions.update()` ourselves** was the obvious alternative and was rejected for what it drags in: proration behaviour, cycle changes, mid-period credits, and every failure state of a money-moving call, all hand-written for a two-tier product where the portal does it for free and explains it on a screen built for the purpose. We would own the hardest part of billing to gain control over a dialog we do not want to design.

**A Checkout session in place of the portal** — cancel and resubscribe — was rejected as the mechanism. `POST /api/checkout` refuses a shop with a live subscription, and the usual basic shop has one (its cardless trial), so an "upgrade" through it would have to cancel first: a window where the shop is unsubscribed, a lost trial state, and a double-billing risk if the second half fails.

Checkout does, however, serve the shops the portal cannot: those with **no** live subscription — an active shop `approve-merchant` did not re-trial, or one whose subscription lapsed. That population reaches the dashboard (it is neither pending nor suspended), and telling it to "contact us" was a dead end of the same kind this ADR set out to remove. Because checkout's refusal list is the exact complement of the portal's population, the two buttons are mutually exclusive by construction rather than by care. This only became safe once the reconciliation above existed: before it, paying through Checkout would have taken the money and left `plan` untouched.

**Reading the tier from a price `lookup_key` or product metadata** would have worked, and was rejected because both put the mapping in the Stripe dashboard, where it can be forgotten on a new price or a new environment and drift silently. The four price ids are already `required()` in `env.ts`; reading them backwards costs nothing and cannot fall out of step with what we charge.

**Defaulting an unrecognised price to `basic`** was rejected as the most dangerous of the options considered. A price created by hand, a legacy price, a currency variant — any of them would silently revoke every feature a paying Pro shop pays for, with no error anywhere. `planFromPriceId` returns null and the row is left alone; a stale column is a complaint, a wrongful downgrade is an outage.

**Immediate downgrades** (swap now, credit the unused time) were rejected in favour of scheduling at period end. The credit makes it defensible on the money, but it strips features someone has already paid for and would drop live vouchers under a customer mid-checkout. Scheduling costs no code: because the reconciliation reads the price *currently* on the subscription, a pending change does not register until it applies.

**Letting each Pro lock open the billing portal directly** was the shape before this, and it dead-ends — `POST /api/billing/portal` 404s for a shop with no Stripe customer, which is exactly the comped and pre-checkout population the locks target. The CTAs route to Settings → Subscription instead, which can render that state as a sentence and can show the price before asking anyone to pay.

## Consequences

**The upgrade path depends on Stripe dashboard configuration, not on this repo.** Plan-switching must be enabled in the Customer Portal configuration, with downgrades scheduled at period end. A fresh Stripe environment without it makes the upgrade button lead somewhere that cannot upgrade, and nothing in CI will notice.

**`merchants.plan` stops being owner-declared.** The invariant in CONTEXT.md is inverted: signup writes intent, the webhook writes truth. Anything that reasons about the tier between signup and the first webhook is reading a provisional value.

**A shop that steps down to basic keeps its Pro artifacts working** — vouchers stay redeemable, the Telegram token keeps sending, promos keep discounting. The hot paths are plan-blind by #110's design and nothing revokes the data at the transition. This is accepted knowingly rather than overlooked: pre-launch the exploitable population is zero, the period-end downgrade means it cannot open until someone's first full Pro period elapses, and the honest cutoff needs a `vouchers.active` column the table does not have. It is tracked separately. What must not happen, and is the reason this is deferred rather than bodged, is a plan check inside the priced order transaction.
