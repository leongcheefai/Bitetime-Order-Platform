import { Navigate } from 'react-router-dom'
import { useSession } from '../SessionContext'
import PendingScreen from './PendingScreen'
export default function MerchantHome() {
  const { t, merchant } = useSession()
  if (!merchant) return <Navigate to="/merchant/signup" replace />
  if (merchant.status === 'pending') return <PendingScreen />
  if (merchant.status === 'suspended') return <div className="form-wrap"><h2>{t('Shop suspended','店铺已暂停')}</h2></div>
  return <div className="form-wrap"><h2>{t('Merchant dashboard','商家后台')}</h2><p>{t('Coming in P4','P4 推出')}</p></div>
}
