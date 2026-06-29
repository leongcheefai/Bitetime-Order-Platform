import { admin } from './supabase.js'

const toIso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null)

// Upsert the authoritative billing row for a merchant.
export async function upsertBilling(merchantId, fields) {
  const { error } = await admin
    .from('merchant_billing')
    .upsert(
      { merchant_id: merchantId, updated_at: new Date().toISOString(), ...fields },
      { onConflict: 'merchant_id' }
    )
  if (error) throw error
}

// Flip the merchant's activation status (service role bypasses RLS).
export async function setMerchantStatus(merchantId, status) {
  const { error } = await admin.from('merchants').update({ status }).eq('id', merchantId)
  if (error) throw error
}

// Derive the billing fields we persist from a Stripe subscription object.
export function billingFromSubscription(sub) {
  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    status: sub.status, // trialing | active | past_due | canceled | incomplete | ...
    trial_ends_at: toIso(sub.trial_end),
    current_period_end: toIso(sub.current_period_end),
  }
}
