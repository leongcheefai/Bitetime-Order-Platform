// The MERCHANT's Telegram arm of the order-notification fan-out.
//
// The bot token lives in `merchant_secrets` and is read here with the service-role client — it
// never reaches the browser. The message is built from the stored order row, so a client cannot
// forge its content. Deps (db, send) are injected for testing.
//
// The two email arms live in `orderEmails.ts`; what all three share is `orderNotice.ts`.
import { formatAddress, formatKm, formatMoney, MODE_LABELS, type NotifyOrderInput, type NotifyResult } from './orderNotice.js'
import { fulfilSlotLabel } from './fulfilSlotLabel.js'

/**
 * Telegram's own ceiling for `sendMessage` text. Over it, the API does not truncate — it
 * REFUSES the whole message, and since notify is a separate call after the order has already
 * committed, that refusal costs the merchant the entire notification for an order that exists.
 *
 * A full cart is 100 lines (`MAX_CART_LINES`) at roughly 40 characters each, so the item block
 * alone can reach this ceiling before the header and totals are counted — and #145's per-item
 * selections sub-line makes that ordinary rather than theoretical.
 *
 * Measured with `String.length` (UTF-16 units) while Telegram counts code points, so an emoji or
 * a Chinese product name makes this over-count. Erring short is the safe direction.
 */
export const TELEGRAM_MAX_CHARS = 4096

/**
 * What the merchant is told when the cart did not fit. Balanced `*` markers, because the message
 * goes out with `parse_mode: 'Markdown'` and an unclosed marker is itself a 400 — a truncation
 * that breaks parsing loses exactly what it was written to save.
 */
function truncationNotice(shown: number, total: number): string {
  return `\n⚠️ *${shown} of ${total} items shown — open your dashboard for the full order.*`
}

/**
 * Fit head + items + tail under the ceiling by dropping ITEM lines, never the head or the tail.
 *
 * The head carries the order number, the customer and the address; the tail carries the money.
 * Those are what the merchant acts on, and a cart long enough to overflow is precisely the cart
 * whose individual lines matter least — so the item block is the part that gives way, and it
 * says so. Silent truncation reads as a complete order (CONTEXT.md → Merchant order reads).
 *
 * Drops one line at a time rather than computing a budget, because the notice's own length moves
 * with the count it reports. Bounded by the cart cap, so at most 100 iterations.
 */
function fitToTelegram(head: string, itemLines: string[], tail: string, orderNumber: string): string {
  const full = `${head}${itemLines.join('\n')}\n${tail}`
  if (full.length <= TELEGRAM_MAX_CHARS) return full

  const kept = [...itemLines]
  while (kept.length > 0) {
    const body = `${head}${kept.join('\n')}\n${truncationNotice(kept.length, itemLines.length)}\n${tail}`
    if (body.length <= TELEGRAM_MAX_CHARS) return body
    kept.pop()
  }

  const none = `${head}${truncationNotice(0, itemLines.length)}\n${tail}`
  if (none.length <= TELEGRAM_MAX_CHARS) return none

  // Last resort: the head and tail alone overflow (a pathologically long shop name or address).
  // Nothing here is worth losing the notification over EXCEPT the order number — with it the
  // merchant can find the order; without it they cannot. The number is generated server-side and
  // bounded (`<PREFIX>-YYMMDD-XXXX`), and clamped anyway so this branch cannot itself overflow.
  return `🛎️ *New order*\n*Order No.:* ${String(orderNumber ?? '').slice(0, 64)}\n${truncationNotice(0, itemLines.length)}`
}

// Pure: render the Telegram message from an order row, in the order's own
// stamped currency (falls back to MYR for legacy rows without one).
//
// The length cap lives HERE and not at the call site so no caller can forget it: what this
// function returns is always something `sendMessage` will accept.
export function buildOrderMessage(order: any, merchantName?: string): string {
  const cur = order.currency ?? 'MYR'
  const items = Array.isArray(order.items) ? order.items : []
  // `(Promo)` is plain text, not a badge — Telegram's Markdown here is already `*bold*` labels
  // and this is the one place in the app that can't reach for the storefront's pill styling.
  // Missing key reads as `false` (older rows never wrote it), never as a crash — see orders.ts.
  const itemLines = items
    .map((i: any) => {
      const head = `• ${i.name}${i.promo ? ' (Promo)' : ''} × ${i.qty} — ${formatMoney((i.price ?? 0) * (i.qty ?? 0), cur)}`
      // A SUB-LINE, not parentheses mid-line (#145). The person packing the box scans for
      // quantities per flavour, and burying them between the name and the price is the format
      // most likely to be misread at speed — Telegram wraps a long line arbitrarily on a phone.
      // Rows written before menu options carry no `selections` at all, which reads as no
      // sub-line rather than as a crash.
      const picks: any[] = Array.isArray(i.selections) ? i.selections : []
      if (picks.length === 0) return head
      // Plain text, no `*` markers: this goes out as Markdown and every marker added here is
      // another way an unclosed one turns the whole send into a 400.
      return `${head}\n    ↳ ${picks.map(s => `${s.optionName} ×${s.qty}`).join(', ')}`
    })
  let msg = `🛎️ *New order${merchantName ? ` — ${merchantName}` : ''}*\n\n`
  msg += `*Order No.:* ${order.order_number}\n`
  msg += `*Name:* ${order.customer_name ?? ''}\n`
  if (order.customer_wa) msg += `*WhatsApp:* ${order.customer_wa}\n`
  if (order.mode) msg += `*Mode:* ${MODE_LABELS[order.mode as string] ?? order.mode}\n`
  // The merchant reading this on their phone is the person scheduling around it, so it sits
  // with the mode rather than down by the totals. Omitted rather than blanked for rows written
  // before #91 — `orders.fulfil_date` is null for every one of them, and a `*Date:* ` with
  // nothing after it reads as data we lost.
  if (order.fulfil_date) {
    const slot = fulfilSlotLabel(order.fulfil_time_from, order.fulfil_time_to)
    msg += `*Date:* ${order.fulfil_date}${slot ? ` ${slot}` : ''}\n`
  }
  if (order.address) msg += `*Address:* ${formatAddress(order.address)}\n`
  // Distance-priced orders only; a region-priced order has no distance and must not print an
  // empty label. `delivery_distance_km` is null for every order placed before #101.
  const km = formatKm(order.delivery_distance_km)
  if (km) msg += `*Distance:* ${km}\n`
  msg += `\n*Items:*\n`
  // The money, kept whole: it is the last thing dropped, never the first.
  let tail = ''
  if (order.shipping_fee) tail += `*Shipping:* ${formatMoney(order.shipping_fee, cur)}\n`
  tail += `\n*Total: ${formatMoney(order.total ?? 0, cur)}*`
  return fitToTelegram(msg, itemLines, tail, order.order_number)
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

  // A configured token IS the entitlement now (#222). The send used to be gated on the shop's
  // tier as well, because a shop could leave Pro still holding a token; with one plan there is
  // no such shop, and the only question left is the one two lines up — has this merchant set
  // Telegram up at all?
  try {
    await send(secret.tg_token, secret.tg_chat_id, buildOrderMessage(order, merchant?.name))
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}
