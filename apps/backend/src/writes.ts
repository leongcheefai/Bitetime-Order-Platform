import { isTimezone, validateMenuCategories, validateShopDescription, normalizeBrandColor } from '@bitetime/shared'

// Column allowlists for write endpoints. The service-role `admin` client bypasses RLS and the
// guard_merchant_status / guard_profile_privileges triggers, so these picks are the ONLY thing
// stopping privilege escalation. Never spread a raw client body into a DB write — pick from here.

export const ORDER_STATUSES = ['pending_payment', 'new', 'preparing', 'ready', 'completed', 'cancelled']

// Owner-editable shop config. Deliberately EXCLUDES status, owner_id, slug, billing_*, id.
// Mirrors what the browser could safely write under the old RLS+trigger regime. This is the
// union of every updateMerchantConfig call site: ShopSettings.tsx Shipping tab writes
// { shipping, pickup_address, method flags, distance pricing, origin_*, onboarding_shipping_set };
// the Payment tab writes { payment_bank, payment_note, tax_enabled, tax_rate }; the
// Fulfilment tab writes { config, timezone }; and the onboarding checklist (#102) writes
// { onboarding_link_shared } (ShareStorefront) and { onboarding_dismissed } (OnboardingChecklist).
// `shipping` is a jsonb column (shopRates output). `currency` is deliberately NOT here, same as
// `business_nature`: mandatory at signup (app.ts), never editable afterwards — Shop Settings only
// displays it. Re-adding it here would let a direct PATCH re-denominate a shop's past totals,
// which is exactly what the signup-time lock exists to prevent.
const MERCHANT_CONFIG_FIELDS = [
  'shipping', 'pickup_address', 'payment_bank', 'payment_note', 'config', 'timezone',
  'tax_enabled', 'tax_rate',
  // Distance pricing (#101). `pickup_address` deliberately stays a SEPARATE, free-text field:
  // it is the merchant's own directions for pickup customers and is never routed, so an
  // autocomplete result must never overwrite it.
  'pickup_enabled', 'delivery_enabled', 'express_enabled',
  'delivery_base_fee', 'delivery_rate_per_km', 'delivery_max_km',
  'origin_place_id', 'origin_lat', 'origin_lng', 'origin_address',
  // Onboarding checklist flags (#102). Booleans flipped by the merchant's own
  // actions (saving Shipping; sharing the link), the dismiss button, and the
  // one-time spotlight tour marking itself seen.
  'onboarding_shipping_set', 'onboarding_link_shared', 'onboarding_dismissed',
  'onboarding_tour_seen',
  // The DuitNow QR the storefront shows a customer after they order (#156). A Storage PATH in
  // the public `payment-qr` bucket, never a URL — see isOwnStoragePath below for why it is
  // checked against the merchant it is being written for.
  'payment_qr',
  // The sections a merchant arranges their menu into (ADR 0013). A jsonb list; what this
  // allowlist owns is the SHAPE.
  'product_categories',
  // The shop's OWN advertising pixel ids (#220). Public values — they ship in the storefront's
  // page — so they are ordinary config, not a secret.
  'meta_pixel_id', 'tiktok_pixel_id',
  // The line a customer reads under the shop's name. `description_zh` is optional and falls back
  // to the English one, matching every other pair of merchant-authored strings.
  'description', 'description_zh',
  // The shop's one brand colour. The whole storefront palette derives from it in the browser
  // (frontend `brandTheme.ts`); nothing here reads it, because nothing server-side renders a
  // storefront. What this allowlist owns is the SHAPE.
  'brand_color',
] as const

// A Storage object path the given merchant owns: `{merchantId}/{filename}`, one segment deep,
// with the filename limited to the characters the uploader already sanitises to.
//
// The bucket's own RLS policy scopes what a merchant may WRITE (first folder = their id), but
// this column is written through the service role, on a connection no policy runs on — so
// nothing in Postgres stops a crafted PATCH from pointing a shop's row at a stranger's object,
// or at `{me}/../{them}/qr.png`. This function is that check. It also refuses an absolute URL,
// which would otherwise render fine (the storefront resolves the path through getPublicUrl) and
// quietly turn a shop's payment panel into an image hotlinked from anywhere.
// The id is compared as a plain string rather than interpolated into the pattern: `:id` is a URL
// segment, and a regex built out of one is a regex an attacker writes half of.
const STORAGE_FILENAME = /^[A-Za-z0-9._-]+$/
function isOwnStoragePath(value: unknown, merchantId: string): boolean {
  if (typeof value !== 'string' || !merchantId) return false
  const [folder, file, ...rest] = value.split('/')
  if (rest.length > 0 || folder !== merchantId) return false
  // `.` and `..` satisfy STORAGE_FILENAME above (dots are legal in it) and are not filenames.
  if (file === '.' || file === '..') return false
  return STORAGE_FILENAME.test(file ?? '')
}

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
 *
 * `merchantId` is the shop being written (the route's `:id`, already proven to be the caller's by
 * `requireMerchantOwns`). Only `payment_qr` needs it — a Storage path is only valid relative to
 * the merchant that owns the folder — but it is REQUIRED, not optional: an optional tenancy
 * argument is one the next call site forgets, and forgetting it here would write a stranger's
 * path unchecked.
 */
export function pickMerchantConfig(body: any, merchantId: string): PickResult {
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

  // The payment QR (#156). `null` — and the empty string the form sends when the merchant clears
  // it — mean "take it down", the only way back to no QR. Anything else must be a path inside
  // this merchant's own folder; refused, not dropped, because a QR that silently failed to save
  // is a shop showing customers a stale account to pay into.
  if (out.payment_qr !== undefined) {
    if (out.payment_qr === null || out.payment_qr === '') {
      out.payment_qr = null
    } else if (!isOwnStoragePath(out.payment_qr, merchantId)) {
      return { ok: false, error: 'payment_qr must be an uploaded image path belonging to this shop' }
    }
  }

  // Refused, not dropped, for the reason the tax rate is: the merchant is standing in front of a
  // colour picker, and a silent drop hands them a success toast and the colour they already had.
  // The rule itself lives in @bitetime/shared, so the picker and this endpoint cannot disagree.
  if (out.brand_color !== undefined) {
    const brand = normalizeBrandColor(out.brand_color)
    if (!brand.ok) return { ok: false, error: 'brand_color must be a hex colour like #7A1028' }
    out.brand_color = brand.value
  }

  // Real booleans, not truthiness: these columns are `boolean not null`, and a coerced 'false'
  // or 0 would switch a method on that the merchant switched off.
  for (const key of [
    'pickup_enabled', 'delivery_enabled', 'express_enabled',
    'onboarding_shipping_set', 'onboarding_link_shared', 'onboarding_dismissed',
    'onboarding_tour_seen',
  ] as const) {
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

  // Menu categories (ADR 0013). REFUSED, never dropped, for the reason `tax_rate` is: the jsonb
  // column holds only that this is an array, so a list that failed to save silently is a merchant
  // watching their menu structure not stick behind a success toast. The validator is the only
  // thing standing between a request body and the column, and naming its verdict in the error is
  // what makes a 400 here debuggable — the alternative is a bare "Update failed" 500 from the
  // one constraint Postgres does hold.
  if (out.product_categories !== undefined) {
    const bad = validateMenuCategories(out.product_categories)
    if (bad) return { ok: false, error: `product_categories is invalid: ${bad}` }
  }

  // The shop's own blurb. Refused rather than truncated: a cap is a rule the merchant can see
  // while they type (the card counts against the same SHOP_DESCRIPTION_MAX), so a request that
  // breaks it did not come from the card, and silently cutting a sentence in half would put a
  // merchant's own words wrong on their own storefront.
  for (const key of ['description', 'description_zh'] as const) {
    if (out[key] === undefined) continue
    const bad = validateShopDescription(out[key])
    if (bad) return { ok: false, error: `${key} is invalid: ${bad}` }
    // '' is what the card sends when the merchant clears the field; null is what a non-UI caller
    // would send. Both mean "take it down", and both must land as null so the column never holds
    // two spellings of "no description".
    const trimmed = (out[key] as string | null)?.trim() ?? ''
    out[key] = trimmed === '' ? null : trimmed
  }

  // The shop's own advertising pixel ids (#220). Refused, never coerced, for the reason every
  // field above is — but the failure this one prevents is quieter than most: a wrong id reports
  // to nowhere and looks exactly like a working pixel until a campaign has already run.
  for (const [key, shape] of [['meta_pixel_id', META_PIXEL_ID], ['tiktok_pixel_id', TIKTOK_PIXEL_ID]] as const) {
    if (out[key] === undefined) continue
    // '' is what the settings form sends when the merchant clears the field, and null is what a
    // non-UI caller would send. Both mean "take it down" — the ONLY way back to no pixel, and
    // and the only way back to no pixel at all.
    if (out[key] === null || (typeof out[key] === 'string' && (out[key] as string).trim() === '')) {
      out[key] = null
      continue
    }
    const trimmed = typeof out[key] === 'string' ? (out[key] as string).trim() : out[key]
    if (typeof trimmed !== 'string' || !shape.test(trimmed)) {
      return { ok: false, error: `${key} does not look like a pixel id` }
    }
    out[key] = trimmed
  }

  return { ok: true, patch: out }
}

// What each vendor's id looks like — a TYPO FILTER, not a proof that the pixel exists. Meta's is
// a 15- or 16-digit number; TikTok's is 20 upper-case alphanumerics. Neither vendor publishes a
// grammar, so these are drawn from the ids the vendors' own dashboards issue, and they are
// deliberately loose enough to accept an id we have not seen and tight enough to refuse the
// thing merchants actually paste by mistake: an ad ACCOUNT id, a whole snippet, or a URL.
const META_PIXEL_ID = /^\d{15,16}$/
const TIKTOK_PIXEL_ID = /^[A-Z0-9]{20}$/

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
// `category_id` (ADR 0013) is which section this product sits in — a plain text id pointing into
// `merchants.product_categories`, with no foreign key behind it. NOT validated against the shop's
// list here on purpose: an id the list no longer holds is the load-bearing "uncategorized"
// reading, not an error, and checking it would need the merchant row on a path that does not read
// one.
const PRODUCT_FIELDS = [
  'id', 'name', 'name_zh', 'descr', 'price', 'unit', 'unit_quantity', 'active',
  'image_urls', 'promo_price', 'promo_limit', 'promo_end', 'option_groups', 'category_id',
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
//   setOrderFulfilDate writes { fulfil_date: 'YYYY-MM-DD' } — a non-empty string only. There is
//     no way to CLEAR it: a null date means "placed before #91", a fact and not a choice, and a
//     merchant cannot turn a scheduled order back into one. Whether the day is one the shop's
//     clock allows is patchOrder's call, judged under the row lock; only the shape is read here.
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
  if (typeof body?.fulfil_date === 'string' && body.fulfil_date.trim()) out.fulfil_date = body.fulfil_date.trim()
  return out
}
