// Order pricing — the one pure module that turns a cart + context into a money
// breakdown. THE single source of truth for every total the app shows AND every
// total the backend charges: the browser prices to quote, the backend prices to
// commit, and two copies would drift into charging a customer a number they never
// saw. No I/O: the clock, the loaded voucher and the resolved referral are passed in.
// See CONTEXT.md → "Order pricing".

/**
 * Only the fields the pricing rule actually reads. Declared here rather than imported
 * because this package is the boundary between the two workspaces: a frontend `Product`
 * row and a backend `products` row must both satisfy it, and neither owns it.
 *
 * The index signature is what lets `promoActive` reach `promoPrice`/`promoLimit`/`promoEnd`.
 * Those columns DO NOT EXIST yet — the promo feature is #69 — so that branch is inert. It is
 * carried over unchanged rather than deleted, because #69 is the ticket that makes it real.
 */
export interface PricedProduct {
  id: string
  name: string
  price: number
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
  promoSold?: Record<string, number>
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

const rate = (v: unknown): number | null => {
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
  const WM = rate(s.WM) ?? DEFAULT_WM_RATE
  const EM = rate(s.EM) ?? WM
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
    const { price, promo } = effectivePrice(product, now, input.promoSold?.[id] ?? 0)
    lines.push({ id, name: product.name, qty, unitPrice: price, lineTotal: price * qty, promo })
  }
  if (input.extraLines) lines.push(...input.extraLines)

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0)
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

export function effectivePrice(
  product: PricedProduct,
  now: Date,
  sold = 0,
): { price: number; promo: boolean } {
  const promo = promoActive(product, now, sold)
  return { price: promo ? (product as any).promoPrice : product.price, promo }
}

function promoActive(p: any, now: Date, sold: number): boolean {
  const hasLimit = (p.promoLimit || 0) > 0
  const hasEnd = !!p.promoEnd
  const limitOk = !hasLimit || Math.max(0, (p.promoLimit || 0) - sold) > 0
  const dateOk = !hasEnd || now <= new Date(p.promoEnd + 'T23:59:59')
  return (p.promoPrice || 0) > 0 && (hasLimit || hasEnd) && limitOk && dateOk
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
