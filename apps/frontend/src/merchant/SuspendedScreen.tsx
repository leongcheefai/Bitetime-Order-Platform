import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { useSession } from '../SessionContext'
import { startCheckout, fetchMyBilling, openBillingPortal } from '../store'
import { trackEvent, toBilling } from '../analytics/events'
import { formatMoney } from '../currency'
import { usePlatformPricing } from '../usePlatformPricing'
import { PRICING_TIERS } from '../marketing/pricingTiers'
import { defaultReactivation, yearlySavingPercent, type Cycle } from './reactivationChoice'
import OrdersView from './OrdersView'
import TrialFeedbackPrompt from './TrialFeedbackPrompt'
import { Button } from '@/components/ui/button'

// Suspended = the subscription lapsed (trial ended unpaid, cancellation) or a superadmin action.
// The storefront is closed to customers; the merchant keeps read-only access to their order
// history and one path back: pay. Reactivation Checkout never grants a second trial (backend
// guarantees it).
//
// UNPAID RENEWAL IS THE EXCEPTION, and it needs its own screen. That shop's subscription is not
// gone — Stripe still holds it, still calls it live, and is still retrying the card — so
// `POST /api/checkout` REFUSES it (`This shop already has an active subscription`) and the button
// below is a dead end. What reopens it is paying the invoice that failed, which lives in the
// Stripe portal; the backend then reopens the shop on its own. See `unpaidRenewal`.
//
// The one choice left is the billing cycle, offered on the same axis the signup flow does and
// priced from the same live Stripe figures. What the subscription includes comes from
// PRICING_TIERS rather than a local list, for the reason that file states: a feature list
// copy-pasted into a second place is a product that quietly disagrees with itself.
export default function SuspendedScreen() {
  const { t, lang, merchant } = useSession()
  const { pricing } = usePlatformPricing()
  const [cycle, setCycle] = useState<Cycle>(defaultReactivation(merchant).cycle)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // `undefined` = not read yet, and it renders NOTHING rather than guessing. Guessing wrong shows
  // a merchant whose card failed an offer to start a subscription they already have.
  const [billing, setBilling] = useState<{
    status?: string | null
    dunning_suspended_at?: string | null
  } | null | undefined>(undefined)
  const merchantId = merchant?.id

  useEffect(() => {
    if (!merchantId) return
    let on = true
    fetchMyBilling(merchantId).then(r => { if (on) setBilling(r.ok ? r.data : null) })
    return () => { on = false }
  }, [merchantId])

  // No shop to read a row for is a settled answer, not a pending one — derived rather than set in
  // the effect, which would be a synchronous setState and a second render for nothing.
  const row = merchantId ? billing : null

  // The platform closed this shop for an unpaid invoice. `dunning_suspended_at` is the platform's
  // own record of that; the status test carries a shop closed before the stamp existed.
  const unpaidRenewal = !!row?.dunning_suspended_at || row?.status === 'past_due'

  async function toPortal() {
    setBusy(true); setErr('')
    const r = await openBillingPortal()
    if (r.ok) window.location.assign(r.data)
    else {
      setErr(r.error.message || t('Could not open the billing portal', '无法打开账单门户'))
      setBusy(false)
    }
  }

  async function reactivate() {
    setBusy(true); setErr('')
    // Reported BEFORE the redirect, for the same reason it is in SubscriptionTab: assign() leaves
    // this page and nothing after it runs. `from` is what separates a reactivation from an
    // ordinary upgrade in the funnel.
    trackEvent('billing_checkout_started', {
      billing: toBilling(cycle),
      from: 'suspended',
    })
    const r = await startCheckout({ billing: cycle })
    if (r.ok) window.location.assign(r.data)
    else {
      setErr(r.error.message || t('Could not start checkout', '无法开始结账'))
      setBusy(false)
    }
  }

  if (row === undefined) return null

  if (unpaidRenewal) {
    return (
      <div className="w-full max-w-[720px] mx-auto pt-8 px-4 pb-12">
        <div
          role="status"
          className="px-4 py-3 mb-6 rounded-md border-[0.5px] text-[13px] leading-[1.5] bg-danger-100 text-danger-fg border-danger-fg/25 font-medium"
        >
          {t('Your shop is closed — the subscription payment failed. Pay the outstanding invoice to reopen it.',
             '您的店铺已关闭——订阅付款失败。请支付未结账单以恢复营业。')}
        </div>

        <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-6 w-full box-border max-sm:p-4">
          <h2 className="font-heading text-[15px] font-medium text-primary mb-2">
            {t('Reopen your shop', '重新开张')}
          </h2>
          {/* No cycle picker and no price card: this shop is not buying anything. It has a
              subscription, on the plan it chose, with one invoice unpaid. */}
          <p className="text-[13px] text-muted-foreground mb-4 leading-[1.5]">
            {t('Your subscription is still active — only the last payment failed. Update your card or pay the invoice in the billing portal, and your shop reopens by itself within the hour.',
               '您的订阅仍然有效——只是最后一次付款失败。请在账单门户更新银行卡或支付账单，您的店铺将在一小时内自动恢复营业。')}
          </p>
          <Button type="button" size="sm" disabled={busy} onClick={toPortal}>
            {busy ? t('Opening…', '打开中…') : t('Pay now — reopen my shop', '立即付款——恢复营业')}
          </Button>
          <p className="text-[12px] text-muted-foreground mt-3">
            {t('Nothing has been deleted. Your menu, orders and settings are exactly as you left them.',
               '没有任何数据被删除。您的菜单、订单和设置均保持原样。')}
          </p>
        </div>

        {err && (
          <div className="text-[13px] text-foreground-secondary bg-brand-wash border border-border rounded-sm px-[13px] py-[10px] mb-4 leading-[1.5]">
            {err}
          </div>
        )}
        <h2 className="font-heading text-[18px] font-medium text-primary mb-3">
          {t('Your orders', '您的订单')}
        </h2>
        <OrdersView readOnly />
      </div>
    )
  }

  const saving = yearlySavingPercent(pricing.prices.pro.monthly, pricing.prices.pro.yearly)
  const per = cycle === 'yearly' ? t('/year', '/年') : t('/month', '/月')

  return (
    <div className="w-full max-w-[720px] mx-auto pt-8 px-4 pb-12">
      <div
        role="status"
        className="px-4 py-3 mb-6 rounded-md border-[0.5px] text-[13px] leading-[1.5] bg-danger-100 text-danger-fg border-danger-fg/25 font-medium"
      >
        {t('Your shop is suspended — your subscription has ended. Subscribe below to reopen it.',
           '您的店铺已暂停——订阅已结束。请在下方订阅以恢复营业。')}
      </div>

      <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-6 w-full box-border max-sm:p-4">
        <h2 className="font-heading text-[15px] font-medium text-primary mb-4">
          {t('Reopen your shop', '重新开张')}
        </h2>

        {/* Cycle first, because it reprices the card below. */}
        <div
          role="radiogroup"
          aria-label={t('Billing cycle', '付费周期')}
          className="inline-flex p-[3px] mb-5 rounded-pill border-[0.5px] border-border bg-card"
        >
          {(['monthly', 'yearly'] as Cycle[]).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={cycle === c}
              onClick={() => setCycle(c)}
              className={`py-[5px] px-4 rounded-pill text-[13px] cursor-pointer transition-colors ${
                cycle === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-primary'
              }`}
            >
              {c === 'monthly' ? t('Monthly', '按月') : t('Yearly', '按年')}
              {/* Only ever rendered from live prices, and only when there is a real saving to
                  claim — see yearlySavingPercent. */}
              {c === 'yearly' && saving !== null && (
                <span className={cycle === c ? 'ml-1.5 opacity-90' : 'ml-1.5 text-primary'}>
                  {t(`− ${saving}%`, `省 ${saving}%`)}
                </span>
              )}
            </button>
          ))}
        </div>

        {(() => {
          const tier = PRICING_TIERS[0]
          const price = pricing.prices.pro[cycle]
          return (
            <div className="w-full p-4 mb-5 rounded-xl border-[0.5px] border-primary bg-brand-wash">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="font-heading text-[15px] font-medium text-primary">
                  {tier.name[lang]}
                </span>
                <span className="text-[15px] font-medium text-foreground">
                  {formatMoney(price, pricing.currency)}
                  <span className="text-[12px] text-muted-foreground">{per}</span>
                </span>
              </div>
              <p className="text-[12px] text-muted-foreground mb-2">{tier.blurb[lang]}</p>
              <ul className="flex flex-col gap-1">
                {tier.features.map((f) => (
                  <li key={f.en} className="flex items-start gap-1.5 text-[12px] text-foreground">
                    <Check size={13} strokeWidth={2} className="text-primary shrink-0 mt-[3px]" aria-hidden />
                    {f[lang]}
                  </li>
                ))}
              </ul>
            </div>
          )
        })()}

        <Button type="button" size="sm" disabled={busy} onClick={reactivate}>
          {busy ? t('Redirecting…', '跳转中…') : t('Reopen my shop — pay now', '恢复营业——立即付款')}
        </Button>
        {/* Stated because it is the one thing a returning merchant is most likely to assume
            wrongly, and the backend enforces it regardless of what this screen says. */}
        <p className="text-[12px] text-muted-foreground mt-3">
          {t('Reopening starts a new subscription and is charged today — the free trial is one per shop.',
             '恢复营业将开启新的订阅并于今日扣款——免费试用每家店铺仅一次。')}
        </p>
      </div>

      <TrialFeedbackPrompt />
      {err && (
        <div className="text-[13px] text-foreground-secondary bg-brand-wash border border-border rounded-sm px-[13px] py-[10px] mb-4 leading-[1.5]">
          {err}
        </div>
      )}
      <h2 className="font-heading text-[18px] font-medium text-primary mb-3">
        {t('Your orders', '您的订单')}
      </h2>
      <OrdersView readOnly />
    </div>
  )
}
