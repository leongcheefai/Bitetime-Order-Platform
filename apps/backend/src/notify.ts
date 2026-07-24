// Server-side order notifications. The Telegram bot token lives in
// merchant_secrets and is read here with the service-role client — it never
// reaches the browser. The message is built from the stored order row, so a
// client cannot forge its content. Deps (db, send) are injected for testing.
//
// `EmailSend` is a type-only import (erased at compile) so this module stays free
// of `env.ts`'s import-time validation — its pure builders unit-test with no env.
import type { EmailSend } from './email.js'

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
// than an import: this file already keeps its own `formatMoney` twin for the same reason —
// Telegram is the backend's own surface and the frontend's translator does not reach it.
const MODE_LABELS: Record<string, string> = {
  pickup: 'Pickup',
  delivery: 'Delivery',
  express: 'Express delivery',
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
  if (order.mode) msg += `*Mode:* ${MODE_LABELS[order.mode as string] ?? order.mode}\n`
  // The merchant reading this on their phone is the person scheduling around it, so it sits
  // with the mode rather than down by the totals. Omitted rather than blanked for rows written
  // before #91 — `orders.fulfil_date` is null for every one of them, and a `*Date:* ` with
  // nothing after it reads as data we lost.
  if (order.fulfil_date) msg += `*Date:* ${order.fulfil_date}\n`
  if (order.address) msg += `*Address:* ${formatAddress(order.address)}\n`
  // Distance-priced orders only; a region-priced order has no distance and must not print an
  // empty label. `delivery_distance_km` is null for every order placed before #101.
  if (order.delivery_distance_km != null) msg += `*Distance:* ${Number(order.delivery_distance_km).toFixed(1)} km\n`
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

  const { data: merchant } = await db.from('merchants').select('name, plan').eq('id', merchantId).maybeSingle()

  // Telegram alerts are Pro (#110). Only the token WRITE was gated there, on the reasoning that
  // a shop with a token configured must keep receiving its orders — true while no shop could
  // ever leave Pro, and false the moment downgrades existed. A shop that steps down keeps its
  // token (a credential, not an artifact: deleting it would make re-upgrading mean re-doing
  // BotFather) and simply stops being sent to.
  //
  // Fails CLOSED on a null or unknown plan, matching `hasProAccess`: entitlement is never
  // assumed from an absent value. Safe to check here in a way it would not be inside the order
  // transaction, because notify is a separate call made after the order has already landed —
  // this can refuse without an order being lost.
  if (merchant?.plan !== 'pro') return { ok: true, skipped: true }

  try {
    await send(secret.tg_token, secret.tg_chat_id, buildOrderMessage(order, merchant?.name))
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

// ── Customer order-confirmation email ─────────────────────────────────────────
// The second recipient of the post-commit notification fan-out (the first is the
// merchant's Telegram above). Only signed-in customers get one; guests never gave
// an email and are excluded structurally (no user_id ⇒ no recipient).

type Lang = 'en' | 'zh'

// Bilingual twin of MODE_LABELS above. The Telegram surface is English-only; the
// customer's receipt matches the language they ordered in.
const MODE_LABELS_I18N: Record<string, { en: string; zh: string }> = {
  pickup: { en: 'Pickup', zh: '自取' },
  delivery: { en: 'Delivery', zh: '送货' },
  express: { en: 'Express delivery', zh: '特快送货' },
}

// A small in-file translator so the builder reads like the frontend's t(en, zh).
const pick = (lang: Lang) => (en: string, zh: string) => (lang === 'zh' ? zh : en)

// Escape the four characters that would let an item name or shop name break the
// HTML receipt. The text part needs no escaping.
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface OrderConfirmationEmail { subject: string; text: string; html: string }

// Pure: build the customer-facing receipt from a stored order row, in the order's
// own stamped currency (legacy null ⇒ MYR). A twin of buildOrderMessage — same
// formatMoney / formatAddress / mode-label rules, different audience and channel.
// `distance` is deliberately never rendered: it is an internal pricing detail.
export function buildOrderConfirmationEmail(
  order: any,
  shopName: string,
  slug: string,
  frontendUrl: string,
  lang: Lang,
): OrderConfirmationEmail {
  const t = pick(lang)
  const cur = order.currency ?? 'MYR'
  const items = Array.isArray(order.items) ? order.items : []
  const mode = order.mode as string
  const modeLabel = MODE_LABELS_I18N[mode] ? t(MODE_LABELS_I18N[mode].en, MODE_LABELS_I18N[mode].zh) : mode
  // Address only where it applies — a pickup receipt must not carry an address the
  // customer never gave for this order.
  const showAddress = (mode === 'delivery' || mode === 'express') && !!order.address
  const addr = showAddress ? formatAddress(order.address) : ''
  const shopLink = `${frontendUrl}/s/${slug}`
  const promoTag = t('(Promo)', '（优惠）')
  const name = order.customer_name ?? ''

  const subject = t(
    `${shopName} — Order ${order.order_number} confirmed`,
    `${shopName} — 订单 ${order.order_number} 已确认`,
  )

  // ── Plain-text part ──
  const textLines: string[] = []
  textLines.push(t('Thank you for your order!', '感谢您的订单！'))
  textLines.push('')
  textLines.push(shopName)
  textLines.push(`${t('Order for', '订单人')} ${name}`)
  textLines.push('')
  textLines.push(`${t('Order No.', '订单号')}: ${order.order_number}`)
  if (order.fulfil_date) textLines.push(`${t('Date', '日期')}: ${order.fulfil_date}`)
  textLines.push(`${t('Method', '方式')}: ${modeLabel}`)
  if (showAddress) textLines.push(`${t('Delivery address', '送货地址')}: ${addr}`)
  textLines.push('')
  textLines.push(`${t('Items', '商品')}:`)
  for (const i of items) {
    const promo = i.promo ? ` ${promoTag}` : ''
    textLines.push(`• ${i.name}${promo} × ${i.qty} — ${formatMoney((i.price ?? 0) * (i.qty ?? 0), cur)}`)
  }
  textLines.push('')
  if (order.shipping_fee) textLines.push(`${t('Shipping', '运费')}: ${formatMoney(order.shipping_fee, cur)}`)
  textLines.push(`${t('Total', '总计')}: ${formatMoney(order.total ?? 0, cur)}`)
  textLines.push('')
  textLines.push(`${t('View your order', '查看您的订单')}: ${shopLink}`)
  const text = textLines.join('\n')

  // ── HTML part ── inlined CSS, no images, a styled table receipt.
  const itemRows = items
    .map((i: any) => {
      const promo = i.promo ? ` <span style="color:#b45309;font-size:12px;">${esc(promoTag)}</span>` : ''
      const line = formatMoney((i.price ?? 0) * (i.qty ?? 0), cur)
      return `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #eee;">${esc(i.name)}${promo} <span style="color:#666;">× ${esc(String(i.qty ?? 0))}</span></td>
        <td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${esc(line)}</td>
      </tr>`
    })
    .join('')

  const shippingRow = order.shipping_fee
    ? `<tr><td style="padding:6px 0;">${esc(t('Shipping', '运费'))}</td><td style="padding:6px 0;text-align:right;">${esc(formatMoney(order.shipping_fee, cur))}</td></tr>`
    : ''
  const addressBlock = showAddress
    ? `<p style="margin:4px 0;color:#444;"><strong>${esc(t('Delivery address', '送货地址'))}:</strong> ${esc(addr)}</p>`
    : ''
  const dateRow = order.fulfil_date
    ? `<p style="margin:4px 0;color:#444;"><strong>${esc(t('Date', '日期'))}:</strong> ${esc(String(order.fulfil_date))}</p>`
    : ''

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111;">
  <p style="font-size:15px;">${esc(t('Thank you for your order!', '感谢您的订单！'))}</p>
  <h1 style="font-size:20px;margin:0 0 4px;">${esc(shopName)}</h1>
  <p style="margin:0 0 12px;color:#666;">${esc(t('Order for', '订单人'))} ${esc(name)}</p>
  <p style="font-size:18px;margin:12px 0;"><strong>${esc(t('Order No.', '订单号'))}: ${esc(order.order_number)}</strong></p>
  ${dateRow}
  <p style="margin:4px 0;color:#444;"><strong>${esc(t('Method', '方式'))}:</strong> ${esc(modeLabel)}</p>
  ${addressBlock}
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
    <thead><tr><th colspan="2" style="text-align:left;padding:0 0 8px;border-bottom:2px solid #111;">${esc(t('Items', '商品'))}</th></tr></thead>
    <tbody>${itemRows}</tbody>
    <tfoot>
      ${shippingRow}
      <tr><td style="padding:8px 0;font-weight:bold;">${esc(t('Total', '总计'))}</td><td style="padding:8px 0;text-align:right;font-weight:bold;">${esc(formatMoney(order.total ?? 0, cur))}</td></tr>
    </tfoot>
  </table>
  <p style="margin:20px 0;"><a href="${esc(shopLink)}" style="color:#2563eb;">${esc(t('View your order', '查看您的订单'))}</a></p>
</div>`

  return { subject, text, html }
}

// The `from` display: the shop's name over the platform's sending address. The
// platform default (env.emailFrom) may be either a bare address or a
// `Name <addr>` pair — take the address out of the angle brackets when present.
// No reply-to: the only address on hand is the owner's Auth login, which must not
// leak to every customer.
export function senderFrom(shopName: string, emailFrom: string): string {
  const m = emailFrom.match(/<([^>]+)>/)
  const addr = m ? m[1] : emailFrom
  const name = (shopName || 'TinyOrder').replace(/[<>]/g, '').trim()
  return `${name} <${addr}>`
}

export interface EmailOrderInput { merchantId: string; orderNumber: string; lang?: string }

// Config the send needs but that does not belong to any one request: the
// storefront base URL (for the "view your order" link) and the platform sending
// address (for the shop-name `from`). Passed in rather than read from env.ts here,
// so this module stays importable by the pure unit tests without env validation.
export interface EmailOrderConfig { frontendUrl: string; emailFrom: string }

// Load the order, exclude guests, claim the one-shot row, resolve the recipient
// from the ACCOUNT (never the request body), build and send. Deps injected,
// mirroring notifyOrderPlaced. `db` reads/stamps the order and reads the merchant;
// `admin` resolves the Auth email. In production both are the service client.
//
// The stamp is claimed BEFORE the send (an atomic null→now() conditional update):
// only the caller that wins the row sends, so a retry / refresh / enumerated hit
// can never produce a second email. The cost is that a transient send failure
// after a successful claim loses that one email — acceptable, since the order is
// already committed (a mail outage must never cost an order) and the storefront
// already showed the number on screen.
export async function emailOrderConfirmation(
  db: any,
  admin: any,
  send: EmailSend,
  input: EmailOrderInput,
  cfg: EmailOrderConfig,
): Promise<NotifyResult> {
  const { merchantId, orderNumber } = input
  const lang: Lang = input.lang === 'zh' ? 'zh' : 'en'
  if (!merchantId || !orderNumber) return { ok: false, error: 'missing merchantId or orderNumber' }

  const { data: order, error: oErr } = await db
    .from('orders').select('*')
    .eq('merchant_id', merchantId).eq('order_number', orderNumber).maybeSingle()
  if (oErr) return { ok: false, error: 'order lookup failed' }
  if (!order) return { ok: false, error: 'order not found' }

  // Guest orders have no account, so no recipient. Structural, not a policy check.
  if (!order.user_id) return { ok: true, skipped: true }

  // Atomic one-shot claim: only the update that flips NULL→now() proceeds.
  const { data: claimed, error: uErr } = await db
    .from('orders')
    .update({ confirmation_emailed_at: new Date().toISOString() })
    .eq('id', order.id)
    .is('confirmation_emailed_at', null)
    .select('id')
  if (uErr) return { ok: false, error: 'stamp failed' }
  if (!claimed || claimed.length === 0) return { ok: true, skipped: true } // already emailed

  // Recipient from Auth, keyed by the order's own user_id — same source as merchant
  // owner mail, and chosen because a fresh account may have no profiles row yet.
  const { data: userRes } = await admin.auth.admin.getUserById(order.user_id)
  const to = userRes?.user?.email as string | undefined
  if (!to) return { ok: true, skipped: true } // account carries no address

  const { data: merchant } = await db.from('merchants').select('name, slug').eq('id', merchantId).maybeSingle()
  const shopName = merchant?.name ?? ''
  const slug = merchant?.slug ?? ''

  const { subject, text, html } = buildOrderConfirmationEmail(order, shopName, slug, cfg.frontendUrl, lang)
  try {
    await send(to, subject, { text, html, from: senderFrom(shopName, cfg.emailFrom) })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}
