import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { AlertTriangle, ExternalLink, Timer } from 'lucide-react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import {
  fetchMyBilling, openBillingPortal, startCheckout,
  cancelSubscription, resumeSubscription,
} from '../store'
import { trackEvent, toBilling } from '../analytics/events'
import type { Result } from '../api'
import { usePlatformPricing } from '../usePlatformPricing'
import { formatMoney } from '../currency'
import { fmtDate } from '../merchantDate'
import { subscriptionTabState, type SubscriptionSnapshot } from './subscriptionTabState'
import { yearlySavingPercent, type Cycle } from './reactivationChoice'
import { billingErrorMessage } from './billingErrors'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../components/ui/dialog'
import { SkeletonText } from '../components/Loaders'

// Settings → Subscription (#112). The one place that answers "what does this cost and when does
// it renew" — BillingBanner only speaks in trouble states, so a healthy paying merchant
// previously saw nothing about their subscription anywhere in the app.
//
// Cancelling and undoing a cancellation happen HERE rather than in Stripe's portal, because they
// land on a period boundary: no money moves and there is nothing a payment screen needs to
// explain. What that buys is the thing the portal cannot say — that cancelling suspends this
// shop, on a named date, in the merchant's own language.

const CARD = 'bg-card border-[0.5px] border-border rounded-2xl p-5 mb-6 w-full box-border max-sm:p-4'
const HEADING = 'font-heading text-[15px] font-medium text-primary mb-4 flex items-center gap-2'


/**
 * The Stripe portal hand-off, shared by every control that opens it — the `PortalButton` and the
 * Summary's two portal links. One `busy` flag and one bilingual failure toast, so the two call
 * sites cannot drift apart. `toPortal` redirects on success; on failure it clears `busy` and says
 * so, because the `canManage` gate can go stale under a long-open tab and a silently-inert button
 * is the dead end this tab exists to remove.
 */
function useBillingPortal() {
  const { t } = useSession()
  const [busy, setBusy] = useState(false)
  async function toPortal() {
    setBusy(true)
    const r = await openBillingPortal()
    if (r.ok) window.location.assign(r.data)
    else {
      toast.error(billingErrorMessage(r.error.code, t)
        || r.error.message
        || t('Could not open the billing portal', '无法打开账单门户'))
      setBusy(false)
    }
  }
  return { busy, toPortal }
}

/**
 * The hand-off to Stripe. Lives here rather than beside the Pro locks because it is the terminal
 * action — everything else in the dashboard routes to this tab first, so the merchant sees the
 * price before a payment screen. Only rendered when the shop HAS a Stripe customer: the endpoint
 * 404s otherwise, and a button that cannot work is the dead end this tab exists to remove.
 */
function PortalButton({ label }: { label: string }) {
  const { t } = useSession()
  const { busy, toPortal } = useBillingPortal()
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
function CheckoutButton({ cycle, label }: { cycle: string; label: string }) {
  const { t } = useSession()
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    // Reported BEFORE the redirect: window.location.assign leaves this page, and nothing after it
    // runs. See analytics/events.ts — the call swallows its own failure, so it cannot cost a
    // checkout.
    trackEvent('billing_checkout_started', {
      billing: toBilling(cycle),
      from: 'subscription',
    })
    const r = await startCheckout({ billing: cycle })
    if (r.ok) window.location.assign(r.data)
    else {
      toast.error(r.error.message || t('Could not start checkout', '无法开始结账'))
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
 * Buying a subscription for a shop that is open with nothing paying for it — a comp that was
 * revoked, or one whose subscription lapsed before a superadmin reopened the shop.
 *
 * It CHOOSES a billing cycle rather than inheriting the shop's stored one, and that is the whole
 * reason it is a component: the card above reports what the shop pays, which is a fact, while this
 * one is a purchase, which is a decision. Sharing a single `cycle` between them left yearly
 * unreachable here for any shop whose column happened to say monthly — including every shop that
 * never had a subscription at all.
 *
 * `yearlySavingPercent` is SuspendedScreen's, deliberately: the two purchase surfaces must not be
 * able to quote different savings off the same pair of Stripe prices. Null when yearly is not
 * actually cheaper, so a "Save 0%" badge can never render.
 */
function SubscribeCard({ defaultCycle, readOnly }: { defaultCycle: Cycle; readOnly: boolean }) {
  const { t } = useSession()
  const { pricing } = usePlatformPricing()
  const [buyCycle, setBuyCycle] = useState<Cycle>(defaultCycle)

  const amount = pricing.prices.pro[buyCycle]
  const per = buyCycle === 'yearly' ? t('/year', '/年') : t('/month', '/月')
  const saving = yearlySavingPercent(pricing.prices.pro.monthly, pricing.prices.pro.yearly)

  return (
    <div className={CARD}>
      <h3 className={HEADING}>{t('Subscribe', '订阅')}</h3>
      <p className="text-[13px] text-muted-foreground mb-4">
        {t('This shop has no subscription yet. Cancel anytime.', '此店铺尚无订阅。可随时取消。')}
      </p>

      <div
        role="radiogroup"
        aria-label={t('Billing cycle', '付费周期')}
        className="inline-flex p-[3px] mb-4 rounded-pill border-[0.5px] border-border bg-card"
      >
        {(['monthly', 'yearly'] as Cycle[]).map(c => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={buyCycle === c}
            onClick={() => setBuyCycle(c)}
            className={`py-[5px] px-4 rounded-pill text-[13px] cursor-pointer transition-colors ${
              buyCycle === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-primary'
            }`}
          >
            {c === 'monthly' ? t('Monthly', '按月') : t('Yearly', '按年')}
            {/* Only ever rendered from the live Stripe prices, and only when there is a real
                saving to claim — see yearlySavingPercent. */}
            {c === 'yearly' && saving !== null && (
              <span className={buyCycle === c ? 'ml-1.5 opacity-90' : 'ml-1.5 text-primary'}>
                {t(`− ${saving}%`, `省 ${saving}%`)}
              </span>
            )}
          </button>
        ))}
      </div>

      <p className="text-[15px] text-foreground mb-4">
        <span className="font-heading text-[22px] text-primary">{formatMoney(amount, pricing.currency)}</span>
        <span className="text-[13px] text-muted-foreground">{per}</span>
      </p>

      {/* Withheld from an impersonating superadmin, and it has to be: `/api/checkout` is
          guarded by `requireOwnMerchant`, so the button would 404 for them. */}
      {readOnly
        ? <OwnerOnlyNote />
        : <CheckoutButton cycle={buyCycle} label={t('Subscribe', '订阅')} />}
    </div>
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
  run: () => Promise<Result<void>>
  onDone: () => void
}) {
  const { t } = useSession()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const descId = useId()

  async function confirm() {
    setBusy(true)
    const r = await run()
    setBusy(false)
    if (r.ok) {
      setOpen(false)
      // Refetch rather than patch local state: the backend writes the outcome to
      // `merchant_billing` itself, and re-reading it is what keeps this tab honest if Stripe
      // returned something other than what was asked for.
      onDone()
      return
    }
    toast.error(
      billingErrorMessage(r.error.code, t)
        || r.error.message
        || t('That did not work. Please try again.', '操作失败，请重试。'),
    )
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
            <DialogTitle className={severe ? 'text-danger-fg flex items-center gap-2' : undefined}>
              {severe && <AlertTriangle size={17} strokeWidth={2.25} className="shrink-0" aria-hidden />}
              {title}
            </DialogTitle>
          </DialogHeader>
          {/* A shop-offline action leads with a red callout, not a calm paragraph, so the
              consequence is the first thing read rather than the last. */}
          {severe && alert && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border-[0.5px] border-danger-500 bg-danger-100 text-danger-fg px-3 py-2 text-[13px] font-medium leading-[1.5]"
            >
              <AlertTriangle size={15} strokeWidth={2.25} className="shrink-0 mt-[2px]" aria-hidden />
              <span>{alert}</span>
            </div>
          )}
          <div id={descId} className="text-sm text-muted-foreground flex flex-col gap-2">{body}</div>
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
 * The cancel confirm body. Paired with the red `alert` callout above it: the callout states the
 * one fact that must not be missed (the shop closes), this fills in the timeline and the way
 * back. A list rather than a sentence: the suspension is the point and must not be buried
 * mid-sentence.
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
 * What stands in for every billing control while a superadmin is impersonating a shop.
 *
 * Not a disabled button: the action is not temporarily unavailable, it belongs to someone else,
 * and a greyed-out "Cancel subscription" invites a support session spent wondering why it will
 * not click. Every one of these routes (`/api/billing/*` and `/api/checkout`) resolves its shop
 * from the caller's OWN `owner_id` with no superadmin bypass — see the note on
 * `requireOwnMerchant` in the backend's mw.ts, where that asymmetry is deliberate. A superadmin
 * owns no shop, so the honest answer is that this is the owner's to do.
 *
 * Rendered ONCE per card, never twice on the same screen: the subscription card and the subscribe
 * card are separate surfaces, but the Summary grid sits directly under the subscription card and
 * simply drops its
 * portal cells rather than repeating this sentence a few pixels below itself.
 */
function OwnerOnlyNote() {
  const { t } = useSession()
  return (
    <p className="text-[12px] text-muted-foreground mt-3">
      {t('You are viewing this shop as an admin. Billing actions can only be taken by the shop owner.',
        '您正以管理员身份查看此店铺。账单操作仅限店主本人执行。')}
    </p>
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
    // CARD geometry, warm cream wash instead of the raised surface — an info tint, not the rose
    // of the trouble states. Later class wins in Tailwind, so bg-background overrides CARD's background.
    <div className={`${CARD} bg-background`}>
      <div className="flex items-start gap-3">
        <Timer size={20} strokeWidth={2} className="text-primary shrink-0 mt-[2px]" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-heading text-[15px] font-medium text-primary">{heading}</p>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            {t(`Ending ${fmtDate(trialEndsAt)}.`, `${fmtDate(trialEndsAt)} 结束。`)}
          </p>
          {/* Draining bar: width tracks the fraction remaining. */}
          <div className="mt-3 h-1.5 w-full rounded-pill bg-border/40 overflow-hidden">
            <div
              className="h-full rounded-pill bg-primary transition-[width] duration-300"
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
function SummaryGrid({ nextPayment, renewalLabel, renewalValue, readOnly }: {
  nextPayment: string | null
  renewalLabel: string
  renewalValue: string
  readOnly: boolean
}) {
  const { t } = useSession()
  const { busy, toPortal } = useBillingPortal()
  const label = 'text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground'
  const value = 'text-[14px] text-primary mt-1'
  /* Paired with variant="link", which brings the underline, the focus ring and the
     disabled treatment — so this carries only what is specific to these two. */
  const portalLink = 'text-[14px] mt-1 text-left disabled:cursor-default'
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
        {/* Both cells are nothing but a door to the portal, so an admin who cannot open it is
            better off not seeing them at all — a "Payment method" label above a dead link says
            less than nothing. The subscription card immediately above has already said why. */}
        {!readOnly && (
          <>
            <div>
              <p className={label}>{t('Payment method', '付款方式')}</p>
              <Button type="button" variant="link" size="none" className={portalLink} onClick={toPortal} disabled={busy}>
                {t('Manage in portal', '在门户中管理')}
              </Button>
            </div>
            <div>
              <p className={label}>{t('Payment history', '付款记录')}</p>
              <Button type="button" variant="link" size="none" className={portalLink} onClick={toPortal} disabled={busy}>
                {t('Billing portal', '账单门户')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function SubscriptionTab() {
  // `impersonating` is what makes this tab read-only. Everything ABOVE the buttons keeps working
  // while it is true — the card is fetched by explicit merchant id through `requireMerchantOwns`,
  // which superadmins do pass — and that split is exactly the trap: a fully populated card
  // implies the buttons under it belong to the same shop, and they do not. They post to routes
  // with no id in them, which resolve the caller's own shop and answer 404 to a superadmin who
  // owns none. Read `readOnly` as "these controls are not this viewer's to use", not "loading".
  const { t, merchant, impersonating } = useSession()
  const readOnly = impersonating
  const { pricing } = usePlatformPricing()
  const [billing, setBilling] = useState<SubscriptionSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false)
  const merchantId = merchant?.id

  // Extracted so the wind-down actions can re-read after Stripe has been told.
  const load = useCallback(() => {
    if (!merchantId) return
    fetchMyBilling(merchantId)
      .then(r => { setBilling(r.ok ? r.data : null); setLoaded(true) })
  }, [merchantId])

  useEffect(() => { load() }, [load])

  // The clock is read once per render pass and handed to the pure module, rather than consulted
  // inside it — same discipline as ProductsManager's promoEnded.
  const state = subscriptionTabState(billing, new Date())

  // What the shop PAYS, read off its own row. Distinct from `buyCycle` below, which is what a
  // shop with no subscription is CHOOSING — conflating the two is how the Subscribe card ended up
  // able to sell only whichever cycle the column happened to say.
  const cycle = merchant?.billing_cycle === 'yearly' ? 'yearly' : 'monthly'
  const planPrice = pricing.prices.pro[cycle]
  const per = cycle === 'yearly' ? t('/year', '/年') : t('/month', '/月')

  if (!loaded) return <div className={CARD}><SkeletonText /></div>

  // Named once: every wind-down sentence has to say WHEN, and a date-less "your shop will be
  // suspended" is the sort of warning that reads as a threat rather than information.
  const endsAt = state.kind === 'ending' ? state.endsAt : null
  // When the period the merchant has already paid for runs out.
  const renewsAt = state.kind === 'live' ? state.renewsAt : state.kind === 'trial' ? state.trialEndsAt : null

  return (
    <div className="w-full">
      {state.kind === 'trial' && (
        <TrialBanner daysLeft={state.daysLeft} trialEndsAt={state.trialEndsAt} progress={state.progress} />
      )}
      <div className={CARD}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className={HEADING}>{t('Your subscription', '您的订阅')}</h3>
            <a
              href="/pricing" target="_blank" rel="noopener"
              className="inline-flex items-center gap-1 text-[13px] text-primary underline underline-offset-2 mt-1"
            >
              {t('What is included', '包含什么')}
              <ExternalLink size={13} strokeWidth={2} aria-hidden />
            </a>
          </div>
          <span className="font-heading text-[18px] text-primary whitespace-nowrap shrink-0">
            {/* A comped shop pays nothing. Quoting the price here, with no subscription behind
                it, reads as a bill. */}
            {state.comped
              ? t('Free', '免费')
              : <>{formatMoney(planPrice, pricing.currency)}<span className="text-[13px] text-muted-foreground">{per}</span></>}
          </span>
        </div>

        <p className="text-[13px] text-muted-foreground leading-[1.6]">
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
                  : state.comped
                    ? t('Complimentary Pro — no billing on this shop.',
                        '赠送的 Pro 方案——此店铺无账单。')
                    : t('No subscription on file for this shop yet.',
                        '此店铺尚无订阅记录。')}
        </p>

        {/* Gated on canManage, NOT on canUpgrade: a Pro shop cannot upgrade but must still be
            able to change its card and read invoices — a sentence promising the billing portal
            with no way to reach it is the same dead end in a different costume. */}
        {state.canManage && readOnly && <OwnerOnlyNote />}

        {state.canManage && !readOnly && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <PortalButton label={t('Manage subscription', '管理订阅')} />

              {/* One click, no dialog: resuming only ever puts things back. */}
              {state.canResume && (
                <Button
                  type="button" size="sm" variant="outline"
                  onClick={() => resumeSubscription().then(r => {
                    if (r.ok) load()
                    else toast.error(r.error.message || t('Could not undo that', '无法撤销'))
                  })}
                >
                  {t('Keep my subscription', '继续订阅')}
                </Button>
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
            <p className="text-[12px] text-muted-foreground mt-3">
              {t('Update your card or view invoices in the billing portal.',
                '在账单门户中更新银行卡或查看账单。')}
            </p>
          </>
        )}
      </div>

      {/* Not for past-due: that shop has no renewal date (the card is failing), and a Summary
          that answered "Renewal: Active" would flatly contradict the payment-failed line above.
          The card's Manage button already routes it to the portal to fix the card. */}
      {state.canManage && state.kind !== 'past-due' && (
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
          readOnly={readOnly}
        />
      )}

      {/* The shop is open but nothing is paying for it — a comp that was revoked, or a
          subscription that lapsed before a superadmin reopened the shop. It reaches the dashboard
          (it is neither pending nor suspended), so this is the only place it can buy one, and
          telling it to "contact us" is the dead end ADR 0004 set out to remove.
          `canSubscribe` is the exact complement of `canManage`, so this and the portal button can
          never both appear and a second subscription cannot be created on a shop that pays. */}
      {state.canSubscribe && (
        <SubscribeCard defaultCycle={cycle} readOnly={readOnly} />
      )}
    </div>
  )
}
