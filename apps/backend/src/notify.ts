// Server-side order notifications. The Telegram bot token lives in
// merchant_secrets and is read here with the service-role client — it never
// reaches the browser. The message is built from the stored order row, so a
// client cannot forge its content. Deps (db, send) are injected for testing.

export interface NotifyOrderInput { merchantId: string; orderNumber: string }
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
  const a = addr as { line1?: string; postcode?: string; city?: string; state?: string }
  const cityLine = [a.postcode, a.city].filter(Boolean).join(' ')
  return [a.line1, cityLine, a.state].filter(Boolean).join(', ')
}

// Pure: render the Telegram message from an order row, in the order's own
// stamped currency (falls back to MYR for legacy rows without one).
export function buildOrderMessage(order: any, merchantName?: string): string {
  const cur = order.currency ?? 'MYR'
  const items = Array.isArray(order.items) ? order.items : []
  // `(Promo)` is plain text, not a badge — Telegram's Markdown here is already `*bold*` labels
  // and this is the one place in the app that can't reach for the storefront's pill styling.
  // Missing key reads as `false` (older rows never wrote it), never as a crash — see orders.ts.
  const lines = items
    .map((i: any) => `• ${i.name}${i.promo ? ' (Promo)' : ''} × ${i.qty} — ${formatMoney((i.price ?? 0) * (i.qty ?? 0), cur)}`)
    .join('\n')
  let msg = `🛎️ *New order${merchantName ? ` — ${merchantName}` : ''}*\n\n`
  msg += `*Order No.:* ${order.order_number}\n`
  msg += `*Name:* ${order.customer_name ?? ''}\n`
  if (order.customer_wa) msg += `*WhatsApp:* ${order.customer_wa}\n`
  if (order.mode) msg += `*Mode:* ${order.mode}\n`
  // The merchant reading this on their phone is the person scheduling around it, so it sits
  // with the mode rather than down by the totals. Omitted rather than blanked for rows written
  // before #91 — `orders.fulfil_date` is null for every one of them, and a `*Date:* ` with
  // nothing after it reads as data we lost.
  if (order.fulfil_date) msg += `*Date:* ${order.fulfil_date}\n`
  if (order.address) msg += `*Address:* ${formatAddress(order.address)}\n`
  msg += `\n*Items:*\n${lines}\n`
  if (order.shipping_fee) msg += `*Shipping:* ${formatMoney(order.shipping_fee, cur)}\n`
  msg += `\n*Total: ${formatMoney(order.total ?? 0, cur)}*`
  return msg
}

export type TelegramSend = (token: string, chatId: string, text: string) => Promise<void>

// Real adapter: Telegram Bot API over fetch.
export const telegramSend: TelegramSend = async (token, chatId, text) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  })
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`)
}

// Verify the order exists for the merchant, read that merchant's secret, send.
// Returns skipped:true (still ok) when the merchant has no Telegram configured.
export async function notifyOrderPlaced(db: any, send: TelegramSend, input: NotifyOrderInput): Promise<NotifyResult> {
  const { merchantId, orderNumber } = input
  if (!merchantId || !orderNumber) return { ok: false, error: 'missing merchantId or orderNumber' }

  const { data: order, error: oErr } = await db
    .from('orders').select('*')
    .eq('merchant_id', merchantId).eq('order_number', orderNumber).maybeSingle()
  if (oErr) return { ok: false, error: 'order lookup failed' }
  if (!order) return { ok: false, error: 'order not found' }

  const { data: secret } = await db
    .from('merchant_secrets').select('tg_token, tg_chat_id')
    .eq('merchant_id', merchantId).maybeSingle()
  if (!secret?.tg_token || !secret?.tg_chat_id) return { ok: true, skipped: true }

  const { data: merchant } = await db.from('merchants').select('name').eq('id', merchantId).maybeSingle()
  try {
    await send(secret.tg_token, secret.tg_chat_id, buildOrderMessage(order, merchant?.name))
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}
