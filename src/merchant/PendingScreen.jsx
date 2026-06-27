import { useSession } from '../SessionContext'

export default function PendingScreen() {
  const { t, merchant } = useSession()
  return (
    <div className="auth-wrap">
      <div className="brand">
        <h1>BiteTime</h1>
        <p className="tagline">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <div className="auth-card">
        <span className="mm-pending-badge">⏳ {t('Pending review', '待审核')}</span>
        <h2 className="auth-title">{t('Your shop is under review', '您的店铺正在审核中')}</h2>
        <p className="auth-subtitle">
          <strong>{merchant?.name}</strong>{' '}
          {t(
            "is awaiting platform approval. You'll be able to manage it once approved.",
            '正在等待平台审核。审核通过后即可管理。'
          )}
        </p>
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
