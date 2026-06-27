import { Navigate } from 'react-router-dom'
import { useSession } from '../SessionContext'
import PendingScreen from './PendingScreen'
import Dashboard from './Dashboard'
export default function MerchantHome() {
  const { t, merchant } = useSession()
  if (!merchant) return <Navigate to="/merchant/signup" replace />
  if (merchant.status === 'pending') return <PendingScreen />
  if (merchant.status === 'suspended') return <div className="form-wrap"><h2>{t('Shop suspended','店铺已暂停')}</h2></div>
  return <Dashboard />
}
