# Winding down happens in the dashboard, not the portal

Amends [ADR 0004](0004-plan-entitlement-follows-the-stripe-price.md), which rejected calling `stripe.subscriptions.update()` ourselves. That still holds for the **upgrade**. It does not hold for the three ways a merchant winds down — **cancel**, **step down to Basic**, and **undo either** — which now happen in the dashboard, through `POST /api/billing/{cancel,downgrade,resume}`.

The reason 0004 gave for handing Stripe the wheel was proration: a mid-period tier increase means credits, cycle changes and mid-period money movement, all hand-written, for a two-tier product where the portal has a screen built to explain it. **None of that applies to a change that lands on a period boundary.** Cancelling is a flag (`cancel_at_period_end`), and the downgrade is a two-phase Subscription Schedule with `proration_behavior: 'none'` — the current phase copied verbatim, then one period at the Basic price. No money moves at the moment of the click, so there is nothing for a payment screen to explain.

What owning them buys is the sentence the portal cannot say: **cancelling suspends this shop.** Stripe's portal knows about a subscription; it does not know that when this one ends, `customer.subscription.deleted` sets the merchant to `suspended`, the storefront goes dark and customers can no longer order. A merchant deserves to be told that, on the screen where they press the button, in their own language, with the date on it.

## The bug that forced this

Before any of it, the app could not tell a subscription that renews from one that is winding down. Stripe leaves `status` on `'active'` for a subscription cancelling at period end, and `billingFromSubscription` did not read `cancel_at_period_end` — so a merchant could cancel in the portal, watch the Subscription tab go on promising *"Renews on 1 Sep"*, and discover on 1 Sep that their shop had been suspended. `merchant_billing.cancel_at_period_end` exists so that state is visible **before** the cliff. It is not derivable from anything else on the row.

`merchant_billing.pending_plan` does the same for a scheduled downgrade, and is **intent, never entitlement**. `merchants.plan` still moves only through `reconcileMerchantPlan`, so a shop that has scheduled a downgrade keeps every Pro feature until the period it paid for actually ends. Nothing may gate on `pending_plan`, or a merchant loses Pro the moment they schedule leaving it rather than at the end of what they bought.

## Considered options

**Immediate downgrade with a proration credit** stays rejected, for the reason 0004 gave: it is defensible on the money and indefensible in the shop, because it drops live vouchers under a customer mid-checkout.

**Leaving cancellation to the portal and merely surfacing the flag** was the smaller change, and would have fixed the silent-suspension bug on its own. It was rejected because the portal's cancel screen is where the warning is most needed and is the one screen we cannot write.

**One route per undo** — separate "un-cancel" and "cancel the scheduled downgrade" — was rejected in favour of a single `resume` that clears whatever is pending. It answers one question ("keep things as they are"), and leaving a merchant to undo two pending changes in two clicks is how one of them gets forgotten.

**`subscriptionSchedules.cancel()`** is the trap in this API and is named here because the method that sounds right is the destructive one: it cancels the *subscription* the schedule drives. `release()` is what detaches a schedule and leaves the subscription running. Cancel and resume both release first, so a cancellation always supersedes a pending downgrade and the two intents can never both be live.

## The artifact cutoff

0004 closed by accepting that a shop stepping down to Basic keeps its Pro artifacts working, and tracking it separately. That is now closed, and the shape matters more than the fact.

The cutoff is **data-level and fires once, at the transition** (`revokeProArtifacts`, called from `reconcileMerchantPlan` only when the tier actually moves `pro → basic`):

- **Vouchers** get an `active` column, set false in bulk. Redemption filters it inside the transaction it was already reading the row in — a **column filter, not a plan check**.
- **Promos** have `promo_end` moved to the transition moment. The configured `promo_price` survives as the merchant's own record; `promoState` already reads a past end date as no promo.
- **Telegram** is the exception: it is gated at the notify route rather than revoked, because the token is a **credential, not an artifact**, and deleting it would make re-upgrading mean re-doing BotFather. Safe there precisely because notify is a separate call *after* the order has landed — it can refuse without an order being lost.

The constraint 0004 named — **no plan check inside the priced order transaction** — is therefore still intact, and it is the reason none of this is a `merchants.plan` lookup at checkout time.

## Consequences

**The cutoff is not symmetric.** Re-subscribing to Pro does not resurrect deactivated vouchers or restart ended sales. Those are decisions with customer-visible money attached, and silent resurrection is the worse failure — but a merchant who steps down and back up will find their vouchers still dead and should be told so, not left to discover it.

**A downgrade takes effect only if the webhook arrives.** The schedule executes in Stripe, and `customer.subscription.updated` is what moves `merchants.plan` and runs the cutoff. In local development with no `stripe listen` forwarder running, the period rolls over and nothing changes — the same class of silent failure documented in CLAUDE.md.

**`merchant_billing` now carries state written by two authors.** The routes write the outcome immediately so the tab does not lie in the seconds before the webhook lands; the webhook confirms it. They agree because both go through `billingFromSubscription` on a subscription object Stripe just returned, but a third writer that skips it would drift.
