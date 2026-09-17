// The two EMAIL arms of the order-notification fan-out: the customer's order confirmation and
// the shop owner's new-order alert.
//
// They sit together because they are one shape twice over — same order lookup, same atomic
// one-shot claim, same HTML shell and items table — differing in audience, language
// sensitivity and which stamp they claim. Keeping them apart would mean two drifting copies of
// a claim that is a security control, not a convenience (see ADR 0006).
//
// The merchant's Telegram arm is `notify.ts`; what all three share is `orderNotice.ts`.
//
// `EmailSend` is a type-only import (erased at compile) so this module stays free of `env.ts`'s
// import-time validation — its pure builders unit-test with no env.
import type { EmailSend } from './email.js'
import { fulfilSlotLabel } from './fulfilSlotLabel.js'
import {
  formatAddress, formatKm, formatMoney, MODE_LABELS,
  type NotifyOrderInput, type NotifyResult,
} from './orderNotice.js'

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

// ── Shared email HTML ─────────────────────────────────────────────────────────
// Both mail builders render the SAME order rows into the SAME shell — only their labels,
// audience and links differ. These three helpers are that shared markup. Inline styles and
// literal hex are not drift from DESIGN.md: mail clients support neither CSS variables nor a
// stylesheet, so an email's only styling is what is inlined on the element.

/** The outer page: one column, system font stack, no images. */
function emailShell(inner: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111;">
${inner}
</div>`
}

/** `Label: value` detail line. */
function detailHtml(label: string, value: string): string {
  return `<p style="margin:4px 0;color:#444;"><strong>${esc(label)}:</strong> ${esc(value)}</p>`
}

/**
 * The items table, its optional shipping row and its total.
 *
 * Item lines are keyed BY INDEX, never by product id: a promo cap splits one product across two
 * lines at two prices (CONTEXT.md → Promo), and keying by id would drop one of them.
 */
function itemsTableHtml(
  items: any[],
  cur: string,
  labels: { items: string; shipping: string; total: string; promo: string },
  shippingFee: number | null | undefined,
  total: number,
): string {
  const rows = items
    .map((i: any) => {
      const promo = i.promo ? ` <span style="color:#b45309;font-size:12px;">${esc(labels.promo)}</span>` : ''
      const line = formatMoney((i.price ?? 0) * (i.qty ?? 0), cur)
      // The chosen options, under the name in the same cell (#145). Rows written before menu
      // options carry no `selections`, which reads as no sub-line.
      const picks: any[] = Array.isArray(i.selections) ? i.selections : []
      const chosen = picks.length
        ? `<div style="color:#666;font-size:12px;padding-top:2px;">↳ ${
            picks.map(s => `${esc(s.optionName)} ×${esc(String(s.qty ?? 0))}`).join(', ')}</div>`
        : ''
      return `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #eee;">${esc(i.name)}${promo} <span style="color:#666;">× ${esc(String(i.qty ?? 0))}</span>${chosen}</td>
        <td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${esc(line)}</td>
      </tr>`
    })
    .join('')

  const shippingRow = shippingFee
    ? `<tr><td style="padding:6px 0;">${esc(labels.shipping)}</td><td style="padding:6px 0;text-align:right;">${esc(formatMoney(shippingFee, cur))}</td></tr>`
    : ''

  return `<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
    <thead><tr><th colspan="2" style="text-align:left;padding:0 0 8px;border-bottom:2px solid #111;">${esc(labels.items)}</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      ${shippingRow}
      <tr><td style="padding:8px 0;font-weight:bold;">${esc(labels.total)}</td><td style="padding:8px 0;text-align:right;font-weight:bold;">${esc(formatMoney(total, cur))}</td></tr>
    </tfoot>
  </table>`
}

/**
 * The shop's own payment instructions, as the receipt needs them: already-resolved strings, so
 * this module keeps knowing nothing about Storage or `env.ts` (the QR's public URL is built by
 * the caller, from `EmailOrderConfig.qrBaseUrl`).
 *
 * The three are independent and any one is enough — the same rule as `hasPaymentInstructions`
 * on the storefront and `hasPaymentInfo` in `orders.ts`, which is what decides whether an order
 * is born `pending_payment` at all. A shop that set none of them takes payment some other way,
 * and a receipt carrying an empty "Payment Instructions" box states a problem it does not have.
 */
export interface PaymentInstructionsInput {
  bank?: string | null
  note?: string | null
  qrUrl?: string | null
}

function hasPaymentInstructions(p: PaymentInstructionsInput | undefined): boolean {
  return !!p && Boolean(p.bank || p.note || p.qrUrl)
}

/**
 * How to pay this shop, in the receipt.
 *
 * The customer read the same three lines on the order-placed screen, then closed the tab to open
 * their banking app — this is the copy that survives that. Order comes from
 * `store/PaymentInstructions.tsx` and must not drift from it: the words say who is being paid,
 * the code is how.
 *
 * The QR is a REMOTE image, which most mail clients hide until the reader allows images. That is
 * why the receipt's "View your order" link stays below this block: it is the fallback, and there
 * is deliberately no second link here competing with it.
 */
function paymentHtml(p: PaymentInstructionsInput, heading: string, qrAlt: string): string {
  const bank = p.bank ? `<p style="margin:4px 0;">${esc(p.bank)}</p>` : ''
  // `white-space:pre-line` rather than `<br>` injection: the note is merchant-entered free text,
  // and the line breaks they typed are the ones that render.
  const note = p.note
    ? `<p style="margin:6px 0;white-space:pre-line;">${esc(p.note)}</p>`
    : ''
  // No fixed aspect and no crop, for the storefront's reason: what merchants upload here is as
  // often a phone screenshot as a clean QR, and a letterboxed code is one too small to scan.
  const qr = p.qrUrl
    ? `<div style="text-align:center;margin-top:12px;">
      <img src="${esc(p.qrUrl)}" alt="${esc(qrAlt)}" width="240" style="width:100%;max-width:240px;height:auto;background:#ffffff;padding:8px;border:1px solid #eee;border-radius:6px;" />
    </div>`
    : ''
  return `<div style="margin:20px 0;padding:12px 14px;border:1px solid #eee;border-radius:6px;font-size:14px;color:#444;">
    <p style="margin:0 0 6px;font-weight:bold;color:#111;">${esc(heading)}</p>
    ${bank}${note}${qr}
  </div>`
}

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
  payment?: PaymentInstructionsInput,
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
  const showPayment = hasPaymentInstructions(payment)
  const paymentHeading = t('Payment Instructions', '付款说明')
  const qrAlt = t('Payment QR code', '付款二维码')

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
  const slot = fulfilSlotLabel(order.fulfil_time_from, order.fulfil_time_to)
  if (order.fulfil_date) textLines.push(`${t('Date', '日期')}: ${order.fulfil_date}${slot ? ` ${slot}` : ''}`)
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
  if (showPayment && payment) {
    textLines.push(`${paymentHeading}:`)
    if (payment.bank) textLines.push(payment.bank)
    if (payment.note) textLines.push(payment.note)
    // The QR as a URL: the text part has no images, and a customer reading it still needs a way
    // to reach the code.
    if (payment.qrUrl) textLines.push(`${qrAlt}: ${payment.qrUrl}`)
    textLines.push('')
  }
  textLines.push(`${t('View your order', '查看您的订单')}: ${shopLink}`)
  const text = textLines.join('\n')

  // ── HTML part ──
  const dateRow = order.fulfil_date ? detailHtml(t('Date', '日期'), `${order.fulfil_date}${slot ? ` ${slot}` : ''}`) : ''
  const addressBlock = showAddress ? detailHtml(t('Delivery address', '送货地址'), addr) : ''

  const html = emailShell(`  <p style="font-size:15px;">${esc(t('Thank you for your order!', '感谢您的订单！'))}</p>
  <h1 style="font-size:20px;margin:0 0 4px;">${esc(shopName)}</h1>
  <p style="margin:0 0 12px;color:#666;">${esc(t('Order for', '订单人'))} ${esc(name)}</p>
  <p style="font-size:18px;margin:12px 0;"><strong>${esc(t('Order No.', '订单号'))}: ${esc(order.order_number)}</strong></p>
  ${dateRow}
  ${detailHtml(t('Method', '方式'), modeLabel)}
  ${addressBlock}
  ${itemsTableHtml(
    items, cur,
    { items: t('Items', '商品'), shipping: t('Shipping', '运费'), total: t('Total', '总计'), promo: promoTag },
    order.shipping_fee, order.total ?? 0,
  )}
  ${showPayment && payment ? paymentHtml(payment, paymentHeading, qrAlt) : ''}
  <p style="margin:20px 0;"><a href="${esc(shopLink)}" style="color:#2563eb;">${esc(t('View your order', '查看您的订单'))}</a></p>`)

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

// ── Shared plumbing for the two mail arms ─────────────────────────────────────

/**
 * The atomic one-shot claim, parameterised by which stamp is being claimed.
 *
 * Both mail arms need it and neither may be allowed to drift from it: it is the only thing
 * standing between an anonymous, order-number-addressable endpoint and a mail flood. Only the
 * caller that flips NULL→now() gets `true`; a concurrent or repeated call gets `false` and must
 * send nothing. The two columns are separate on purpose — see the migration — so the parameter
 * is a column name rather than one shared "notified" flag.
 */
async function claimOnce(
  db: any,
  orderId: string,
  column: 'confirmation_emailed_at' | 'merchant_emailed_at',
): Promise<{ claimed: boolean; error?: string }> {
  const { data, error } = await db
    .from('orders')
    .update({ [column]: new Date().toISOString() })
    .eq('id', orderId)
    .is(column, null)
    .select('id')
  if (error) return { claimed: false, error: 'stamp failed' }
  return { claimed: !!data && data.length > 0 }
}

/**
 * Hand back a claim whose send did not happen.
 *
 * The claim is taken BEFORE the send, which is what makes it a concurrency guard rather than a
 * post-hoc record: two simultaneous calls cannot both reach Resend. The cost of that ordering is
 * that a claim is spent the moment it is taken, so a send that then throws — a Resend outage, a
 * 429, a DNS blip — would retire the mail permanently, and no retry could ever deliver it. For a
 * basic shop the owner alert is the ONLY notice it gets, so that is a silently lost order.
 *
 * Releasing restores the null and makes the next call eligible again. It is deliberately NOT
 * conditional on the current value: the caller only reaches here holding a claim it just won.
 *
 * A failure to release is logged and swallowed — the send has already failed, and throwing here
 * would replace a "mail did not go" result with an exception the fan-out would have to model.
 */
async function releaseClaim(
  db: any,
  orderId: string,
  column: 'confirmation_emailed_at' | 'merchant_emailed_at',
): Promise<void> {
  const { error } = await db.from('orders').update({ [column]: null }).eq('id', orderId)
  if (error) {
    console.error(`Failed to release ${column} for order ${orderId} — mail will not be retried:`, error.message)
  }
}

/** Loads the order both mail arms address, keyed the way the wire addresses it. */
async function loadOrder(db: any, merchantId: string, orderNumber: string) {
  const { data, error } = await db
    .from('orders').select('*')
    .eq('merchant_id', merchantId).eq('order_number', orderNumber).maybeSingle()
  if (error) return { error: 'order lookup failed' as const }
  if (!data) return { error: 'order not found' as const }
  return { order: data }
}

// Config the send needs but that does not belong to any one request: the
// storefront base URL (for the "view your order" link) and the platform sending
// address (for the shop-name `from`). Passed in rather than read from env.ts here,
// so this module stays importable by the pure unit tests without env validation.
export interface EmailOrderConfig { frontendUrl: string; emailFrom: string; qrBaseUrl?: string }

// The public bucket the shop's payment QR lives in. The column stores a PATH, never a URL
// (`writes.ts`), so the receipt has to build the URL — and it is built HERE rather than in the
// pure builder, which must stay free of both `env.ts` and any Storage knowledge.
const PAYMENT_QR_BUCKET = 'payment-qr'

/** `{supabaseUrl}/storage/v1/object/public/payment-qr/{path}` — the bucket is public (#156). */
export function paymentQrUrl(qrBaseUrl: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${qrBaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${PAYMENT_QR_BUCKET}/${encoded}`
}

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

  const loaded = await loadOrder(db, merchantId, orderNumber)
  if (loaded.error) return { ok: false, error: loaded.error }
  const order = loaded.order

  // Guest orders have no account, so no recipient. Structural, not a policy check.
  if (!order.user_id) return { ok: true, skipped: true }

  const claim = await claimOnce(db, order.id, 'confirmation_emailed_at')
  if (claim.error) return { ok: false, error: claim.error }
  if (!claim.claimed) return { ok: true, skipped: true } // already emailed

  // Recipient from Auth, keyed by the order's own user_id — same source as merchant
  // owner mail, and chosen because a fresh account may have no profiles row yet.
  const { data: userRes } = await admin.auth.admin.getUserById(order.user_id)
  const to = userRes?.user?.email as string | undefined
  if (!to) return { ok: true, skipped: true } // account carries no address

  const { data: merchant } = await db
    .from('merchants')
    .select('name, slug, payment_bank, payment_note, payment_qr')
    .eq('id', merchantId).maybeSingle()
  const shopName = merchant?.name ?? ''
  const slug = merchant?.slug ?? ''

  // The QR is dropped when no base URL is configured rather than rendered as a broken image —
  // the bank line and the note still reach the customer, which is the same partial block the
  // storefront shows a shop that set only some of the three.
  const qr = merchant?.payment_qr as string | null | undefined
  const payment: PaymentInstructionsInput = {
    bank: merchant?.payment_bank ?? null,
    note: merchant?.payment_note ?? null,
    qrUrl: qr && cfg.qrBaseUrl ? paymentQrUrl(cfg.qrBaseUrl, qr) : null,
  }

  const { subject, text, html } = buildOrderConfirmationEmail(order, shopName, slug, cfg.frontendUrl, lang, payment)
  try {
    await send(to, subject, { text, html, from: senderFrom(shopName, cfg.emailFrom) })
    return { ok: true }
  } catch (e: any) {
    // The claim was taken above and the mail did not go — hand it back so a retry can.
    await releaseClaim(db, order.id, 'confirmation_emailed_at')
    return { ok: false, error: e?.message ?? String(e) }
  }
}

// ── Merchant new-order email ──────────────────────────────────────────────────
// The THIRD recipient of the fan-out.
//
// Telegram is a Pro entitlement, so a basic shop had no notification at all: the customer got
// their receipt and the shop got nothing, learning about the order only by refreshing the
// dashboard. This arm closes that. Telegram stays Pro and stays the tier's headline — it is the
// loud, phone-buzzing, staff-shared channel — and a Pro shop simply receives both.
//
// It is the shop's surface, so it follows the Telegram rules and not the customer receipt's:
// English only (the body's `lang` is the CUSTOMER's presentation and is never consulted here),
// and it carries the operational detail the receipt deliberately omits — the customer's WhatsApp
// number and the routed distance.


// Pure: build the shop's new-order alert from a stored order row. A sibling of
// buildOrderConfirmationEmail, NOT a reuse of buildOrderMessage — that one emits Telegram
// Markdown, whose `*bold*` markers render literally in mail.
export function buildMerchantOrderEmail(
  order: any,
  shopName: string,
  dashboardUrl: string,
): OrderConfirmationEmail {
  const cur = order.currency ?? 'MYR'
  const items = Array.isArray(order.items) ? order.items : []
  const mode = order.mode as string
  const modeLabel = MODE_LABELS[mode] ?? mode
  // Same rule as the customer receipt: an address only where the method has one. A pickup alert
  // carrying an address the customer never gave for this order would send the merchant driving.
  const showAddress = (mode === 'delivery' || mode === 'express') && !!order.address
  const addr = showAddress ? formatAddress(order.address) : ''
  const distance = formatKm(order.delivery_distance_km)
  const total = formatMoney(order.total ?? 0, cur)

  // The order and its money, so a merchant can triage the inbox without opening anything.
  const subject = `New order ${order.order_number} — ${total}`

  // Every optional row is OMITTED, never blanked — `fulfil_date` is null for every order placed
  // before #91 and `delivery_distance_km` for every one before #101, and a label with nothing
  // after it reads as data we lost.
  const rows: Array<[string, string]> = []
  rows.push(['Order No.', String(order.order_number)])
  if (order.customer_name) rows.push(['Name', String(order.customer_name)])
  if (order.customer_wa) rows.push(['WhatsApp', String(order.customer_wa)])
  if (mode) rows.push(['Method', modeLabel])
  if (order.fulfil_date) {
    const slot = fulfilSlotLabel(order.fulfil_time_from, order.fulfil_time_to)
    rows.push(['Date', `${order.fulfil_date}${slot ? ` ${slot}` : ''}`])
  }
  if (showAddress) rows.push(['Address', addr])
  if (distance) rows.push(['Distance', distance])

  const lineTotal = (i: any) => formatMoney((i.price ?? 0) * (i.qty ?? 0), cur)

  // ── Plain-text part ──
  const textLines: string[] = []
  textLines.push(`New order — ${shopName}`)
  textLines.push('')
  for (const [label, value] of rows) textLines.push(`${label}: ${value}`)
  textLines.push('')
  textLines.push('Items:')
  for (const i of items) {
    textLines.push(`• ${i.name}${i.promo ? ' (Promo)' : ''} × ${i.qty} — ${lineTotal(i)}`)
  }
  textLines.push('')
  if (order.shipping_fee) textLines.push(`Shipping: ${formatMoney(order.shipping_fee, cur)}`)
  textLines.push(`Total: ${total}`)
  textLines.push('')
  textLines.push(`Open your dashboard: ${dashboardUrl}`)
  const text = textLines.join('\n')

  // ── HTML part ── the receipt's shell and table, with the shop's labels.
  const html = emailShell(`  <h1 style="font-size:20px;margin:0 0 4px;">New order — ${esc(shopName)}</h1>
  <p style="font-size:18px;margin:12px 0;"><strong>${esc(String(order.order_number))}</strong></p>
  ${rows.map(([label, value]) => detailHtml(label, value)).join('')}
  ${itemsTableHtml(
    items, cur,
    { items: 'Items', shipping: 'Shipping', total: 'Total', promo: '(Promo)' },
    order.shipping_fee, order.total ?? 0,
  )}
  <p style="margin:20px 0;"><a href="${esc(dashboardUrl)}" style="color:#2563eb;">Open your dashboard</a></p>`)

  return { subject, text, html }
}

// Load the order, claim the one-shot row, resolve the OWNER from Auth, build and send.
// Signature mirrors emailOrderConfirmation exactly: `db` reads/stamps the order and reads the
// merchant, `admin` resolves the owner's Auth email, `send` is the injected adapter.
//
// The stamp is claimed BEFORE the send for the same reason as the customer's, and it carries
// more weight here. ADR 0003 accepted an anonymous notify endpoint because the worst an
// enumerator achieves is triggering the one legitimate CUSTOMER email early. That reasoning does
// not extend to a recipient who is not the customer: without this claim, a guessable per-shop
// daily order number is an unbounded mail flood at a merchant's inbox.
//
// This is the arm every shop gets, whether or not it has set Telegram up.
export async function emailMerchantOrder(
  db: any,
  admin: any,
  send: EmailSend,
  input: NotifyOrderInput,
  cfg: EmailOrderConfig,
): Promise<NotifyResult> {
  const { merchantId, orderNumber } = input
  if (!merchantId || !orderNumber) return { ok: false, error: 'missing merchantId or orderNumber' }

  const loaded = await loadOrder(db, merchantId, orderNumber)
  if (loaded.error) return { ok: false, error: loaded.error }
  const order = loaded.order

  // The owner is read BEFORE the claim: a shop whose owner has no reachable address must not
  // burn its one-shot stamp on a send that was never going to happen, or the merchant would
  // lose the alert permanently the moment the account became reachable again.
  const { data: merchant } = await db
    .from('merchants').select('name, owner_id').eq('id', merchantId).maybeSingle()
  if (!merchant?.owner_id) return { ok: true, skipped: true }

  const { data: userRes } = await admin.auth.admin.getUserById(merchant.owner_id)
  const to = userRes?.user?.email as string | undefined
  // An account carrying no address — a phone-only signup reads back `email: ''`.
  if (!to) return { ok: true, skipped: true }

  const claim = await claimOnce(db, order.id, 'merchant_emailed_at')
  if (claim.error) return { ok: false, error: claim.error }
  if (!claim.claimed) return { ok: true, skipped: true } // already emailed

  const { subject, text, html } = buildMerchantOrderEmail(
    order, merchant.name ?? '', `${cfg.frontendUrl}/merchant`,
  )
  try {
    // The PLATFORM's own address, stated rather than left to the adapter's default: the shop is
    // the recipient here, and an alert wearing `senderFrom`'s shop name would read as a copy of
    // the customer's receipt. Passing it explicitly is also what makes the choice observable to
    // a test instead of an invisible fallback.
    await send(to, subject, { text, html, from: cfg.emailFrom })
    return { ok: true }
  } catch (e: any) {
    // The claim was taken above and the mail did not go — hand it back so a retry can. This is
    // the shop's only notice on a basic plan, so a permanently retired claim is a lost order.
    await releaseClaim(db, order.id, 'merchant_emailed_at')
    return { ok: false, error: e?.message ?? String(e) }
  }
}
