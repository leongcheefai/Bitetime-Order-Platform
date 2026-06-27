import { useSession } from '../SessionContext'
export default function PendingScreen() {
  const { t, merchant } = useSession()
  return (
    <div className="form-wrap" style={{ maxWidth: 480 }}>
      <h2>{t('Shop pending approval','店铺待审核')}</h2>
      <p>{t('Your shop','您的店铺')} <b>{merchant?.name}</b> {t("is awaiting platform approval. You'll be able to manage it once approved.",'正在等待平台审核。审核通过后即可管理。')}</p>
      <p style={{ color:'#888' }}>{t('Store URL','店铺网址')}: /s/{merchant?.slug}</p>
    </div>
  )
}
