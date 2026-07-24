import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { fetchMyBilling, openBillingPortal, startCheckout } from '../store'
import { usePlatformPricing } from '../usePlatformPricing'
import { formatMoney } from '../currency'
import { fmtDate } from '../merchantDate'
import { subscriptionTabState, type SubscriptionSnapshot } from './subscriptionTabState'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { SkeletonText } from '../components/Loaders'

// Settings → Subscription (#112). The one place that answers "what plan am I on, what does it
// cost, when does it renew" — BillingBanner only speaks in trouble states, so a healthy paying
// merchant previously saw nothing about their subscription anywhere in the app.
//
// The plan SWITCH happens in Stripe's Customer Portal, not here: the portal owns proration and
// scheduling, and `customer.subscription.updated` brings the new tier back into `merchants.plan`.
// This screen's job is to explain the decision and hand off.
//
// It deliberately grows no "start subscription" button. SuspendedScreen already owns
// reactivation via Checkout, and a shop with no live subscription cannot reach these tabs.

const CARD = 'bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-6 w-full box-border max-sm:p-4'
const HEADING = 'font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2'

// What Pro adds, as it exists in code today. #110 gates exactly these three; the other four the
// marketing page advertises are not built, and listing them here would be selling vapour.
const PRO_FEATURES: [string, string][] = [
  ['Telegram order alerts', 'Telegram 订单通知'],
  ['Discount vouchers', '优惠券'],
  ['Product promo pricing', '商品优惠价'],
]

/**
 * The hand-off to Stripe. Lives here rather than beside the Pro locks because it is the terminal
 * action — everything else in the dashboard routes to this tab first, so the merchant sees the
 * price before a payment screen. Only rendered when the shop HAS a Stripe customer: the endpoint
 * 404s otherwise, and a button that cannot work is the dead end this tab exists to remove.
 */
function PortalButton({ label }: { label: string }) {
  const { t } = useSession()
  const [busy, setBusy] = useState(false)
  async function toPortal() {
    setBusy(true)
    try { window.location.assign(await openBillingPortal()) }
    catch (err: any) {
      // Reachable despite the `canManage` gate: the billing row can change under a long-open
      // tab. Say so rather than leaving the button silently inert.
      toast.error(err?.message || t('Could not open the billing portal', '无法打开账单门户'))
      setBusy(false)
    }
  }
  // size="sm" deliberately: the default size is `w-full` (the auth/save button geometry), which
  // would stretch this across the card.
  return (
    <Button type="button" size="sm" onClick={toPortal} disabled={busy}>
      {busy ? t('Opening…', '打开中…') : label}
    </Button>
  )
}

/**
 * Buying a subscription outright, for an active shop that has none — the complement of
 * PortalButton, never shown beside it.
 *
 * `POST /api/checkout` refuses a shop whose subscription is trialing/active/past_due, which is
 * exactly when `canManage` is true, so the two buttons cannot both appear and this cannot create
 * a second subscription. It grants no trial either: trials come only from superadmin approval.
 */
function CheckoutButton({ plan, cycle, label }: { plan: string; cycle: string; label: string }) {
  const { t } = useSession()
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    try { window.location.assign(await startCheckout({ plan, billing: cycle })) }
    catch (err: any) {
      toast.error(err?.message || t('Could not start checkout', '无法开始结账'))
      setBusy(false)
    }
  }
  return (
    <Button type="button" size="sm" onClick={go} disabled={busy}>
      {busy ? t('Opening…', '打开中…') : label}
    </Button>
  )
}

export default function SubscriptionTab() {
  const { t, merchant } = useSession()
  const { pricing } = usePlatformPricing()
  const [billing, setBilling] = useState<SubscriptionSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false)
  const merchantId = merchant?.id

  useEffect(() => {
    if (!merchantId) return
    let on = true
    fetchMyBilling(merchantId)
      .then(b => { if (on) { setBilling(b); setLoaded(true) } })
      .catch(() => { if (on) setLoaded(true) })
    return () => { on = false }
  }, [merchantId])

  // The clock is read once per render pass and handed to the pure module, rather than consulted
  // inside it — same discipline as ProductsManager's promoEnded.
  const state = subscriptionTabState(billing, merchant?.plan, new Date())

  const cycle = merchant?.billing_cycle === 'yearly' ? 'yearly' : 'monthly'
  const planPrice = pricing.prices[state.plan === 'pro' ? 'pro' : 'basic'][cycle]
  const proPrice = pricing.prices.pro[cycle]
  const per = cycle === 'yearly' ? t('/year', '/年') : t('/month', '/月')

  if (!loaded) return <div className={CARD}><SkeletonText /></div>

  return (
    <div className="w-full">
      <div className={CARD}>
        <h3 className={HEADING}>{t('Your plan', '您的方案')}</h3>
        <div className="flex items-center gap-3 flex-wrap mb-3">
          <span className="font-heading text-[22px] text-oxblood">
            {state.plan === 'pro' ? 'Pro' : t('Basic', '基础版')}
          </span>
          <Badge variant={state.plan === 'pro' ? 'default' : 'outline'} className="uppercase tracking-[0.08em]">
            {state.plan === 'pro' ? 'Pro' : t('Basic', '基础版')}
          </Badge>
          <span className="text-[13px] text-text-secondary">
            {formatMoney(planPrice, pricing.currency)}{per}
          </span>
        </div>

        <p className="text-[13px] text-text-secondary leading-[1.6]">
          {state.kind === 'trial'
            ? (state.daysLeft > 0
                ? t(`Free trial — ${state.daysLeft} days left, ending ${fmtDate(state.trialEndsAt)}.`,
                    `免费试用——还剩 ${state.daysLeft} 天，${fmtDate(state.trialEndsAt)} 结束。`)
                : t(`Free trial — ending today, ${fmtDate(state.trialEndsAt)}.`,
                    `免费试用——今天 ${fmtDate(state.trialEndsAt)} 结束。`))
            : state.kind === 'past-due'
              ? t('Payment failed. Update your card to keep your shop open.',
                  '付款失败。请更新银行卡以保持店铺营业。')
              : state.kind === 'live'
                ? (state.renewsAt
                    ? t(`Renews on ${fmtDate(state.renewsAt)}.`, `将于 ${fmtDate(state.renewsAt)} 续订。`)
                    : t('Active.', '有效。'))
                : t('No subscription on file for this shop yet.',
                    '此店铺尚无订阅记录。')}
        </p>

        {/* Gated on canManage, NOT on canUpgrade: a Pro shop cannot upgrade but must still be
            able to change its card, read invoices, or step back down to Basic — a sentence
            promising the billing portal with no way to reach it is the same dead end in a
            different costume. */}
        {state.canManage && (
          <>
            <div className="mt-4">
              <PortalButton label={t('Manage subscription', '管理订阅')} />
            </div>
            <p className="text-[12px] text-text-tertiary mt-3">
              {t('Change plan, update your card or view invoices in the billing portal.',
                '在账单门户中更改方案、更新银行卡或查看账单。')}
            </p>
          </>
        )}
      </div>

      {/* The pitch is shown to any shop that is not already Pro, INCLUDING one with no
          subscription behind it: a Pro lock's CTA promises "see the price and what Pro adds",
          and a comped or pre-checkout shop that lands here must find that, not a blank tab.
          Only the BUTTON depends on there being a Stripe customer to send them to. */}
      {state.canUpgrade && (
        <div className={CARD}>
          <h3 className={HEADING}>
            {t('Upgrade to Pro', '升级到 Pro')}
            <Badge variant="default" className="uppercase tracking-[0.08em]">Pro</Badge>
          </h3>
          <p className="text-[13px] text-text-secondary mb-4">
            {t(`${formatMoney(proPrice, pricing.currency)}${per} — everything in Basic, plus:`,
              `${formatMoney(proPrice, pricing.currency)}${per} — 包含基础版全部功能，另加：`)}
          </p>
          <ul className="flex flex-col gap-2 mb-5">
            {PRO_FEATURES.map(([en, zh]) => (
              <li key={en} className="flex items-center gap-2 text-[13px] text-ink">
                <Check size={15} strokeWidth={2} className="text-oxblood shrink-0" aria-hidden />
                {t(en, zh)}
              </li>
            ))}
          </ul>
          {/* The portal does the swap; the price change and any proration are Stripe's to
              explain, on a screen built for it. */}
          {/* Two routes to the same tier, decided by whether there is a subscription to change.
              With one: the portal swaps the price on it. Without one (an active shop approved
              without a trial, or one whose subscription lapsed): Checkout sells a new one, which
              the `checkout.session.completed` reconciliation then turns into real Pro access. */}
          {state.canManage ? (
            <>
              <PortalButton label={t('Upgrade to Pro', '升级到 Pro')} />
              <p className="text-[12px] text-text-tertiary mt-3">
                {t('You will pick the Pro plan in the billing portal. A downgrade later takes effect at the end of the period you have paid for.',
                  '您将在账单门户中选择 Pro 方案。日后如降级，将在已付费周期结束时生效。')}
              </p>
            </>
          ) : (
            <>
              <CheckoutButton plan="pro" cycle={cycle} label={t('Upgrade to Pro', '升级到 Pro')} />
              <p className="text-[12px] text-text-tertiary mt-3">
                {t('This shop has no subscription yet, so this starts a new one at the Pro price.',
                  '此店铺尚无订阅，将以 Pro 价格开始新的订阅。')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
