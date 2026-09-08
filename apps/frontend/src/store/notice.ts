import type { VoucherErrorCode } from '@bitetime/shared'
import { formatMoney } from '../currency'
import { orderRefusalPlan, type OrderRefusalCode, type Translate } from './orderRefusal'

/**
 * The two message strips the checkout keeps on screen — the order error and the voucher line —
 * as WHAT HAPPENED rather than as a sentence about it.
 *
 * They used to be stored already rendered, which froze them in whatever language was current
 * when they were written. `LanguageSelect` sits in the storefront's own header, so a customer
 * could switch EN↔ZH and watch the whole page change around one line that did not (#134). #121
 * had already fixed exactly this for the delivery-quote refusal, by storing the refusal CODE and
 * rendering it at paint time; these two were left alone only to keep that diff honest.
 *
 * Language is not the only thing that can move underneath a stored sentence. The order-refusal
 * copy takes `pickupEscape`, which a `refreshMerchant()` can turn on mid-session — a frozen
 * string goes on withholding an escape the shop now offers.
 *
 * A toast is deliberately NOT modelled here. It fires once and is gone, so there is no stored
 * value for a later switch to contradict; `adoptProducts`' prune message stays a plain string.
 */
export type Notice =
  /** A lookup is in flight. Transient, but it is still a line on screen. */
  | { readonly kind: 'voucher_checking' }
  /** The voucher was refused by the pure rules — `voucherError`'s own vocabulary. */
  | { readonly kind: 'voucher_error'; readonly code: VoucherErrorCode }
  /**
   * Applied. Carries the discount ITSELF, not a rendered "RM 5.00 off": the money has to be
   * formatted in the shop's currency at paint time, which is the second thing a stored sentence
   * would have frozen.
   */
  | { readonly kind: 'voucher_applied'; readonly type: string; readonly value: number }
  /** The session ended under a mounted checkout, so the voucher went with it (#72). */
  | { readonly kind: 'voucher_signed_out'; readonly voucherCode: string }
  /** A recovery re-read the voucher and it no longer exists. */
  | { readonly kind: 'voucher_gone' }
  /**
   * The basket is under an applied voucher's minimum. NOT a refusal — the voucher stays on and
   * the message states the gap, because prompting the customer to spend a little more is the
   * whole purpose of a minimum-order voucher. `priceOrder` has already dropped the discount to
   * zero, so nothing on screen claims money the order will not get.
   */
  | { readonly kind: 'voucher_shortfall'; readonly shortfall: number; readonly voucherCode: string }
  /** The order was refused. The copy is `orderRefusal.ts`'s decision; this only remembers which. */
  | { readonly kind: 'order_refusal'; readonly code: OrderRefusalCode | undefined }

export interface NoticeCtx {
  readonly t: Translate
  /** The shop's currency, for the applied-voucher line. */
  readonly currency?: string | null
  /** The shop offers pickup, so a delivery refusal may point at it. */
  readonly pickupEscape: boolean
  /** This order is distance-priced and holds a place id, so a re-quote is possible. */
  readonly canRequote: boolean
}

/** What a voucher refusal says. Its own function because two strips render the same codes. */
export function voucherErrorText(code: VoucherErrorCode | 'invalid', t: Translate): string {
  switch (code) {
    case 'invalid': return t('Invalid voucher code.', '无效的优惠码。')
    case 'fully_used': return t('This voucher has been fully redeemed.', '此优惠券已用完。')
    // Not "you have already used this": a merchant may allow several redemptions each, so the
    // customer being turned away here may be on their fourth of three.
    case 'customer_limit_reached': return t('You have used this voucher as many times as allowed.', '您使用此优惠券的次数已达上限。')
    case 'expired': return t('This voucher has expired.', '此优惠券已过期。')
    // The FALLBACK wording only. A basket under the minimum keeps the voucher applied and gets
    // `voucher_shortfall` instead, which can name the amount still needed; this is what a caller
    // with no figure to hand says.
    case 'min_order': return t('Your order is below this voucher\u2019s minimum.', '您的订单未达到此优惠券的最低消费。')
    default: return ''
  }
}

/**
 * Render a notice, in the language and for the shop the customer is looking at RIGHT NOW.
 *
 * Called during render, never stored. That is the whole point: every input a sentence depends on
 * — the language, the currency, whether this shop can offer pickup — is read at the moment it is
 * painted rather than at the moment the thing happened.
 */
export function noticeText(notice: Notice, ctx: NoticeCtx): string {
  const { t } = ctx
  switch (notice.kind) {
    case 'voucher_checking':
      return t('Checking voucher…', '验证优惠券…')

    case 'voucher_error':
      return voucherErrorText(notice.code, t)

    case 'voucher_applied': {
      // `percent` prints a bare number; anything else is money, and money needs the shop's
      // currency — which a stored sentence would have frozen alongside the language.
      //
      // The SAME label in both languages, carried over unchanged: the Chinese line reads
      // "优惠券已应用：RM 5.00 off", with an untranslated "off". That is a real copy gap and it
      // predates this change — fixing it here would put a translation edit inside a bug fix
      // about language REACTIVITY, and make the diff say two things at once.
      const label = notice.type === 'percent'
        ? `${notice.value}% off`
        : `${formatMoney(notice.value, ctx.currency)} off`
      return t(`✓ Voucher applied: ${label}`, `✓ 优惠券已应用：${label}`)
    }

    case 'voucher_signed_out':
      return t(
        `Signed out — the voucher ${notice.voucherCode} was removed. Sign in again to use it.`,
        `已退出登录 — 优惠券 ${notice.voucherCode} 已移除，请重新登录后使用。`,
      )

    case 'voucher_gone':
      return t('That voucher is no longer available.', '此优惠券已失效。')

    case 'voucher_shortfall': {
      const gap = formatMoney(notice.shortfall, ctx.currency)
      return t(
        `Add ${gap} more to use ${notice.voucherCode}.`,
        `再消费 ${gap} 即可使用 ${notice.voucherCode}。`,
      )
    }

    case 'order_refusal':
      // The one place that decides what a refusal says, and it is not this one.
      return orderRefusalPlan(notice.code, {
        t,
        pickupEscape: ctx.pickupEscape,
        canRequote: ctx.canRequote,
      }).message

    default: {
      // A notice kind added without copy fails the build here. The runtime fallback is for a
      // shape that somehow survives that, and an empty strip is the right nothing to show.
      const _exhaustive: never = notice
      void _exhaustive
      return ''
    }
  }
}
