import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMyBilling, openBillingPortal } from '../store'
import { billingBannerState, type BillingSnapshot } from './billingBannerState'
import { useUpgradeNav } from './UpgradeNav'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Persistent billing banner at the top of the merchant dashboard. Deliberately
// not dismissible: trial expiry and failed payments are the two states a
// merchant must not be able to hide from themselves.
export default function BillingBanner() {
  const { t, lang, merchant } = useSession()
  const { goToSubscription } = useUpgradeNav()
  const [billing, setBilling] = useState<BillingSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const merchantId = merchant?.id

  useEffect(() => {
    if (!merchantId) return
    let on = true
    fetchMyBilling(merchantId).then(b => { if (on) setBilling(b) })
    return () => { on = false }
  }, [merchantId])

  const state = billingBannerState(billing, new Date())
  if (state.kind === 'none') return null

  async function toPortal() {
    setBusy(true)
    try { window.location.assign(await openBillingPortal()) }
    catch { setBusy(false) }
  }

  // An ending subscription is urgent by definition: when it lapses the shop is suspended and
  // customers can no longer order.
  const urgent = state.kind === 'past-due' || state.kind === 'ending' || (state.kind === 'trial' && state.urgent)
  const endsOn = state.kind === 'ending' && state.endsAt
    ? new Date(state.endsAt).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB',
        { year: 'numeric', month: 'short', day: 'numeric' })
    : ''
  const carded = state.kind === 'trial' && state.hasPaymentMethod
  const countdown = state.kind === 'trial'
    ? (state.daysLeft > 0
        ? t(`${state.daysLeft} days ${state.hoursLeft}h`, `${state.daysLeft} 天 ${state.hoursLeft} 小时`)
        : t(`${state.hoursLeft} hours`, `${state.hoursLeft} 小时`))
    : ''
  const convertsOn = billing?.trial_ends_at
    ? new Date(billing.trial_ends_at).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB',
        { year: 'numeric', month: 'short', day: 'numeric' })
    : ''

  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 flex-wrap px-4 py-3 mb-5 rounded-md border-[1.5px] text-[13px] leading-[1.5]',
        urgent ? 'bg-danger-bg text-danger-fg border-danger-fg/25' : 'bg-warn-bg text-warn-fg border-warn-fg/25',
      )}
    >
      <span className="flex-1 min-w-[200px] font-medium">
        {state.kind === 'ending'
          ? (endsOn
              ? t(`Your subscription ends on ${endsOn} — your shop is suspended after that.`,
                  `您的订阅将于 ${endsOn} 结束——之后店铺将被停用。`)
              : t('Your subscription ends when the current period does — your shop is suspended after that.',
                  '您的订阅将在本周期结束时终止——之后店铺将被停用。'))
          : state.kind === 'past-due'
          ? t('Payment failed — update your card to keep your shop open.',
              '付款失败——请更新银行卡以保持店铺营业。')
          : carded
            ? t(`Free trial — converts to a paid plan on ${convertsOn}.`,
                `免费试用——将于 ${convertsOn} 转为付费方案。`)
            : state.urgent
              ? t(`Your free trial ends in ${countdown}. Add a payment method to keep your shop open.`,
                  `免费试用将在 ${countdown} 后结束。请添加付款方式以保持店铺营业。`)
              : t(`Free trial — ${countdown} left.`, `免费试用——剩余 ${countdown}。`)}
      </span>
      <Button
        size="none"
        variant="outline"
        className="py-[5px] px-3 rounded-pill text-[12px] whitespace-nowrap bg-surface-raised hover:bg-oxblood-tint hover:text-oxblood hover:border-oxblood"
        disabled={busy}
        // An ending subscription is the one state Stripe's portal cannot resolve: the way back
        // is undoing the cancellation, and that button lives on the Subscription tab.
        onClick={state.kind === 'ending' ? goToSubscription : toPortal}
      >
        {busy
          ? t('Opening…', '打开中…')
          : state.kind === 'ending'
            ? t('Keep my subscription', '继续订阅')
            : state.kind === 'past-due'
              ? t('Update card', '更新银行卡')
              : carded
                ? t('Manage billing', '管理账单')
                : t('Add payment method', '添加付款方式')}
      </Button>
    </div>
  )
}
