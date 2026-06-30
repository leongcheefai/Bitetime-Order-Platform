import { useState } from 'react'
import { useSession } from '../SessionContext'
import { startCheckout } from '../store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export default function PendingScreen() {
  const { t, merchant } = useSession()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // A merchant that picked a plan but abandoned checkout sits here until paid.
  const hasPlan = !!merchant?.plan

  async function completePayment() {
    setBusy(true); setErr('')
    try {
      const url = await startCheckout({ plan: merchant!.plan as string, billing: merchant!.billing_cycle || 'monthly' })
      window.location.assign(url)
    } catch (e: any) {
      setErr(e.message || t('Could not start checkout', '无法开始结账'))
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="brand">
        <h1>BiteTime</h1>
        <p className="tagline">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <Card className="rounded-pill px-8 pt-8 pb-7 gap-0">
        {hasPlan ? (
          <>
            {/* Pending badge: warn colours, pill, mb-4 */}
            <span className="inline-flex items-center gap-[5px] px-3 py-[4px] rounded-pill bg-warn-bg text-warn-fg text-[12px] font-semibold tracking-[0.04em] mb-4">
              ⏳ {t('Almost there', '即将完成')}
            </span>
            <h2 className="auth-title">{t('Finish setting up your shop', '完成店铺设置')}</h2>
            <p className="auth-subtitle">
              <strong>{merchant?.name}</strong>{' '}
              {t(
                'is ready — complete payment to activate it.',
                '已就绪——完成付款即可激活。'
              )}
            </p>
            {err && (
              <div className="text-[13px] text-ink-soft bg-oxblood-tint border border-rose-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
                {err}
              </div>
            )}
            <Button type="button" variant="default" size="md" className="py-3" onClick={completePayment} disabled={busy}>
              {busy ? t('Redirecting…', '跳转中…') : t('Complete payment', '完成付款')}
            </Button>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-[5px] px-3 py-[4px] rounded-pill bg-warn-bg text-warn-fg text-[12px] font-semibold tracking-[0.04em] mb-4">
              ⏳ {t('Pending review', '待审核')}
            </span>
            <h2 className="auth-title">{t('Your shop is under review', '您的店铺正在审核中')}</h2>
            <p className="auth-subtitle">
              <strong>{merchant?.name}</strong>{' '}
              {t(
                "is awaiting platform approval. You'll be able to manage it once approved.",
                '正在等待平台审核。审核通过后即可管理。'
              )}
            </p>
          </>
        )}
        {merchant?.slug && (
          <p className="mm-store-url mt-4">
            {t('Store URL', '店铺网址')}:{' '}
            <a href={`/s/${merchant.slug}`}>/s/{merchant.slug}</a>
          </p>
        )}
      </Card>
    </div>
  )
}
