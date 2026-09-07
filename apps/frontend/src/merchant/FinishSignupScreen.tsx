// The second half of merchant signup, for a merchant whose account exists but whose shop does
// not. That gap is created by email confirmation: `SignupScreen` signs the merchant in and
// creates the shop in the same submit, and with confirmations on the sign-in fails, so the
// shop-creating call never runs. The merchant confirms, logs in — and owns nothing.
//
// Before this screen existed, `RequireRole` read that as "not a merchant" and bounced them to
// the marketing page, where no 'My dashboard' link is drawn either. Nothing in the product ever
// said the shop was missing, and nothing offered to create it.
//
// Two paths, and the first is the one that should fire:
//   - the signup form's answers rode along in the auth user's metadata → create the shop with
//     no questions asked (pendingShop.ts), which is where a NEW signup lands.
//   - nothing was carried (a merchant stranded before this shipped) → ask for the two fields a
//     shop cannot be created without.

import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { createMerchant } from '../store'
import { trackEvent, toBilling } from '../analytics/events'
import { useSession } from '../SessionContext'
import { pendingShopFromMetadata } from '@bitetime/shared'
import type { PendingShop } from '@bitetime/shared'
import { DEFAULT_CURRENCY } from '../currency'
import BusinessNaturePicker from '../components/BusinessNaturePicker'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import Wordmark from '../components/Wordmark'
import { Spinner } from '../components/Loaders'

export default function FinishSignupScreen() {
  const { t, account, refreshMerchant } = useSession()
  const parked = pendingShopFromMetadata(account?.user_metadata)

  const [name, setName] = useState(parked?.name ?? '')
  const [businessNature, setBusinessNature] = useState(parked?.businessNature ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // Mirrors SignupScreen's post-create step, which is now a single one: the backend provisions
  // the cardless trial and activates the shop inside `createMerchant`, so there is nowhere else
  // to send anyone. A shop Stripe refused stays 'pending' and MerchantHome offers the retry.
  async function create(shop: PendingShop) {
    setBusy(true); setMsg('')
    const created = await createMerchant({
      name: shop.name,
      billing: shop.billing,
      referredByCode: shop.ref,
      businessNature: shop.businessNature || undefined,
      currency: shop.currency,
    })
    if (!created.ok) { setMsg(created.error.message || t('Something went wrong.', '出错了。')); setBusy(false); return }
    // The shop exists at this line, so the signup is reported HERE and not only in SignupScreen.
    // With email confirmation on, this screen — not that form — is where every shop is created,
    // and reporting in one of the two places would make the funnel's answer depend on a Supabase
    // setting. Same two events, same conditions, deliberately duplicated rather than shared: the
    // two screens agree on nothing else.
    trackEvent('merchant_signup', { billing: toBilling(shop.billing) })
    if (created.data?.trial === true) trackEvent('trial_started')
    // Re-reading the shop is what changes this user's role to 'merchant', which is what lets
    // the guard above this screen render the dashboard instead of this form.
    await refreshMerchant()
  }

  // Auto-create when the signup form's answers were carried: the merchant already filled this
  // in once, and asking twice is the bug, not the fix. Guarded by a ref rather than the `busy`
  // state — an effect that reads state it also sets fires twice under StrictMode, and twice
  // here is two shops.
  const attempted = useRef(false)
  useEffect(() => {
    if (!parked || attempted.current) return
    attempted.current = true
    create(parked)
    // Runs once for the parked shop; `create` closes over nothing that changes before it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parked])

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // A merchant stranded before this shipped never chose a currency either — same as the billing
    // cycle just below, this fallback form doesn't ask a second question for an edge case; the
    // column's own default (MYR) is what they get, same as it always was.
    create({ name: name.trim(), businessNature, currency: DEFAULT_CURRENCY, billing: 'monthly' })
  }

  const heading = (
    <div className="text-center mb-10">
      <h1><Wordmark className="h-8 mx-auto" /></h1>
      <p className="font-heading text-[13px] italic text-muted-foreground mt-[5px]">{t('Merchant Portal', '商家入口')}</p>
    </div>
  )

  // The parked-shop path shows work, not a form — the only thing that stops it is a failure,
  // and that failure keeps the form below as its way out.
  if (parked && !msg) {
    return (
      <div className="w-[420px] max-w-full pt-8">
        {heading}
        <Card className="px-8 py-10 gap-0 items-center">
          <Spinner label={t('Finishing your shop setup…', '正在完成店铺设置…')} />
        </Card>
      </div>
    )
  }

  return (
    <div className="w-[420px] max-w-full pt-8">
      {heading}
      <Card className="px-8 pt-8 pb-7 gap-0">
        <h2 className="font-heading text-[20px] font-medium text-primary mb-1">{t('Finish setting up your shop', '完成店铺设置')}</h2>
        <p className="text-[13px] text-muted-foreground mb-6">
          {t("Your account is confirmed, but your shop was never created. Tell us these two things and it's done.",
             '你的账号已确认，但店铺尚未创建。填写以下两项即可完成。')}
        </p>
        {msg && (
          <div className="text-[13px] text-foreground-secondary bg-brand-wash border border-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {msg}
          </div>
        )}
        <form onSubmit={onSubmit}>
          <div className="flex flex-col gap-3 mb-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="finish-name">{t('Shop name', '店铺名称')}</Label>
              <Input id="finish-name" value={name} onChange={e => setName(e.target.value)} required placeholder={t('e.g. Sunny Bakes', '如：阳光烘焙')} />
            </div>
            <BusinessNaturePicker id="finish-nature" value={businessNature} onChange={setBusinessNature} />
          </div>
          {/* A Radix select carries no native `required`, so the button is the gate. */}
          <Button type="submit" variant="default" size="md" className="py-3" disabled={busy || !name.trim() || !businessNature}>
            {busy ? t('Creating…', '创建中…') : t('Create my shop', '创建店铺')}
          </Button>
        </form>
        <p className="text-[13px] text-muted-foreground text-center mt-4">
          <Link to="/" className="text-primary cursor-pointer underline">{t('Back to home', '返回首页')}</Link>
        </p>
      </Card>
    </div>
  )
}
