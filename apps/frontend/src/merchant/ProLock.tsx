import { useState } from 'react'
import { Lock } from 'lucide-react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { openBillingPortal } from '../store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// The merchant-facing half of the Pro gate (#110). Show-but-lock: a basic shop still SEES
// vouchers, Telegram and product promos in its dashboard — hiding them would read as a
// missing feature or a bug, and there would be nothing to sell against. What it gets instead
// is a padlock and a way to pay.
//
// None of this is the gate. The backend refuses the write (`403 requires_pro`) whether or not
// this renders; see CONTEXT.md → Plan entitlement.

/** The "Pro" marker. Sits beside a locked field group's own heading. */
export function ProBadge() {
  return (
    <Badge variant="default" className="uppercase tracking-[0.08em]">
      Pro
    </Badge>
  )
}

/**
 * Sends the merchant to the Stripe billing portal.
 *
 * NOT an in-place upgrade — `POST /api/checkout` refuses a shop that already has a live
 * subscription, so basic→pro cannot be automated yet (a subscription price-swap plus a webhook
 * that reconciles `merchants.plan` is the tracked follow-up). The portal is the honest
 * destination in the meantime: it is where the shop's subscription actually lives.
 */
export function UpgradeButton({ className }: { className?: string }) {
  const { t } = useSession()
  const [busy, setBusy] = useState(false)
  async function toPortal() {
    setBusy(true)
    try { window.location.assign(await openBillingPortal()) }
    catch (err: any) {
      // Say something. This CTA's whole audience is shops that are NOT paying for Pro, and
      // `POST /api/billing/portal` answers 404 "No billing account yet" for a shop with no
      // Stripe customer — a comped or pre-checkout basic shop. Swallowing that (as
      // BillingBanner can afford to, since its audience always has a subscription) would
      // leave the one button on this panel doing nothing at all, with no word why.
      toast.error(err?.message || t('Could not open the billing portal', '无法打开账单门户'))
      setBusy(false)
    }
  }
  // size="sm" deliberately: the default size is `w-full` (it is the auth/save button geometry),
  // which stretches this CTA across a settings card or a product dialog.
  return (
    <Button type="button" size="sm" onClick={toPortal} disabled={busy} className={className}>
      {busy ? t('Opening…', '打开中…') : t('Upgrade to Pro', '升级到 Pro')}
    </Button>
  )
}

/**
 * The panel that stands in for a whole locked feature (the Vouchers section, the Notifications
 * tab). `what` names the feature in the merchant's own language; `why` is the one line that
 * says what they would get for the money.
 */
export function ProLock({ what, why }: { what: string; why: string }) {
  const { t } = useSession()
  return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-8 w-full box-border text-center max-sm:p-5">
      <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-surface-sunken text-oxblood">
        <Lock size={20} strokeWidth={1.75} />
      </div>
      <div className="flex items-center justify-center gap-2 mb-2">
        <h3 className="font-heading text-[16px] font-medium text-oxblood">{what}</h3>
        <ProBadge />
      </div>
      <p className="text-[13px] text-text-secondary max-w-[380px] mx-auto mb-5 leading-[1.6]">{why}</p>
      <UpgradeButton />
      <p className="text-[12px] text-text-tertiary mt-3">
        {t('Manage your subscription in the billing portal.', '在账单门户中管理您的订阅。')}
      </p>
    </div>
  )
}
