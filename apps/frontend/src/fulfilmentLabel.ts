// The ONE mapping from a `mode` value to what the customer and the merchant read.
//
// It exists because there were three hand-rolled `mode === 'delivery' ? … : …` ternaries — the
// receipt, the customer's order history and the dashboard — and a fourth is exactly how one
// surface ends up calling a method something the other three do not. A customer comparing their
// receipt against their history must not find two names for one order.
import type { Translate } from './types'

const LABELS: Record<string, { en: string; zh: string }> = {
  pickup:   { en: 'Pickup',           zh: '自取' },
  delivery: { en: 'Delivery',         zh: '送货' },
  express:  { en: 'Express delivery', zh: '快速配送' },
}

/** The method's name. An unknown mode is capitalised rather than blanked — an old row still
 *  has to say something. */
export function fulfilmentLabel(mode: string | null | undefined, t: Translate): string {
  if (!mode) return '—'
  const l = LABELS[mode]
  return l ? t(l.en, l.zh) : mode.charAt(0).toUpperCase() + mode.slice(1)
}

/**
 * The money line for the shipping charge, named after the method that produced it.
 *
 * `km` is appended only when there is one. The distance is what makes the fee reconcilable on a
 * calculator (`base + rate × km`), and it is already the rounded km the fee was derived from —
 * see `routedKm`. A region-priced order has no distance, and printing `(0.0 km)` would be a lie
 * about what produced the money.
 */
export function feeLineLabel(mode: string | null | undefined, km: number | null, t: Translate): string {
  const base = mode === 'express'
    ? t('Express delivery fee', '快速配送费')
    : t('Delivery fee', '送货费')
  if (km === null) return base
  return t(`${base} (${km.toFixed(1)} km)`, `${base}（${km.toFixed(1)} 公里）`)
}
