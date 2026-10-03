// The vocabulary every arm of the order-notification fan-out shares.
//
// `POST /api/notify/order` fans out to three independent recipients — the merchant's Telegram
// (`notify.ts`), the customer's receipt and the shop owner's alert (both `orderEmails.ts`). They
// speak different languages to different audiences over different transports, but they all
// render the SAME stored order row and they all answer with the SAME result shape. That common
// ground is this module, and it is deliberately the only thing the three arms share: anything
// only one of them needs belongs in that arm's own file.
//
// No I/O and no imports, so every builder downstream unit-tests without touching `env.ts`.

export interface NotifyOrderInput { merchantId: string; orderNumber: string }

/**
 * How every arm answers, and the distinction that matters is `skipped` vs `error`.
 *
 * A skip is a SUCCESS: nothing was wrong, there was simply nobody to send to — a guest order has
 * no account, a basic shop has no Telegram, a shop may have no owner. Only a genuine failure
 * carries `error`. Collapsing the two would make a shop that never configured Telegram look
 * exactly like a broken bot token.
 */
export interface NotifyResult { ok: boolean; skipped?: boolean; error?: string }

// Compact mirror of the frontend currency registry (apps/frontend/src/currency.ts).
// Duplicated because the backend is a separate workspace; keep the two in sync.
const CURRENCIES: Record<string, { symbol: string; decimals: number; symbolAfter?: boolean }> = {
  MYR: { symbol: 'RM', decimals: 2 },
  SGD: { symbol: 'S$', decimals: 2 },
  USD: { symbol: '$', decimals: 2 },
  THB: { symbol: '฿', decimals: 2 },
  PHP: { symbol: '₱', decimals: 2 },
  IDR: { symbol: 'Rp', decimals: 0 },
  VND: { symbol: '₫', decimals: 0 },
  JPY: { symbol: '¥', decimals: 0 },
}

// Renders `amount` in the order's currency, matching the frontend formatMoney.
export function formatMoney(amount: number | null | undefined, code?: string | null): string {
  const def = CURRENCIES[code ?? ''] ?? CURRENCIES.MYR
  const n = Number(amount)
  const value = Number.isFinite(n) ? n : 0
  const num = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: def.decimals,
    maximumFractionDigits: def.decimals,
  }).format(value)
  return def.symbolAfter ? `${num} ${def.symbol}` : `${def.symbol} ${num}`
}

// Delivery address may be a structured object { line1, postcode, city, state }
// (current) or a legacy free-text string. Mirrors the frontend formatAddress;
// the backend can't import frontend code, so this is an intentional twin.
export function formatAddress(addr: unknown): string {
  if (!addr) return ''
  if (typeof addr === 'string') return addr
  const a = addr as { line1?: string; unit?: string; postcode?: string; city?: string; state?: string; place_id?: string }
  // A `place_id` marks `line1` as Google's OWN formatted address string, which already contains
  // the postcode, city and state — appending them again printed every distance order's address
  // twice in the Telegram message (#101 review, Finding 3). Mirrors the frontend twin exactly.
  if (a.place_id) return [a.unit, a.line1].filter(Boolean).join(', ')
  const cityLine = [a.postcode, a.city].filter(Boolean).join(' ')
  // The unit/floor/landmark rides in front of the street line, where a rider reads it first. It
  // is never routed and never moved the fee — it exists so the drop can actually be completed.
  return [a.unit, a.line1, cityLine, a.state].filter(Boolean).join(', ')
}

// The merchant-facing name for each method. English only, and deliberately a local map rather
// than an import: this file already keeps its own `formatMoney` twin for the same reason — the
// shop's surface is the backend's own, and the frontend's translator does not reach it. The
// customer's receipt keeps a bilingual twin of this in `orderEmails.ts`.
export const MODE_LABELS: Record<string, string> = {
  pickup: 'Pickup',
  delivery: 'Delivery',
  express: 'Express delivery',
}

/**
 * The routed distance as the merchant surfaces read it: ONE DECIMAL, because that is the km the
 * fee was computed from (see CONTEXT.md → Shipping policy). Null when there is none to show —
 * every order placed before #101 has none, and a bare `Distance:` reads as data we lost.
 */
export function formatKm(km: unknown): string | null {
  if (km == null) return null
  const n = Number(km)
  return Number.isFinite(n) ? `${n.toFixed(1)} km` : null
}

/**
 * A line put at the top of the merchant's alert, and the word put before its email subject. Used
 * when the alert is sent after a HitPay payment rather than at the time of the order.
 */
export interface AlertBanner {
  line: string
  subjectPrefix: string
}
