// Order pricing — the one pure module that turns a cart + context into a money
// breakdown. THE single source of truth for every total the app shows AND every
// total the backend charges: the browser prices to quote, the backend prices to
// commit, and two copies would drift into charging a customer a number they never
// saw. No I/O: the clock, the loaded voucher and the resolved referral are passed in.
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
 *
 * `minOrder`, `expiresAt` and `email` have no columns behind them, so `voucherError`'s
 * `min_order`, `expired` and `not_assigned` branches can never fire. That is #71, deliberately
 * deferred: this task moves the module as-is. The backend never calls `voucherError`, so
 * nothing new starts depending on the dead branches here.
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
  referralDiscount: number
  total: number
}

export interface PriceInput {
  products: PricedProduct[]
  cart: Record<string, number>
  mode: 'pickup' | 'delivery' | 'sameday'
  state?: string | null
  rates: { WM: number; EM: number }
  samedayFee?: number
  resolvedShipping?: number // caller-resolved flat fee; wins over region logic
  voucher?: PricedVoucher | null
  referral?: { amount: number; enabled: boolean } | null
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
  samedayFee = 0,
): number {
  if (mode === 'delivery' && state) return rates[EM_STATES.includes(state) ? 'EM' : 'WM'] || 0
  if (mode === 'sameday') return samedayFee
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
  const shipping = input.resolvedShipping ?? shippingFee(input.mode, input.state, input.rates, input.samedayFee)

  const beforeDiscount = subtotal + shipping
  const discount = voucherDiscount(input.voucher, beforeDiscount)
  const afterVoucher = round2(beforeDiscount - discount)

  const referralDiscount = input.referral?.enabled
    ? Math.min(input.referral.amount, afterVoucher)
    : 0
  const total = round2(afterVoucher - referralDiscount)

  return { lines, subtotal, shipping, discount, referralDiscount, total }
}

export type VoucherErrorCode =
  | 'invalid'
  | 'fully_used'
  | 'already_used'
  | 'not_assigned'
  | 'expired'
  | 'min_order'

export interface VoucherCtx {
  subtotal: number // items + shipping, matching the legacy minOrder gate
  userEmail: string
  now: Date
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
  if (v.email && v.email !== email) return 'not_assigned'
  if (v.expiresAt && new Date(v.expiresAt) < ctx.now) return 'expired'
  if (v.minOrder && ctx.subtotal < v.minOrder) return 'min_order'
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
 * line apart from an `extraLines` line: `priceOrder` appends `extraLines` (e.g. a free referral
 * gift) straight onto `bd.lines`, and a `promo: true` extra line has no row behind it — claiming
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
