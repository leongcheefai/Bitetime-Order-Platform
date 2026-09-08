import type { OrderEvent, OrderEventKind } from '@bitetime/shared'
import { STATUS_LABELS } from '../../orderStatus'
import { courierName } from '../../couriers'
import { formatCalendarDate } from '../../orderDate'
import type { Translate } from '../../types'

/**
 * One line of the order log (#268), as the merchant reads it. See CONTEXT.md → Order log.
 *
 * The merchant is "you": their own actions name no actor, and the customer and the system are
 * named only because they are not the reader. A status the module has not been taught renders
 * its raw value rather than nothing — a wrong word beats a blank line that reads as "nothing
 * happened". The switch is exhaustive over `OrderEventKind`: a kind the backend gains and this
 * table has not fails the build, and `orderEventLine.test.ts` sweeps the list for the same
 * reason at run time.
 */
export function orderEventLine(e: OrderEvent, t: Translate): string {
  const kind: OrderEventKind = e.kind
  switch (kind) {
    case 'created':
      return e.detail.status === 'pending_payment'
        ? t('Order placed, awaiting payment', '已下单，待付款')
        : t('Order placed', '已下单')
    case 'payment_proof_uploaded':
      return t('Customer uploaded a payment proof', '顾客上传了付款凭证')
    case 'merchant_payment_proof_uploaded':
      return t('You filed a payment proof', '你存档了付款凭证')
    case 'status_changed': {
      const to = statusLabel(e.detail.to, t)
      return e.actor_kind === 'system'
        ? t(`Moved to ${to} automatically`, `自动变更为${to}`)
        : t(`You marked it ${to}`, `你标记为${to}`)
    }
    case 'note_changed':
      return t('You edited the note', '你编辑了备注')
    case 'courier_changed': {
      const to = typeof e.detail.to === 'string' ? e.detail.to : null
      if (!to) return t('You cleared the courier', '你清除了快递公司')
      const name = courierName(to) || to
      return t(`You set the courier to ${name}`, `你将快递公司设为${name}`)
    }
    case 'awb_changed': {
      const to = typeof e.detail.to === 'string' ? e.detail.to : null
      if (!to) return t('You cleared the tracking number', '你清除了运单号')
      return t(`You set the tracking number to ${to}`, `你将运单号设为${to}`)
    }
    case 'fulfil_date_changed': {
      // The same formatter the header and the list use, so the log names the day the way the
      // rest of the drawer does. `t` carries no language of its own, so the two sentences are
      // rendered in both and `t` picks — the one place this file needs a date in each.
      const to = typeof e.detail.to === 'string' ? e.detail.to : ''
      const from = typeof e.detail.from === 'string' ? e.detail.from : null
      if (!from) return t(`You set the date to ${formatCalendarDate(to, 'en')}`, `你将日期设为${formatCalendarDate(to, 'zh')}`)
      return t(
        `You moved the date from ${formatCalendarDate(from, 'en')} to ${formatCalendarDate(to, 'en')}`,
        `你将日期从${formatCalendarDate(from, 'zh')}改为${formatCalendarDate(to, 'zh')}`,
      )
    }
    case 'voucher_released':
      return t(`Voucher ${codeOf(e)} use returned`, `优惠券 ${codeOf(e)} 的使用次数已退回`)
    case 'voucher_restored':
      return t(`Voucher ${codeOf(e)} use taken back`, `优惠券 ${codeOf(e)} 的使用次数已收回`)
    default: {
      const never: never = kind
      return never
    }
  }
}

function statusLabel(v: unknown, t: Translate): string {
  const s = typeof v === 'string' ? v : ''
  const l = STATUS_LABELS[s]
  return l ? t(l.en, l.zh) : s
}

function codeOf(e: OrderEvent): string {
  return typeof e.detail.code === 'string' ? e.detail.code : '—'
}
