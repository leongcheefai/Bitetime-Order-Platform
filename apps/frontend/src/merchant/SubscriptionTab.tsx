import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ExternalLink, Timer } from 'lucide-react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import {
  fetchMyBilling, openBillingPortal, startCheckout,
  cancelSubscription, downgradeToBasic, resumeSubscription,
} from '../store'
import { usePlatformPricing } from '../usePlatformPricing'
import { formatMoney } from '../currency'
import { fmtDate } from '../merchantDate'
import { subscriptionTabState, type SubscriptionSnapshot } from './subscriptionTabState'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../components/ui/dialog'
import { SkeletonText } from '../components/Loaders'

// Settings → Subscription (#112). The one place that answers "what plan am I on, what does it
// cost, when does it renew" — BillingBanner only speaks in trouble states, so a healthy paying
// merchant previously saw nothing about their subscription anywhere in the app.
//
// The UPGRADE happens in Stripe's Customer Portal: a mid-period tier increase is a proration
// argument, and the portal is a screen built to have it. The wind-down actions — cancel, step
// down to Basic, and undoing either — happen HERE, because they all land on a period boundary,
// so no money moves and there is nothing a payment screen needs to explain. What that buys is
// the thing the portal cannot say: that cancelling suspends this shop, on a named date, in the
// merchant's own language.

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

/**
 * A wind-down action behind a confirmation naming what it costs and when.
 *
 * Confirmed rather than one-click because neither is undone by pressing the button again:
 * cancelling closes the shop, and stepping down to Basic permanently deactivates the vouchers
 * already in customers' hands. `Resume` is the one that needs no dialog — it only ever puts
 * things back.
 *
 * The dialog body is passed in rather than derived, because the honest sentence differs per
 * action and each one has to name a real date.
 */
function ConfirmAction({
  label, title, body, confirmLabel, destructive, severe, alert, run, onDone,
}: {
  label: string
  title: string
  body: ReactNode
  confirmLabel: string
  destructive?: boolean
  /**
   * The action takes the shop OFFLINE (cancellation), as opposed to merely lowering the tier.
   * It turns the dialog red — a danger callout at the top and a solid-red confirm — so a merchant
   * cannot mistake it for the reversible, shop-stays-open change that sits right next to it.
   */
  severe?: boolean
  /** The one-line warning shown in the danger callout when `severe`. */
  alert?: ReactNode
  run: () => Promise<void>
  onDone: () => void
}) {
  const { t } = useSession()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const descId = useId()

  async function confirm() {
    setBusy(true)
    try {
      await run()
      setOpen(false)
      // Refetch rather than patch local state: the backend writes the outcome to
      // `merchant_billing` itself, and re-reading it is what keeps this tab honest if Stripe
      // returned something other than what was asked for.
      onDone()
    } catch (err: any) {
      toast.error(
        err?.message === 'no_live_subscription'
          ? t('This shop no longer has a subscription to change. Reload the page.',
              '此店铺已无可更改的订阅。请刷新页面。')
          : err?.message || t('That did not work. Please try again.', '操作失败，请重试。'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        type="button" size="sm" variant={destructive ? 'destructive' : 'outline'}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* Describe the dialog with our own body node rather than DialogDescription: the body
            can be a list, and a <ul> nested in the <p> that DialogDescription renders is invalid
            HTML. aria-describedby keeps it accessible. */}
        <DialogContent aria-describedby={descId}>
          <DialogHeader>
            <DialogTitle className={severe ? 'text-danger flex items-center gap-2' : undefined}>
              {severe && <AlertTriangle size={17} strokeWidth={2.25} className="shrink-0" aria-hidden />}
              {title}
            </DialogTitle>
          </DialogHeader>
          {/* A shop-offline action leads with a red callout, not a calm paragraph, so the
              consequence is the first thing read rather than the last. */}
          {severe && alert && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border-[1.5px] border-danger-border bg-danger-bg text-danger-fg px-3 py-2 text-[13px] font-medium leading-[1.5]"
            >
              <AlertTriangle size={15} strokeWidth={2.25} className="shrink-0 mt-[2px]" aria-hidden />
              <span>{alert}</span>
            </div>
          )}
          <div id={descId} className="text-sm text-rose-muted flex flex-col gap-2">{body}</div>
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {t('Never mind', '取消')}
            </Button>
            <Button
              type="button" size="sm"
              variant={destructive ? 'destructive' : 'default'}
              // A severe action gets a SOLID red fill, not the pale rose destructive treatment
              // (the shared del-btn look). Suspending a shop is categorically heavier than
              // deleting a row, and the confirm must read as the most dangerous thing on screen —
              // heavier than "Never mind", never lighter. Scoped to this button; the shared
              // variant is untouched.
              className={severe ? 'bg-danger text-white border-danger hover:bg-danger/90 hover:border-danger' : undefined}
              onClick={confirm} disabled={busy}
            >
              {busy ? t('Working…', '处理中…') : confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * The downgrade confirm body: a lead line, the three Pro features that stop as a bulleted list,
 * then the reassurance the shop stays open. A list rather than a sentence because three distinct
 * things stop and a merchant deciding needs to weigh each — the run-on version buried them.
 * Mirrors the PRO_FEATURES the upgrade pitch lists, phrased as losses.
 */
function DowngradeBody({ renewsAt }: { renewsAt: string | null }) {
  const { t } = useSession()
  const stops: [string, string][] = [
    ['Telegram order alerts stop', 'Telegram 订单通知将停止'],
    ['Your discount vouchers stop working', '优惠券将失效'],
    ['Any running promo prices end', '进行中的优惠价将结束'],
  ]
  return (
    <>
      <p>
        {renewsAt
          ? t(`You keep Pro until ${fmtDate(renewsAt)}, then this shop moves to Basic and:`,
              `在 ${fmtDate(renewsAt)} 之前 Pro 功能仍可使用，之后店铺将转为基础版：`)
          : t('At the end of the period you have paid for, this shop moves to Basic and:',
              '在您已付费的周期结束后，店铺将转为基础版：')}
      </p>
      <ul className="flex flex-col gap-1 list-disc pl-5">
        {stops.map(([en, zh]) => <li key={en}>{t(en, zh)}</li>)}
      </ul>
      <p>{t('Your shop stays open.', '店铺本身照常营业。')}</p>
    </>
  )
}

/**
 * The cancel confirm body. Paired with the red `alert` callout above it: the callout states the
 * one fact that must not be missed (the shop closes), this fills in the timeline and the way
 * back. A list, same reasoning as DowngradeBody — the suspension is the point and must not be
 * buried mid-sentence.
 */
function CancelBody({ renewsAt }: { renewsAt: string | null }) {
  const { t } = useSession()
  return (
    <>
      <p>
        {renewsAt
          ? t(`Your shop stays open until ${fmtDate(renewsAt)}. After that:`,
              `在 ${fmtDate(renewsAt)} 之前店铺照常营业。之后：`)
          : t('Your shop stays open until the end of the period you have paid for. After that:',
              '在您已付费的周期结束前，店铺照常营业。之后：')}
      </p>
      <ul className="flex flex-col gap-1 list-disc pl-5">
        <li>{t('Your storefront goes offline — customers cannot find it', '店铺将下线——顾客无法找到')}</li>
        <li>{t('Customers cannot place new orders', '顾客无法下单')}</li>
      </ul>
      <p>{t('You can resubscribe at any time to reopen it.', '您可以随时重新订阅以重新开店。')}</p>
    </>
  )
}

/**
 * The trial callout — the one place a merchant sees "you are on a clock" without having to read
 * the plan sentence. A tinted card, not a rose one, so it reads as information rather than the
 * warning states the BillingBanner owns. The bar drains: `progress` is the fraction of the trial
 * still left, so a fuller bar means more runway.
 */
function TrialBanner({ daysLeft, trialEndsAt, progress }: {
  daysLeft: number; trialEndsAt: string; progress: number
}) {
  const { t } = useSession()
  const heading = daysLeft > 0
    ? t(`Your trial ends in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`,
        `试用还剩 ${daysLeft} 天`)
    : t('Your trial ends today', '试用今天结束')
  return (
    <div className="bg-cream border-[1.5px] border-rose-border rounded-2xl p-5 mb-6 w-full box-border max-sm:p-4">
      <div className="flex items-start gap-3">
        <Timer size={20} strokeWidth={2} className="text-oxblood shrink-0 mt-[2px]" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-heading text-[15px] font-medium text-oxblood">{heading}</p>
          <p className="text-[13px] text-text-secondary mt-0.5">
            {t(`Ending ${fmtDate(trialEndsAt)}.`, `${fmtDate(trialEndsAt)} 结束。`)}
          </p>
          {/* Draining bar: width tracks the fraction remaining. */}
          <div className="mt-3 h-1.5 w-full rounded-full bg-rose-border/40 overflow-hidden">
            <div
              className="h-full rounded-full bg-oxblood transition-[width] duration-300"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The billing facts, laid out as labelled cells — the Glide "Summary" block, minus the cells we
 * do not hold (card last4, account credit). Payment method and history both route to the Stripe
 * portal: the last4 and the invoices live there, and duplicating them here would mean a second
 * source to keep honest. Only rendered for a shop with a live subscription (`canManage`).
 */
function SummaryGrid({ nextPayment, renewalLabel, renewalValue }: {
  nextPayment: string | null
  renewalLabel: string
  renewalValue: string
}) {
  const { t } = useSession()
  const [busy, setBusy] = useState(false)
  async function toPortal() {
    setBusy(true)
    try { window.location.assign(await openBillingPortal()) }
    catch (err: any) {
      toast.error(err?.message || t('Could not open the billing portal', '无法打开账单门户'))
      setBusy(false)
    }
  }
  const label = 'text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary'
  const value = 'text-[14px] text-oxblood mt-1'
  const portalLink = 'text-[14px] text-oxblood underline underline-offset-2 mt-1 text-left disabled:opacity-60'
  return (
    <div className={CARD}>
      <h3 className={HEADING}>{t('Summary', '摘要')}</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 max-sm:grid-cols-1">
        {nextPayment && (
          <div>
            <p className={label}>{t('Next payment', '下次付款')}</p>
            <p className={value}>{nextPayment}</p>
          </div>
        )}
        <div>
          <p className={label}>{renewalLabel}</p>
          <p className={value}>{renewalValue}</p>
        </div>
        <div>
          <p className={label}>{t('Payment method', '付款方式')}</p>
          <button type="button" className={portalLink} onClick={toPortal} disabled={busy}>
            {t('Manage in portal', '在门户中管理')}
          </button>
        </div>
        <div>
          <p className={label}>{t('Payment history', '付款记录')}</p>
          <button type="button" className={portalLink} onClick={toPortal} disabled={busy}>
            {t('Billing portal', '账单门户')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function SubscriptionTab() {
  const { t, merchant } = useSession()
  const { pricing } = usePlatformPricing()
  const [billing, setBilling] = useState<SubscriptionSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false)
  const merchantId = merchant?.id

  // Extracted so the wind-down actions can re-read after Stripe has been told. `merchant.plan`
  // deliberately does NOT change here: the tier moves only when `reconcileMerchantPlan` sees the
  // price actually change, which is the whole reason a pending downgrade keeps its Pro features.
  const load = useCallback(() => {
    if (!merchantId) return
    fetchMyBilling(merchantId)
      .then(b => { setBilling(b); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [merchantId])

  useEffect(() => { load() }, [load])

  // The clock is read once per render pass and handed to the pure module, rather than consulted
  // inside it — same discipline as ProductsManager's promoEnded.
  const state = subscriptionTabState(billing, merchant?.plan, new Date())

  const cycle = merchant?.billing_cycle === 'yearly' ? 'yearly' : 'monthly'
  const planPrice = pricing.prices[state.plan === 'pro' ? 'pro' : 'basic'][cycle]
  const proPrice = pricing.prices.pro[cycle]
  const per = cycle === 'yearly' ? t('/year', '/年') : t('/month', '/月')

  if (!loaded) return <div className={CARD}><SkeletonText /></div>

  // Named once: every wind-down sentence has to say WHEN, and a date-less "your shop will be
  // suspended" is the sort of warning that reads as a threat rather than information.
  const endsAt = state.kind === 'ending' ? state.endsAt : null
  // When the period the merchant has already paid for runs out — the moment a downgrade would
  // take effect. Only ever read while `canDowngrade`, which requires a live subscription.
  const renewsAt = state.kind === 'live' ? state.renewsAt : state.kind === 'trial' ? state.trialEndsAt : null

  return (
    <div className="w-full">
      {state.kind === 'trial' && (
        <TrialBanner daysLeft={state.daysLeft} trialEndsAt={state.trialEndsAt} progress={state.progress} />
      )}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className={HEADING}>{t('Your plan', '您的方案')}</h3>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-heading text-[22px] text-oxblood">
                {state.plan === 'pro' ? 'Pro' : t('Basic', '基础版')}
              </span>
              <Badge variant={state.plan === 'pro' ? 'default' : 'outline'} className="uppercase tracking-[0.08em]">
                {state.plan === 'pro' ? 'Pro' : t('Basic', '基础版')}
              </Badge>
            </div>
            <a
              href="/#pricing" target="_blank" rel="noopener"
              className="inline-flex items-center gap-1 text-[13px] text-oxblood underline underline-offset-2 mt-2"
            >
              {t('Plan details', '方案详情')}
              <ExternalLink size={13} strokeWidth={2} aria-hidden />
            </a>
          </div>
          <span className="font-heading text-[18px] text-oxblood whitespace-nowrap shrink-0">
            {formatMoney(planPrice, pricing.currency)}<span className="text-[13px] text-text-secondary">{per}</span>
          </span>
        </div>

        <p className="text-[13px] text-text-secondary leading-[1.6]">
          {state.kind === 'ending'
            ? (endsAt
                ? t(`Your subscription ends on ${fmtDate(endsAt)}. Your shop stays open until then, and is suspended after that.`,
                    `您的订阅将于 ${fmtDate(endsAt)} 结束。在此之前店铺照常营业，之后将被停用。`)
                : t('Your subscription is set to end when the current period does. Your shop is suspended after that.',
                    '您的订阅将在本周期结束时终止，之后店铺将被停用。'))
            : state.kind === 'trial'
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

        {/* A scheduled downgrade is NOT the same state as a cancellation — the shop stays open
            and keeps being billed, at the lower tier — so it gets its own line rather than
            being folded into the sentence above. */}
        {state.pendingPlan === 'basic' && state.pendingAt && (
          <p className="text-[13px] text-text-secondary leading-[1.6] mt-2">
            {t(`Switching to Basic on ${fmtDate(state.pendingAt)}. You keep Pro features until then.`,
              `将于 ${fmtDate(state.pendingAt)} 转为基础版。在此之前 Pro 功能仍可使用。`)}
          </p>
        )}

        {/* Gated on canManage, NOT on canUpgrade: a Pro shop cannot upgrade but must still be
            able to change its card and read invoices — a sentence promising the billing portal
            with no way to reach it is the same dead end in a different costume. */}
        {state.canManage && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <PortalButton label={t('Manage subscription', '管理订阅')} />

              {/* One click, no dialog: resuming only ever puts things back. */}
              {state.canResume && (
                <Button
                  type="button" size="sm" variant="outline"
                  onClick={() => resumeSubscription().then(load).catch((err: any) =>
                    toast.error(err?.message || t('Could not undo that', '无法撤销')))}
                >
                  {state.kind === 'ending'
                    ? t('Keep my subscription', '继续订阅')
                    : t('Keep Pro', '保留 Pro')}
                </Button>
              )}

              {state.canDowngrade && (
                <ConfirmAction
                  label={t('Switch to Basic', '转为基础版')}
                  title={t('Switch to Basic?', '转为基础版？')}
                  // Names what the cutoff actually does, because it is not reversible by
                  // re-upgrading: the vouchers already in customers' hands are deactivated for
                  // good, and a running sale is ended rather than paused. The consequences are a
                  // list, not a run-on sentence — three separate things stop, and a merchant
                  // scanning this needs to see each one.
                  body={<DowngradeBody renewsAt={renewsAt} />}
                  confirmLabel={t('Switch to Basic', '转为基础版')}
                  run={downgradeToBasic}
                  onDone={load}
                />
              )}

              {state.canCancel && (
                <ConfirmAction
                  destructive
                  severe
                  label={t('Cancel subscription', '取消订阅')}
                  title={t('Cancel subscription?', '取消订阅？')}
                  // The single fact a merchant must not miss: this closes the shop. It leads, in
                  // red, above the softer detail.
                  alert={t('This closes your shop — customers will not be able to see it or place orders.',
                    '此操作将关闭您的店铺——顾客将无法浏览或下单。')}
                  body={<CancelBody renewsAt={renewsAt} />}
                  confirmLabel={t('Cancel my shop', '关闭我的店铺')}
                  run={cancelSubscription}
                  onDone={load}
                />
              )}
            </div>
            <p className="text-[12px] text-text-tertiary mt-3">
              {t('Update your card or view invoices in the billing portal.',
                '在账单门户中更新银行卡或查看账单。')}
            </p>
          </>
        )}
      </div>

      {state.canManage && (
        <SummaryGrid
          nextPayment={
            state.kind === 'ending' || !renewsAt
              ? null
              : t(`${formatMoney(planPrice, pricing.currency)} on ${fmtDate(renewsAt)}`,
                  `${formatMoney(planPrice, pricing.currency)}，${fmtDate(renewsAt)}`)
          }
          renewalLabel={state.kind === 'ending' ? t('Ends', '结束') : t('Renewal', '续订')}
          renewalValue={
            state.kind === 'ending'
              ? (endsAt ? fmtDate(endsAt) : t('End of current period', '本周期结束时'))
              : (renewsAt ? fmtDate(renewsAt) : t('Active', '有效'))
          }
        />
      )}

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
          {/* Two routes to the same tier, decided by whether there is a subscription to change.
              With one: the portal swaps the price on it, and owns the proration argument that
              comes with a mid-period increase. Without one (an active shop approved without a
              trial, or one whose subscription lapsed): Checkout sells a new one, which the
              `checkout.session.completed` reconciliation then turns into real Pro access. */}
          {state.canManage ? (
            <>
              <PortalButton label={t('Upgrade to Pro', '升级到 Pro')} />
              <p className="text-[12px] text-text-tertiary mt-3">
                {t('You will pick the Pro plan in the billing portal. You can step back down to Basic from this page later; that takes effect at the end of the period you have paid for.',
                  '您将在账单门户中选择 Pro 方案。日后可在此页面转回基础版，将在已付费周期结束时生效。')}
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
