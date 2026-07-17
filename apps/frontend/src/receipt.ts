import type { OrderItem } from './types'

// Cents, not float dust. A local twin of pricing.ts's private `round2` rather than an
// export from @bitetime/shared: that package holds rules that must hold identically on
// BOTH sides of the wire, and what a receipt prints is a display concern the browser
// alone answers.
const round2 = (n: number) => parseFloat(n.toFixed(2))

/**
 * An order's subtotal, summed back from its stored lines.
 *
 * `orders` persists `items`, `shipping_fee`, `discount` and `total` — never a subtotal. Summing
 * the lines is what makes the printed arithmetic close: `pricing.ts` builds the total FROM this
 * same sum (`subtotal = round2(Σ lineTotal)`, `total = round2(subtotal + shipping − discount)`),
 * so subtotal + fee − voucher = total on the page, by construction.
 *
 * Deriving it the other way — `total − shipping + discount` — would always reconcile with the
 * total while silently disagreeing with the lines printed directly above it. This way a data bug
 * shows up on the receipt instead of hiding inside it.
 *
 * Every entry counts: a split promo writes two lines under one product id.
 *
 * Each line is rounded to cents before summing (not just the final result) for two reasons:
 * 1. `pricing.ts` rounds each lineTotal before summing, so this must too — "by construction"
 *    is the entire point, and summing unrounded products would silently diverge from it.
 * 2. The receipt prints each line rounded to cents. A subtotal that summed unrounded products
 *    could disagree with the very column printed above it; per-line rounding means the printed
 *    numbers add up exactly.
 */
export function receiptSubtotal(items: OrderItem[] | null | undefined): number {
  if (!items) return 0
  return round2(items.reduce((sum, it) => sum + round2((it.price ?? 0) * (it.qty ?? 0)), 0))
}
