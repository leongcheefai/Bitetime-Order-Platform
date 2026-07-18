// Display-only FX for the platform pricing page. RM (MYR) is the price we actually
// charge everyone; these rates convert that RM amount into an APPROXIMATE local
// figure shown as a courtesy (`≈`), never charged. Hardcoded on purpose: no API,
// no key, deterministic — nudge the numbers in a PR when they drift.
//
// Every currency here must exist in the frontend currency registry
// (apps/frontend/src/currency.ts) or formatMoney falls back to RM.

// Approximate units of the target currency per 1 MYR.
export const MYR_RATES: Record<string, number> = {
  USD: 0.21,
  SGD: 0.29,
  THB: 7.6,
  PHP: 12.5,
  IDR: 3400,
  VND: 5500,
  JPY: 33,
}

// ISO 3166-1 alpha-2 country → estimate currency. Malaysia is deliberately absent:
// Malaysians see the real RM price with no estimate line. Anything unlisted falls
// back to a USD estimate.
export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  SG: 'SGD',
  TH: 'THB',
  PH: 'PHP',
  ID: 'IDR',
  VN: 'VND',
  JP: 'JPY',
  US: 'USD',
}

export interface Estimate {
  currency: string
  rate: number
}

/**
 * The local-currency estimate for a visitor's country, or `null` when none should
 * be shown. `MY` → null (RM is already their currency). A mapped country → its
 * currency + MYR rate. Anything else (including an empty/undetected country) → a
 * USD estimate. Never throws.
 */
export function estimateFor(country: string): Estimate | null {
  const code = (country ?? '').trim().toUpperCase()
  if (code === 'MY') return null
  const currency = COUNTRY_TO_CURRENCY[code] ?? 'USD'
  return { currency, rate: MYR_RATES[currency] }
}
