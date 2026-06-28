import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useSession } from '../SessionContext'
import PendingScreen from './PendingScreen'
import Dashboard from './Dashboard'

export default function MerchantHome() {
  const { slug } = useParams()
  const { t, merchant, ownMerchant, role, impersonate, stopImpersonating } = useSession()
  // Records which slug the resolution belongs to, so a stale result from a
  // previous slug doesn't render as ready after navigating between shops.
  const [resolved, setResolved] = useState({ slug: null, notFound: false })

  // Superadmin viewing a specific shop by slug: load it into the session as the
  // active merchant, and release it when leaving this route.
  useEffect(() => {
    if (!slug) return
    let active = true
    impersonate(slug).then(m => { if (active) setResolved({ slug, notFound: !m }) })
    return () => { active = false; stopImpersonating() }
  }, [slug, impersonate, stopImpersonating])

  if (slug) {
    if (role !== 'superadmin') return <Navigate to="/" replace />
    const ready = resolved.slug === slug
    if (!ready || !merchant) return <div className="form-wrap">{t('Loading shop…', '加载中…')}</div>
    if (resolved.notFound) return <div className="form-wrap"><h2>{t('Shop not found', '找不到店铺')}</h2></div>
    return <Dashboard />
  }

  if (!ownMerchant) return <Navigate to="/merchant/signup" replace />
  if (ownMerchant.status === 'pending') return <PendingScreen />
  if (ownMerchant.status === 'suspended') return <div className="form-wrap"><h2>{t('Shop suspended', '店铺已暂停')}</h2></div>
  return <Dashboard />
}
