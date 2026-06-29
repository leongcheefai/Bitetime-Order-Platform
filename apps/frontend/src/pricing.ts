// Order pricing — the one pure module that turns a cart + context into a money
// breakdown. Single source of truth for every total the app shows. No I/O: the
// clock, the loaded voucher, the sameday quote, and the resolved referral are
// all passed in. See CONTEXT.md → "Order pricing".

import type { Product, Voucher } from './types'

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
  products: Product[]
  cart: Record<string, number>
  mode: 'pickup' | 'delivery' | 'sameday'
  state?: string | null
  rates: { WM: number; EM: number }
  samedayFee?: number
  resolvedShipping?: number // caller-resolved flat fee; wins over region logic
  voucher?: Voucher | null
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
export function voucherError(voucher: Voucher | null | undefined, ctx: VoucherCtx): VoucherErrorCode | null {
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

function voucherDiscount(voucher: Voucher | null | undefined, base: number): number {
  if (!voucher) return 0
  if ((voucher as any).type === 'percent') return round2((base * (voucher as any).value) / 100)
  return Math.min((voucher as any).value, base)
}

export function effectivePrice(
  product: Product,
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
