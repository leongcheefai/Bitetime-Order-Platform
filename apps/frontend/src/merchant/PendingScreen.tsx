import { useState } from 'react'
import { useSession } from '../SessionContext'
import { startCheckout } from '../store'

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
      <div className="auth-card">
        {hasPlan ? (
          <>
            <span className="mm-pending-badge">⏳ {t('Almost there', '即将完成')}</span>
            <h2 className="auth-title">{t('Finish setting up your shop', '完成店铺设置')}</h2>
            <p className="auth-subtitle">
              <strong>{merchant?.name}</strong>{' '}
              {t(
                'is ready — complete payment to activate it.',
                '已就绪——完成付款即可激活。'
              )}
            </p>
            {err && <div className="mm-auth-note">{err}</div>}
            <button type="button" className="auth-btn" onClick={completePayment} disabled={busy}>
              {busy ? t('Redirecting…', '跳转中…') : t('Complete payment', '完成付款')}
            </button>
          </>
        ) : (
          <>
            <span className="mm-pending-badge">⏳ {t('Pending review', '待审核')}</span>
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
          <p className="mm-store-url" style={{ marginTop: '1rem' }}>
            {t('Store URL', '店铺网址')}:{' '}
            <a href={`/s/${merchant.slug}`}>/s/{merchant.slug}</a>
          </p>
        )}
      </div>
    </div>
  )
}
