import type Stripe from 'stripe'
import { admin } from './supabase.js'
import { env } from './env.js'
import { planFromPriceId } from './pricing.js'

const toIso = (unix: number | null | undefined) =>
  unix ? new Date(unix * 1000).toISOString() : null

/**
 * The `merchant_billing.status` values that mean a subscription is actually running.
 *
 * One list, because two routes read it in opposite directions and they must not disagree:
 * `/api/checkout` refuses these (there is already something to bill, so selling a second
 * subscription would double-charge), while cancel/downgrade/resume REQUIRE one (there is
 * nothing to change otherwise). Drift between the two copies would open a window where a shop
 * can do neither, or both.
 *
 * `past_due` is deliberately live: the subscription exists and Stripe is still retrying, so a
 * merchant must be able to cancel it. `canceled` and `incomplete` are not.
 */
export const LIVE_STATUSES = ['trialing', 'active', 'past_due']

// Upsert the authoritative billing row for a merchant.
export async function upsertBilling(merchantId: string, fields: Record<string, unknown>) {
  const { error } = await admin
    .from('merchant_billing')
    .upsert(
      { merchant_id: merchantId, updated_at: new Date().toISOString(), ...fields },
      { onConflict: 'merchant_id' }
    )
  if (error) throw error
}

/**
 * Bring `merchants.plan` / `billing_cycle` into line with the price the shop is ACTUALLY paying
 * for (#112). Called from the two money-moving webhook events — the Customer Portal's plan swap
 * (`customer.subscription.updated`) and the paid signup (`checkout.session.completed`).
 *
 * This is the reconciliation CONTEXT.md's entitlement invariant always named as future work, and
 * it reverses where the tier comes from: signup writes a PROVISIONAL value from the owner's
 * chosen tier, and the first webhook after money moves confirms or corrects it. A shop can no
 * longer end up entitled to a tier it never bought by declaring one at signup.
 *
 * Reads the price CURRENTLY on the subscription, which is what makes period-end downgrades free:
 * a downgrade scheduled in the portal has not touched the item yet, so this keeps returning Pro
 * until the schedule executes — no "is a change pending?" branch anywhere.
 *
 * An unrecognised price is a NO-OP, never a downgrade: see planFromPriceId. The shop keeps the
 * tier it had and the mismatch is logged for a human.
 */
export async function reconcileMerchantPlan(merchantId: string, sub: Stripe.Subscription) {
  const priceId = sub.items?.data?.[0]?.price?.id
  const tier = planFromPriceId(env.prices, priceId ?? '')
  if (!tier) {
    console.warn(
      `Subscription ${sub.id} carries price ${priceId ?? '(none)'}, which is not a configured ` +
        `plan price — leaving merchant ${merchantId} on its existing plan.`,
    )
    return
  }

  // Read before write: the artifact cutoff below has to fire on the TRANSITION, not on the
  // state. Every renewal of a Basic shop replays this event, and a cutoff keyed on "is basic"
  // would deactivate vouchers the merchant had re-enabled, once a month, forever.
  const { data: before } = await admin
    .from('merchants').select('plan').eq('id', merchantId).maybeSingle()

  const { error } = await admin
    .from('merchants')
    .update({ plan: tier.plan, billing_cycle: tier.cycle })
    .eq('id', merchantId)
  if (error) throw error

  // The scheduled change has landed, so the intent is spent. Cleared on any reconcile that
  // reaches the pending tier — whether it arrived by the schedule executing or by the merchant
  // changing their mind through some other route.
  const { data: billing } = await admin
    .from('merchant_billing').select('pending_plan').eq('merchant_id', merchantId).maybeSingle()
  if (billing?.pending_plan === tier.plan) {
    await upsertBilling(merchantId, { pending_plan: null })
  }

  if (before?.plan === 'pro' && tier.plan === 'basic') {
    await revokeProArtifacts(merchantId)
  }
}

/**
 * Stop the Pro artifacts a shop leaves behind when it steps down to Basic.
 *
 * #110 gated only the WRITES — a Basic shop cannot create a voucher or set a promo price — which
 * left the reverse direction open: a shop that had been Pro kept its vouchers redeemable and its
 * promos discounting, indefinitely, because the hot paths are plan-blind by design.
 *
 * They stay plan-blind. This revokes the DATA, once, at the transition, so that neither the
 * priced order transaction nor the storefront ever has to ask what tier a shop is on — the
 * constraint ADR 0004 named as the reason this was deferred rather than bodged. A plan lookup
 * inside `placeOrder`'s transaction would put billing state on the checkout path, where a slow
 * or wrong answer costs an order.
 *
 * Deliberately NOT symmetric with an upgrade. Re-subscribing to Pro does not resurrect old
 * vouchers or restart expired sales: those are decisions with customer-visible money attached,
 * and a merchant who wants them back can say so. Silent resurrection is the worse failure.
 *
 * Telegram is not handled here. The token is a credential, not an artifact — deleting it would
 * make a re-upgrade mean re-doing BotFather. That send is gated at the notify route instead,
 * which is safe precisely because notify is a separate call AFTER the order lands, never part
 * of the order transaction.
 */
export async function revokeProArtifacts(merchantId: string) {
  const at = new Date().toISOString()

  // Vouchers already handed to customers keep existing — the row, its redemption history and
  // its code all survive — they simply stop being redeemable. Filtering on `active` means only
  // live ones are touched, so this is idempotent.
  const { error: voucherErr } = await admin
    .from('vouchers').update({ active: false }).eq('merchant_id', merchantId).eq('active', true)
  if (voucherErr) throw voucherErr

  // A running sale is ended by moving its end date to now rather than by clearing `promo_price`:
  // the merchant's configured price survives for reference, the product reads as "promo ended
  // <date>", which is true, and `promoState` already treats a past end date as no promo. Sales
  // that had already finished are excluded so their historical end dates are not rewritten.
  const { error: promoErr } = await admin
    .from('products')
    .update({ promo_end: at })
    .eq('merchant_id', merchantId)
    .not('promo_price', 'is', null)
    .or(`promo_end.is.null,promo_end.gt.${at}`)
  if (promoErr) throw promoErr
}

// Flip the merchant's activation status (service role bypasses RLS).
export async function setMerchantStatus(merchantId: string, status: string) {
  const { error } = await admin.from('merchants').update({ status }).eq('id', merchantId)
  if (error) throw error
}

// Derive the billing fields we persist from a Stripe subscription object.
export function billingFromSubscription(sub: Stripe.Subscription) {
  // Stripe moved `current_period_end` from the subscription onto its items
  // (API version 2025-03-31+). Prefer the item-level value, falling back to the
  // legacy top-level field so older API versions keep working.
  const item0 = sub.items?.data?.[0] as { current_period_end?: number } | undefined
  const periodEnd = item0?.current_period_end ?? (sub as { current_period_end?: number }).current_period_end
  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    status: sub.status, // trialing | active | past_due | canceled | incomplete | ...
    trial_ends_at: toIso(sub.trial_end),
    current_period_end: toIso(periodEnd),
    // A subscription winding down looks EXACTLY like a healthy one from `status` alone —
    // Stripe leaves it 'active' until the period actually ends. Without this flag the
    // Subscription tab went on promising "Renews on 1 Sep" to a merchant who had cancelled,
    // and the first they heard of it was their shop being suspended.
    cancel_at_period_end: !!sub.cancel_at_period_end,
    // A card attached to the subscription means the trial will convert on its own —
    // the countdown banner softens from "add a card" to an informational notice.
    // Null here doesn't prove there's no card: it can still live on the customer
    // default, which the webhook resolves as a fallback (see index.ts).
    has_payment_method: !!sub.default_payment_method,
  }
}
