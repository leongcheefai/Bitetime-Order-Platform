// Order pricing — the one pure module that turns a cart + context into a money
// breakdown. THE single source of truth for every total the app shows AND every
// total the backend charges: the browser prices to quote, the backend prices to
// commit, and two copies would drift into charging a customer a number they never
// saw. No I/O: the clock and the loaded voucher are passed in.
// See CONTEXT.md → "Order pricing".

/**
 * Only the fields the pricing rule reads. Declared here rather than imported because this package
 * is the boundary between the two workspaces: a frontend `Product` row and a backend `products`
 * row must both satisfy it, and neither owns it.
 *
 * The promo fields are DECLARED, not reached through the index signature: they are real columns
 * now (#69), and a typo'd `promoPrice` silently pricing at base is exactly what the index
 * signature used to hide.
 */
export interface PricedProduct {
  id: string
  name: string
  price: number
  /** null = no promo. **0 is a valid promo** (a free item) — test for null, never truthiness. */
  promoPrice?: number | null
  /** null = uncapped. */
  promoLimit?: number | null
  /** An ISO INSTANT, never a local date string. See the migration's comment. */
  promoEnd?: string | null
  promoSold?: number
  [key: string]: unknown
}

/**
 * A voucher as the discount math needs it — `type` and `value` are the mapped names, NOT the
 * `kind`/`amount` columns. `voucherFromRow` (Task 2) is what maps one to the other, and both
 * sides of the wire must go through it or the discount diverges on shape alone.
 */
export interface PricedVoucher {
  code: string
  type?: string
  value?: number
  maxUses?: number | string | null
  usedBy?: string[]
  [key: string]: unknown
}

export interface PriceLine {
  id: string
  name: string
  qty: number
  unitPrice: number
  lineTotal: number
  promo: boolean
}

export interface PriceBreakdown {
  lines: PriceLine[]
  subtotal: number
  shipping: number
  discount: number
  /** Money. 0 when the shop charges no tax. */
  tax: number
  /** The percentage that produced `tax` — 6 means 6%. 0 when the shop charges no tax.
   *  Stored on the order and used to LABEL the line, because `tax` alone cannot say "6%". */
  taxRate: number
  total: number
  /**
   * TRUE when the mode is `express` and no fee could be derived — either no routed distance is
   * known yet or the shop's distance configuration cannot price.
   *
   * `shipping` is 0 in that state and IS NOT A FEE. The storefront must say the fee is not yet
   * calculated and block submission; the backend refuses before it ever prices in this state.
   * Reading the 0 as a fee is precisely the invented number this feature must never produce.
   */
  shippingPending: boolean
}

export interface PriceInput {
  products: PricedProduct[]
  cart: Record<string, number>
  /**
   * Which method the customer chose. An ALLOWLIST, and it is a price rule: `mode` selects the
   * shipping fee, so any unrecognised value prices shipping at 0.
   *
   * `delivery` is the flat region rate; `express` is distance-priced. Both may be offered by the
   * same shop — see `shopMethods`.
   */
  mode: FulfilmentMethod
  state?: string | null
  rates: { WM: number; EM: number }
  resolvedShipping?: number // caller-resolved flat fee; wins over region logic
  voucher?: PricedVoucher | null
  /** The shop's tax, mapped through `shopTax`. Absent means no tax. */
  tax?: ShopTax
  /**
   * The shop's shipping policy, mapped through `shopDistance`. Absent = region pricing, which is
   * every shop today.
   */
  distance?: ShopDistance
  /**
   * The routed road distance for THIS delivery, in metres. NEVER read from a request body — it
   * is resolved from the distance cache (see the backend's `resolveDistance`).
   *
   * `null`/absent on a distance-priced delivery is NOT zero shipping: the breakdown comes back
   * with `shippingPending: true` and no fee, and the caller refuses rather than pricing.
   */
  routedMetres?: number | null
  extraLines?: PriceLine[]
  // NO promoSold input. The count is a column on the product row, and a second channel for it is
  // a second thing to diverge — the browser quotes and the backend charges from the same row.
  now?: Date
}

const round2 = (n: number) => parseFloat(n.toFixed(2))

export const EM_STATES = ['Sabah', 'Sarawak', 'W.P. Labuan']

export function shippingFee(
  mode: PriceInput['mode'],
  state: string | null | undefined,
  rates: { WM: number; EM: number },
): number {
  if (mode === 'delivery' && state) return rates[EM_STATES.includes(state) ? 'EM' : 'WM'] || 0
  return 0
}

/** The `merchants.shipping` column's own default for West Malaysia — see `shopRates`. */
export const DEFAULT_WM_RATE = 8

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/**
 * A `merchants.shipping` jsonb value → the rates `priceOrder` reads.
 *
 * BOTH sides of the wire go through here, and that is not tidiness: the browser prices to
 * quote and the backend prices to commit, and the backend now REFUSES a quote it disagrees
 * with (`price_changed`). Two fallback rules would not be a rounding difference — a row that
 * ever lacked an `EM` key would refuse every East-Malaysia delivery outright.
 *
 * The fallbacks, chosen rather than inherited:
 *   * a missing or unusable `WM` falls back to DEFAULT_WM_RATE — the column's own default
 *     (`'{"WM":8,"EM":18}'`), which is what every existing row already carries;
 *   * a missing or unusable `EM` falls back to `WM`. A shop that named one rate charges that
 *     rate everywhere. Falling back to 0 would ship to East Malaysia for FREE — a fee zeroed
 *     by a value nobody chose, which is the exact species of bug this module exists to close.
 *
 * Both match what the storefront already quotes, so adopting them moves no customer-visible
 * number today; they only decide what happens to a row that is missing a key.
 */
export function shopRates(shipping: unknown): { WM: number; EM: number } {
  const s = (shipping && typeof shipping === 'object' ? shipping : {}) as Record<string, unknown>
  const WM = num(s.WM) ?? DEFAULT_WM_RATE
  const EM = num(s.EM) ?? WM
  return { WM, EM }
}

export interface ShopTax {
  enabled: boolean
  /** A PERCENTAGE, not a fraction: 6 means 6%. */
  rate: number
}

/**
 * A merchant row → the tax `priceOrder` charges. The twin of `shopRates`, and it exists for
 * the same reason: the browser quotes and the backend charges, and a disagreement between
 * them is not a rounding gap — it is a `price_changed` refusal for every order at that shop.
 *
 * The `enabled` fallback is always OFF: a shop that never configured tax, or an unparseable
 * rate, must fail to NO tax rather than to a number nobody chose — the same direction
 * `shopRates` fails in, for the same reason. `rate` is only zeroed alongside it when there is
 * no usable rate to keep; a disabled shop's own stored rate is otherwise passed through
 * unchanged, because it is what keeps that rate visible in the merchant's own (disabled) field
 * after they untick "charge tax" — `shopTax({tax_enabled: false, tax_rate: 6})` returns
 * `{enabled: false, rate: 6}`, not `{enabled: false, rate: 0}`.
 *
 * `num()` is not defensiveness: postgres.js returns `numeric` as a STRING ('6.00') while
 * PostgREST returns a number (6).
 *
 * An enabled 0% is normalised to disabled. They charge the same money, and collapsing them
 * here means every consumer has ONE thing to test instead of two that must agree.
 */
export function shopTax(row: unknown): ShopTax {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const rate = num(r.tax_rate)
  if (rate === null || rate <= 0) return { enabled: false, rate: 0 }
  return { enabled: r.tax_enabled === true, rate }
}

export interface ShopDistance {
  /** Express delivery is switched on for this shop. Its configuration stays stored when off. */
  enabled: boolean
  /**
   * @deprecated Derived from `enabled` purely so #103's cascade can land in small commits.
   * Delete this field, and its last readers, in Task 10.
   */
  mode: 'region' | 'distance'
  base: number
  ratePerKm: number
  /** null = no limit. Never 0 — a 0 would be an honest "deliver nowhere". */
  maxKm: number | null
  originPlaceId: string | null
  /**
   * Express enabled AND a configuration complete enough to price with. Meaningless when express
   * is off.
   *
   * FALSE IS A REFUSAL, NOT A FALLBACK. An express shop whose rate is missing, negative or
   * unparseable does not quote 0 shipping and does not fall back to its dormant region rate —
   * that would charge by a formula the merchant switched off, under a receipt line that cannot
   * honestly name a distance. It quotes nothing and the caller refuses the delivery.
   */
  usable: boolean
}

/**
 * A merchant row → the distance policy `priceOrder` charges. The third of `shopRates`'
 * and `shopTax`'s family, and it exists for the identical reason: the browser quotes and the
 * backend charges, and a disagreement between them is a `price_changed` refusal for every
 * order at that shop, not a rounding gap.
 *
 * `num()` is not defensiveness — postgres.js returns `numeric` as a STRING ('6.00') while
 * PostgREST returns a number (6). These are `numeric` columns and inherit that trap exactly.
 *
 * The fallback direction is always toward REFUSAL (`usable: false`), never toward a number
 * nobody chose. That is the same direction `shopTax` fails in, for the same reason.
 */
export function shopDistance(row: unknown): ShopDistance {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const enabled = r.express_enabled === true
  const base = num(r.delivery_base_fee)
  const ratePerKm = num(r.delivery_rate_per_km)
  const maxKmRaw = num(r.delivery_max_km)
  const originPlaceId = typeof r.origin_place_id === 'string' && r.origin_place_id ? r.origin_place_id : null

  const usable =
    enabled &&
    originPlaceId !== null &&
    base !== null && base >= 0 &&
    ratePerKm !== null && ratePerKm >= 0 &&
    (r.delivery_max_km == null || (maxKmRaw !== null && maxKmRaw > 0))

  return {
    enabled,
    mode: enabled ? 'distance' : 'region',
    base: base ?? 0,
    ratePerKm: ratePerKm ?? 0,
    maxKm: maxKmRaw !== null && maxKmRaw > 0 ? maxKmRaw : null,
    originPlaceId,
    usable,
  }
}

/**
 * Routed metres → the kilometres the fee is charged on, rounded to ONE decimal.
 *
 * THE ROUNDING HAPPENS HERE, BEFORE THE RATE MULTIPLIES IT, and that order is part of the
 * customer-facing contract, not cosmetics: the receipt line reads `Delivery Fee (25.2 km)`, so
 * the km on the line must be the km that produced the money. Rounding afterwards prints 25.2 km
 * beside a fee derived from 25.216, and a line that does not reconcile on a calculator is a
 * support ticket.
 */
export function routedKm(metres: number): number {
  return parseFloat((metres / 1000).toFixed(1))
}

/** `base + rate × km`, rounded to money. `km` must already have been through `routedKm`. */
export function distanceFee(policy: ShopDistance, km: number): number {
  return round2(policy.base + policy.ratePerKm * km)
}

/** Beyond the shop's maximum? Inclusive at the cap — exactly `maxKm` still delivers. */
export function exceedsMaxKm(policy: ShopDistance, km: number): boolean {
  return policy.maxKm !== null && km > policy.maxKm
}

/** The three things a customer can choose. A closed set: `mode` selects the shipping fee. */
export type FulfilmentMethod = 'pickup' | 'delivery' | 'express'

/** Precedence order, and the order the storefront renders them in. */
export const FULFILMENT_METHODS: readonly FulfilmentMethod[] = ['pickup', 'delivery', 'express']

export interface ShopMethods {
  pickup: boolean
  /** Flat region rate (WM/EM). */
  delivery: boolean
  /** Distance-priced: `base + rate × routed km`. Read the rates through `shopDistance`. */
  express: boolean
}

/**
 * A merchant row → the methods this shop offers. The fourth of `shopRates`', `shopTax`'s and
 * `shopDistance`'s family, and it exists for the identical reason: the storefront decides which
 * buttons to render from it and the backend refuses an unoffered method from it, and the two
 * disagreeing is a refused checkout, not a cosmetic gap.
 *
 * A NON-BOOLEAN reads as absent, so it takes that column's own default. Both drivers hand these
 * columns back as real booleans, so anything else is a fixture or a bug — and coercing `'false'`
 * or `0` is how a shop starts offering a method its merchant switched off.
 *
 * ALL THREE FALSE IS RETURNED AS-IS. It is not repaired into pickup: a shop that offers nothing
 * takes no order, and the callers refuse. That is the same direction `ShopDistance.usable` fails
 * in, for the same reason. `merchants_one_fulfilment_method` makes it unconstructible anyway.
 */
export function shopMethods(row: unknown): ShopMethods {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  return {
    pickup: flag(r.pickup_enabled, true),
    delivery: flag(r.delivery_enabled, true),
    express: flag(r.express_enabled, false),
  }
}

/** Does this shop offer the method the customer asked for? Any other string is not a method. */
export function offersMethod(methods: ShopMethods, mode: string): boolean {
  return (FULFILMENT_METHODS as readonly string[]).includes(mode)
    && methods[mode as FulfilmentMethod]
}

/**
 * The method a storefront lands on. `null` when the shop offers none — which is a REFUSAL to
 * take an order, never a reason to invent pickup.
 */
export function firstOfferedMethod(methods: ShopMethods): FulfilmentMethod | null {
  return FULFILMENT_METHODS.find(m => methods[m]) ?? null
}

export function priceOrder(input: PriceInput): PriceBreakdown {
  const now = input.now ?? new Date()

  const lines: PriceLine[] = []
  for (const id of Object.keys(input.cart)) {
    const qty = input.cart[id] || 0
    if (qty <= 0) continue
    const product = input.products.find(p => p.id === id)
    if (!product) continue

    // THE CAP BINDS PER UNIT, so one cart product can produce TWO lines at two prices. A cart of
    // 10 against 3 remaining promo units is 3 + 7 — all-or-nothing would let a cap of 3 sell 100
    // promo units to a single order, which is not a cap. Two lines share a product id: any list
    // rendering these must key by INDEX.
    const promo = promoState(product, now)
    const promoQty = promo ? Math.min(qty, promo.remaining) : 0

    if (promo && promoQty > 0) {
      lines.push({
        id, name: product.name, qty: promoQty,
        unitPrice: promo.price, lineTotal: round2(promo.price * promoQty), promo: true,
      })
    }
    const baseQty = qty - promoQty
    if (baseQty > 0) {
      lines.push({
        id, name: product.name, qty: baseQty,
        unitPrice: product.price, lineTotal: round2(product.price * baseQty), promo: false,
      })
    }
  }
  if (input.extraLines) lines.push(...input.extraLines)

  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0))

  // `resolvedShipping` still wins, and it is DELIBERATELY not the channel distance pricing uses:
  // that override exists so the storefront can show a region placeholder before a state is known,
  // and routing a real charge through it would put the fee formula back in the callers — the one
  // thing this module exists to prevent.
  // The fee rule follows the METHOD the customer chose, not a policy on the shop: one shop can
  // offer flat-rate `delivery` and distance-priced `express` side by side (#103).
  const distancePriced = input.mode === 'express'
  const canPriceDistance =
    distancePriced && input.distance!.usable &&
    // `>= 0`, not merely finite: a NEGATIVE distance would price the delivery DOWNWARDS — a
    // reduced fee derived from a number nobody chose, which is the exact failure direction this
    // module refuses in. Unreachable today (metres come from the distance cache, whose column is
    // `check (metres >= 0)`, never from a request body) and guarded anyway, because the fee is
    // money and the guard costs nothing.
    input.routedMetres != null && Number.isFinite(input.routedMetres) && input.routedMetres >= 0
  const shippingPending = distancePriced && !canPriceDistance
  const shipping = input.resolvedShipping ?? (
    canPriceDistance
      ? distanceFee(input.distance!, routedKm(input.routedMetres as number))
      : shippingPending
        ? 0
        : shippingFee(input.mode, input.state, input.rates)
  )

  const beforeDiscount = subtotal + shipping
  const discount = voucherDiscount(input.voucher, beforeDiscount)

  // Tax is the LAST step, and its base is `subtotal − discount` — NOT `beforeDiscount`.
  // Shipping is not taxed (the shop sells food, the courier sells delivery), and the customer
  // is not taxed on money a voucher took off. The clamp is not defensiveness: a fixed voucher
  // is `min(value, subtotal + shipping)`, so it CAN exceed the subtotal alone — and an
  // unclamped base is then a NEGATIVE tax, a tax that pays the customer.
  //
  // Note what is NOT changed: `discount` is still computed on `subtotal + shipping`. Moving
  // that base would shift every existing shop's totals for a feature they never turned on.
  const tax = input.tax?.enabled
    ? round2((Math.max(0, round2(subtotal - discount)) * input.tax.rate) / 100)
    : 0
  const taxRate = input.tax?.enabled ? input.tax.rate : 0

  const total = round2(beforeDiscount - discount + tax)

  return { lines, subtotal, shipping, discount, tax, taxRate, total, shippingPending }
}

export type VoucherErrorCode =
  | 'invalid'
  | 'fully_used'
  | 'already_used'

export interface VoucherCtx {
  userEmail: string
  fullyUsed?: boolean // caller precomputes via store.voucherFullyUsed
}

// Pure voucher rules. Loading the codes stays I/O in the caller; the rules are
// testable without a network. Returns the first applicable error code, or null.
export function voucherError(voucher: PricedVoucher | null | undefined, ctx: VoucherCtx): VoucherErrorCode | null {
  if (!voucher) return 'invalid'
  const email = (ctx.userEmail ?? '').toLowerCase()
  const v = voucher as any
  if (ctx.fullyUsed) return 'fully_used'
  if ((v.usedBy || []).includes(email)) return 'already_used'
  return null
}

function voucherDiscount(voucher: PricedVoucher | null | undefined, base: number): number {
  if (!voucher) return 0
  if ((voucher as any).type === 'percent') return round2((base * (voucher as any).value) / 100)
  return Math.min((voucher as any).value, base)
}

/** A promo that is currently running, and how many units of it are left. */
export interface PromoState {
  price: number
  /** Infinity when the promo is uncapped. */
  remaining: number
}

/**
 * Is this product's promo running, and for how many more units?
 *
 * The null checks are load-bearing and are not defensiveness: a promo of `0.00` is a FREE ITEM,
 * and a truthiness test (`if (!p.promoPrice)`) would silently price it at the base price. A promo
 * exists iff the column is not null.
 */
export function promoState(p: PricedProduct, now: Date): PromoState | null {
  const price = num(p.promoPrice)
  if (price === null) return null
  if (p.promoEnd) {
    const end = new Date(p.promoEnd)
    // An unparseable end date must FAIL CLOSED (no promo), never "runs forever": every NaN
    // comparison (`now > NaN-date`) is false, so a bad string would otherwise sail through.
    if (isNaN(end.getTime())) return null
    if (now > end) return null // inclusive: a promo is still live at exactly promo_end
  }

  const limit = num(p.promoLimit)
  if (limit === null) return { price, remaining: Infinity }   // uncapped, and that is a choice

  const remaining = Math.max(0, limit - (num(p.promoSold) ?? 0))
  return remaining > 0 ? { price, remaining } : null
}

/**
 * How many units of each product this breakdown claims at the promo price — what the backend
 * increments `promo_sold` by, and nothing else. The units claimed are exactly the units priced.
 *
 * `products` (pass `input.products`, the same array given to `priceOrder`) is what tells a cart
 * line apart from an `extraLines` line: `priceOrder` appends `extraLines` (e.g. a free gift
 * line) straight onto `bd.lines`, and a `promo: true` extra line has no row behind it — claiming
 * it would `update products set promo_sold = promo_sold + 1 where id = <an id that need not
 * exist>`. Only ids that came from the cart (i.e. appear in `products`) are ever claimed.
 */
export function promoClaims(bd: PriceBreakdown, products: PricedProduct[]): Record<string, number> {
  const ids = new Set(products.map(p => p.id))
  const claims: Record<string, number> = {}
  for (const l of bd.lines) {
    if (l.promo && ids.has(l.id)) claims[l.id] = (claims[l.id] ?? 0) + l.qty
  }
  return claims
}

/**
 * A `products` row → the shape the pricing rule reads. Both sides of the wire go through here.
 *
 * `num()` is not defensive: postgres.js returns `numeric` as a STRING to preserve precision, so on
 * the backend `price` arrives as '13.00' and `promo_price` as '8.00', while PostgREST hands the
 * browser real numbers. Two sides mapping differently is not a rounding gap — it is a refused
 * checkout (`price_changed`) for every promo order.
 *
 * The row is spread through, so the caller keeps the fields pricing does not read (`image_urls`,
 * `unit`, `active`, …).
 *
 * `price` is `numeric not null` in Postgres, so a missing/unparseable value is unreachable from
 * a real row — but it is also the one field where "default to 0" means FREE, and this mapper is
 * the module's public front door. A `select` that forgets the column throws here, loudly, rather
 * than shipping every item at RM0.
 *
 * `promo_end` maps to `null` (no promo end, not "no promo") when it is unparseable: unreachable
 * from a real `timestamptz` column, but `new Date('garbage').toISOString()` throws a `RangeError`
 * mid-checkout otherwise — a 500 where the answer should be a plain refusal.
 */
export function productFromRow(row: Record<string, unknown>): PricedProduct {
  const price = num(row.price)
  if (price === null) {
    throw new Error(`productFromRow: missing/unparseable price for product ${String(row.id)}`)
  }
  const end = row.promo_end
  const promoEnd = end ? new Date(end as string | Date) : null
  return {
    ...row,
    id: row.id as string,
    name: row.name as string,
    price,
    promoPrice: num(row.promo_price),
    promoLimit: num(row.promo_limit),
    // postgres.js hands back a Date; PostgREST hands back an ISO string. `new Date` takes both.
    promoEnd: promoEnd && !isNaN(promoEnd.getTime()) ? promoEnd.toISOString() : null,
    promoSold: num(row.promo_sold) ?? 0,
  }
}

/**
 * A `vouchers` row → the shape the discount math reads. The column names (`kind`, `amount`,
 * `max_uses`, `used_by`) and the field names (`type`, `value`, `maxUses`, `usedBy`) are not
 * the same, and BOTH sides of the wire go through here so neither has to know that.
 *
 * `Number(row.amount)` is not defensive: postgres.js returns `numeric` as a STRING to keep
 * precision, so on the backend `amount` arrives as '10.00'. Unmapped, it reaches `round2`'s
 * `.toFixed()` and throws.
 */
export function voucherFromRow(row: Record<string, unknown>): PricedVoucher {
  return {
    id: row.id as string | undefined,
    code: row.code as string,
    type: row.kind as string,               // 'percent' | 'fixed'
    value: Number(row.amount),
    maxUses: (row.max_uses ?? null) as number | null,
    usedBy: Array.isArray(row.used_by) ? (row.used_by as string[]) : [],
  }
}
