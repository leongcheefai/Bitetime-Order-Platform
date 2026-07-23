import { isTimezone } from '@bitetime/shared'

// Column allowlists for write endpoints. The service-role `admin` client bypasses RLS and the
// guard_merchant_status / guard_profile_privileges triggers, so these picks are the ONLY thing
// stopping privilege escalation. Never spread a raw client body into a DB write — pick from here.

export const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

// Owner-editable shop config. Deliberately EXCLUDES status, owner_id, slug, plan, billing_*, id.
// Mirrors what the browser could safely write under the old RLS+trigger regime. This is the
// EXACT union of the THREE updateMerchantConfig call sites (ShopSettings.tsx:141 writes
// { currency?, shipping, pickup_address }; :243 writes { payment_bank, payment_note }; the Tax
// tab (#88 Task 4) writes { tax_enabled, tax_rate }) — verified 2026-07-20. `shipping` is a
// jsonb column (shopRates output); `currency` is dropped client-side once locked, but allowlist
// it anyway — the lock is a UI concern, and the currency column is not a privilege.
const MERCHANT_CONFIG_FIELDS = [
  'currency', 'shipping', 'pickup_address', 'payment_bank', 'payment_note', 'config', 'timezone',
  'tax_enabled', 'tax_rate',
  // Distance pricing (#101). `pickup_address` deliberately stays a SEPARATE, free-text field:
  // it is the merchant's own directions for pickup customers and is never routed, so an
  // autocomplete result must never overwrite it.
  'pickup_enabled', 'delivery_enabled', 'express_enabled',
  'delivery_base_fee', 'delivery_rate_per_km', 'delivery_max_km',
  'origin_place_id', 'origin_lat', 'origin_lng', 'origin_address',
] as const

// `undefined` means "not being written" and passes through untouched; a present-but-invalid
// value is REFUSED (see pickMerchantConfig's doc below), never coerced.
export type PickResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * `undefined` means "not being written" and passes through untouched. A present-but-invalid
 * value is REFUSED, never coerced or silently dropped — unlike `timezone` below, a bad tax rate
 * must not save silently: the merchant would see a success toast and charge nothing (or the
 * wrong thing), because the column's own CHECK would otherwise answer with a bare 500 from deep
 * inside PostgREST, long after the merchant who typed 150 has moved on.
 */
export function pickMerchantConfig(body: any): PickResult {
  const out: Record<string, unknown> = {}
  for (const k of MERCHANT_CONFIG_FIELDS) if (body?.[k] !== undefined) out[k] = body[k]
  // A timezone is not free text: `todayInZone` feeds it to Intl on EVERY order intake, and a
  // row holding junk would decide the shop's "today" by falling back — silently moving the
  // earliest date a customer can pick, for every order, with nothing on screen to say why.
  // Refused at the door instead, where the merchant is present to see it.
  if (out.timezone !== undefined && !isTimezone(out.timezone)) delete out.timezone
  if (out.tax_rate !== undefined) {
    // A blank/whitespace string must be REFUSED, not coerced: Number('') and Number('   ')
    // are both 0. This is NOT what the frontend sends — ShopSettings.tsx sends
    // `Number(fields.taxRate) || 0`, a number, and a blank field already collapses to 0 client
    // side before it ever reaches this endpoint — but this route is public, and any other
    // (non-UI) caller can send a raw string. Without this guard, that caller's cleared/blank
    // field would silently save a 0% rate and report success instead of the "tax is now off"
    // surprise it actually is.
    if (typeof out.tax_rate === 'string' && out.tax_rate.trim() === '') {
      return { ok: false, error: 'tax_rate must be a number between 0 and 100' }
    }
    const rate = typeof out.tax_rate === 'string' ? Number(out.tax_rate) : out.tax_rate
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return { ok: false, error: 'tax_rate must be a number between 0 and 100' }
    }
    // The column is `numeric(5,2)` — it can only STORE 2 decimal places. A rate that does not
    // survive a round-trip at 2 decimals (100.005, 6.567) would otherwise pass this allowlist,
    // get silently rounded by Postgres on write (6.567 → 6.57), and a rounded-up rate like
    // 100.005 → 100.01 can even trip `merchants_tax_rate_range`, surfacing as app.ts's bare
    // `{error: 'Update failed'}` 500 instead of the 400 this allowlist exists to produce.
    // Refused, never coerced — rounding it here ourselves would just move the silent-drift bug
    // from Postgres to us.
    if (Number(rate.toFixed(2)) !== rate) {
      return { ok: false, error: 'tax_rate must not have more than 2 decimal places' }
    }
    out.tax_rate = rate
  }
  if (out.tax_enabled !== undefined && typeof out.tax_enabled !== 'boolean') {
    return { ok: false, error: 'tax_enabled must be a boolean' }
  }

  // Real booleans, not truthiness: these columns are `boolean not null`, and a coerced 'false'
  // or 0 would switch a method on that the merchant switched off.
  for (const key of ['pickup_enabled', 'delivery_enabled', 'express_enabled'] as const) {
    if (out[key] !== undefined && typeof out[key] !== 'boolean') {
      return { ok: false, error: `${key} must be a boolean` }
    }
  }

  // A negative fee is a delivery that PAYS the customer. Refused at the door, where the merchant
  // is present to see it, rather than as a bare 500 out of the column's own CHECK.
  for (const key of ['delivery_base_fee', 'delivery_rate_per_km'] as const) {
    if (out[key] === undefined) continue
    // Same trap as tax_rate above: Number('') and Number('   ') are both 0, so a blank string
    // must be refused explicitly rather than falling through to the finite-number check below,
    // which would happily accept the coerced 0.
    if (typeof out[key] === 'string' && (out[key] as string).trim() === '') {
      return { ok: false, error: `${key} must be a number of 0 or more` }
    }
    const n = typeof out[key] === 'string' ? Number(out[key]) : out[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return { ok: false, error: `${key} must be a number of 0 or more` }
    }
    out[key] = n
  }

  // null is the ONLY way to say "no limit". A 0 is an honest "deliver nowhere" and the two must
  // not collide, so 0 is refused rather than quietly read as unlimited. Unlike the fee fields
  // above, a blank string needs no separate check: Number('') coerces to 0, and 0 is refused by
  // the `n <= 0` test below anyway — coercing '' would never slip a false "no limit" through.
  if (out.delivery_max_km !== undefined && out.delivery_max_km !== null) {
    const n = typeof out.delivery_max_km === 'string' ? Number(out.delivery_max_km) : out.delivery_max_km
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'delivery_max_km must be a positive number, or null for no limit' }
    }
    out.delivery_max_km = n
  }

  return { ok: true, patch: out }
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

// Product upsert. EXACT union of what ProductsManager.tsx actually writes, verified
// 2026-07-18 against apps/backend/supabase/migrations (20260627120000_multitenant_schema.sql,
// 20260703183731_product_images.sql, 20260703215939_product_unit_enum.sql,
// 20260704000000_product_unit_quantity.sql, 20260714200000_product_promo.sql):
//   editing (ProductsManager.tsx:230) spreads the WHOLE existing row (id, merchant_id, name,
//     name_zh, descr, descr_zh, price, unit, sort, active, created_at, image_urls, promo_*,
//     unit_quantity) then overwrites with the form fields + promoFields() + image_urls/price/
//     unit_quantity;
//   adding (ProductsManager.tsx:237) writes name, name_zh, descr, price, unit, unit_quantity,
//     active, promo_price/promo_limit/promo_end, id (draftId), image_urls, merchant_id;
//   setProductImages (ProductsManager.tsx:268) spreads the whole row + a new image_urls.
// `id` is kept here per the task's allowlist contract even though the route ALWAYS overrides
// it with `:productId` afterwards — it is never trusted from this pick alone.
// merchant_id is FORCED from the route `:id` and is never accepted from the body — the caller
// passes it in these call sites only because they always also set the URL from the same value.
// `sort`, `created_at` and `descr_zh` are deliberately EXCLUDED: no call site sets them
// intentionally, and since upsert's ON CONFLICT DO UPDATE only touches columns present in the
// payload, dropping them here leaves an edited row's existing values untouched anyway.
// `promo_sold` is the load-bearing exclusion: it is an anti-double-discount counter that
// `products_promo_sold_guard` pins for every role EXCEPT service_role/postgres/supabase_admin —
// and this handler writes through `admin` (service_role), so that trigger no longer protects it.
// The full-row spread on edit carries a `promo_sold` value along for the ride, and this
// allowlist dropping it silently is now the ONLY thing stopping a crafted body from resetting or
// inflating a promo's sold counter (Global Constraint 1).
const PRODUCT_FIELDS = [
  'id', 'name', 'name_zh', 'descr', 'price', 'unit', 'unit_quantity', 'active',
  'image_urls', 'promo_price', 'promo_limit', 'promo_end',
] as const

export function pickProductFields(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PRODUCT_FIELDS) if (body?.[k] !== undefined) out[k] = body[k]
  return out
}

// Order patch. EXACT union of the three writers in OrdersView.tsx (via store.ts), verified
// 2026-07-18:
//   setOrderStatus (store.ts:662) writes { status } — checked against ORDER_STATUSES
//     client-side already, but that is not a security boundary, so the handler re-validates.
//   setOrderNote (store.ts:670) writes { note: trimmed || null }.
//   setOrderTracking (store.ts:678) writes { courier: courier || null, awb: trimmed || null }.
// Nothing else is accepted — in particular `total`, `user_id`, `order_number`, `merchant_id`
// stay out: the update goes through `admin` (service_role) with no RLS or trigger backstop,
// so this allowlist plus the handler's forced `merchant_id === :id` check (Global Constraint 2)
// are the only things stopping a crafted body from rewriting an order's price or attribution.
export function pickOrderFields(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (body?.status !== undefined) out.status = body.status
  if (body?.note !== undefined) out.note = String(body.note ?? '').trim() || null
  if (body?.courier !== undefined) out.courier = body.courier || null
  if (body?.awb !== undefined) out.awb = String(body.awb ?? '').trim() || null
  return out
}
