import { useState } from 'react'
import { useSession } from '../SessionContext'
import { startShopTrial } from '../store'
import { trackEvent } from '../analytics/events'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Wordmark from '../components/Wordmark'

export default function PendingScreen() {
  const { t, merchant, refreshMerchant } = useSession()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // `pending` has exactly one cause now (#222): signup provisions the cardless trial itself, so a
  // shop only lands here when that call to Stripe failed. What it needs is a retry — never a
  // payment screen, because nothing has been sold yet.
  async function retrySetup() {
    setBusy(true); setErr('')
    const r = await startShopTrial(merchant!.id)
    if (r.ok) {
      // The third door a trial can come through, after the two signup screens. Reported here for
      // the same reason it is reported there: a trial the funnel cannot see is a trial that looks
      // like a shop which never started one. `trial` is the backend's own answer — a retry that
      // activates a shop which already used its one trial answers false, and starts nothing.
      if (r.data.trial) trackEvent('trial_started')
      // The shop is active now; refreshing the session swaps this screen for the dashboard.
      await refreshMerchant()
      return
    }
    setErr(r.error.message || t('Could not finish setting up your shop', '无法完成店铺设置'))
    setBusy(false)
  }

  return (
    <div className="w-[420px] max-w-full pt-8">
      <div className="text-center mb-10">
        <h1><Wordmark className="h-8 mx-auto" /></h1>
        <p className="font-heading text-[13px] italic text-muted-foreground mt-[5px]">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <Card className="px-8 pt-8 pb-7 gap-0">
        <span className="inline-flex items-center gap-[5px] px-3 py-[4px] rounded-pill bg-warning-100 text-warning-fg text-[12px] font-semibold tracking-[0.04em] mb-4">
          {t('Finishing setup', '正在完成设置')}
        </span>
        <h2 className="font-heading text-[20px] font-medium text-primary mb-1">{t('One step left', '还差一步')}</h2>
        <p className="text-[13px] text-muted-foreground mb-6">
          <strong>{merchant?.name}</strong>{' '}
          {t(
            'is created, but we could not start your free trial just now. Try again and your shop opens straight away.',
            '已创建，但刚才未能开始你的免费试用。再试一次，店铺即可立即开放。'
          )}
        </p>
        {err && (
          <div className="text-[13px] text-foreground-secondary bg-brand-wash border border-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {err}
          </div>
        )}
        <Button type="button" variant="default" size="md" className="py-3" onClick={retrySetup} disabled={busy}>
          {busy ? t('Starting…', '正在开始…') : t('Try again', '重试')}
        </Button>
        {merchant?.slug && (
          <p className="text-[13px] text-muted-foreground mt-4">
            {t('Store URL', '店铺网址')}:{' '}
            <a href={`/s/${merchant.slug}`} className="text-primary no-underline font-medium hover:underline">/s/{merchant.slug}</a>
          </p>
        )}
      </Card>
    </div>
  )
}
