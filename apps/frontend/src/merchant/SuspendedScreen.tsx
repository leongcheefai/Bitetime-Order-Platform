import { useState } from 'react'
import { useSession } from '../SessionContext'
import { startCheckout } from '../store'
import OrdersView from './OrdersView'
import { Button } from '@/components/ui/button'

// Suspended = the subscription lapsed (trial ended unpaid, dunning exhausted)
// or a superadmin action. The storefront is closed to customers; the merchant
// keeps read-only access to their order history and one path back: pay.
// Reactivation Checkout never grants a second trial (backend guarantees it).
export default function SuspendedScreen() {
  const { t, merchant } = useSession()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function reactivate() {
    setBusy(true); setErr('')
    try {
      const url = await startCheckout({
        plan: merchant?.plan || 'basic',
        billing: merchant?.billing_cycle || 'monthly',
      })
      window.location.assign(url)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Could not start checkout', '无法开始结账'))
      setBusy(false)
    }
  }

  return (
    <div className="w-full max-w-[720px] mx-auto pt-8 px-4 pb-12">
      <div
        role="status"
        className="flex items-center gap-3 flex-wrap px-4 py-3 mb-6 rounded-md border-[1.5px] text-[13px] leading-[1.5] bg-danger-bg text-danger-fg border-danger-fg/25"
      >
        <span className="flex-1 min-w-[200px] font-medium">
          {t('Your shop is suspended — your subscription has ended. Subscribe to reopen it.',
             '您的店铺已暂停——订阅已结束。重新订阅即可恢复营业。')}
        </span>
        <Button
          size="none"
          variant="outline"
          className="py-[5px] px-3 rounded-pill text-[12px] whitespace-nowrap bg-surface-raised hover:bg-oxblood-tint hover:text-oxblood hover:border-oxblood"
          disabled={busy}
          onClick={reactivate}
        >
          {busy ? t('Redirecting…', '跳转中…') : t('Reactivate — pay now', '恢复营业——立即付款')}
        </Button>
      </div>
      {err && (
        <div className="text-[13px] text-ink-soft bg-oxblood-tint border border-rose-border rounded-sm px-[13px] py-[10px] mb-4 leading-[1.5]">
          {err}
        </div>
      )}
      <h2 className="font-heading text-[18px] font-medium text-oxblood mb-3">
        {t('Your orders', '您的订单')}
      </h2>
      <OrdersView readOnly />
    </div>
  )
}
