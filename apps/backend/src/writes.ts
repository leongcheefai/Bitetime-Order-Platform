// Column allowlists for write endpoints. The service-role `admin` client bypasses RLS and the
// guard_merchant_status / guard_profile_privileges triggers, so these picks are the ONLY thing
// stopping privilege escalation. Never spread a raw client body into a DB write — pick from here.

export const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

// Owner-editable shop config. Deliberately EXCLUDES status, owner_id, slug, plan, billing_*, id.
// Mirrors what the browser could safely write under the old RLS+trigger regime. This is the
// EXACT union of the two updateMerchantConfig call sites (ShopSettings.tsx:141 writes
// { currency?, shipping, pickup_address }; :243 writes { payment_bank, payment_note }) —
// verified 2026-07-18. `shipping` is a jsonb column (shopRates output); `currency` is dropped
// client-side once locked, but allowlist it anyway — the lock is a UI concern, and the currency
// column is not a privilege.
const MERCHANT_CONFIG_FIELDS = [
  'currency', 'shipping', 'pickup_address', 'payment_bank', 'payment_note',
] as const

export function pickMerchantConfig(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of MERCHANT_CONFIG_FIELDS) if (body?.[k] !== undefined) out[k] = body[k]
  return out
}

// Caller's GLOBAL profile (merchant_id IS NULL). EXACT union of the two writers,
// verified 2026-07-18:
//   ensureGlobalProfile (store.ts:31, :370) sets: name, email, email_confirmed, referral_code
//   saveCustomerDetails (store.ts:123, via SavedDetails) sets: whatsapp, delivery_address (jsonb)
// user_id is FORCED to the caller server-side; app_role / merchant_id / id / created_at are
// never accepted — service_role bypasses guard_profile_privileges, so this allowlist is the
// only thing stopping a caller from granting themselves superadmin or attaching to another
// merchant via a crafted body (Global Constraint 1).
const PROFILE_FIELDS = [
  'name', 'email', 'email_confirmed', 'referral_code', 'whatsapp', 'delivery_address',
] as const

export function pickProfileFields(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PROFILE_FIELDS) if (body?.[k] !== undefined) out[k] = body[k]
  return out
}
