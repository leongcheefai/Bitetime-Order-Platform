import type Stripe from 'stripe'
import { admin } from './supabase.js'

const toIso = (unix: number | null | undefined) =>
  unix ? new Date(unix * 1000).toISOString() : null

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
    // A card attached to the subscription means the trial will convert on its own —
    // the countdown banner softens from "add a card" to an informational notice.
    // Null here doesn't prove there's no card: it can still live on the customer
    // default, which the webhook resolves as a fallback (see index.ts).
    has_payment_method: !!sub.default_payment_method,
  }
}
