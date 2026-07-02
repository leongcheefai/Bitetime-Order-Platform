import { useEffect, useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useSession } from '../SessionContext'
import PendingScreen from './PendingScreen'
import SuspendedScreen from './SuspendedScreen'
import Dashboard from './Dashboard'
import { PageSkeleton } from '../components/Loaders'

export default function MerchantHome() {
  const { slug } = useParams()
  const { t, merchant, ownMerchant, role, impersonate, stopImpersonating, refreshMerchant } = useSession()
  const [params, setParams] = useSearchParams()
  // Records which slug the resolution belongs to, so a stale result from a
  // previous slug doesn't render as ready after navigating between shops.
  const [resolved, setResolved] = useState<{ slug: string | null; notFound: boolean }>({ slug: null, notFound: false })

  // Superadmin viewing a specific shop by slug: load it into the session as the
  // active merchant, and release it when leaving this route.
  useEffect(() => {
    if (!slug) return
    let active = true
    impersonate(slug).then(m => { if (active) setResolved({ slug, notFound: !m }) })
    return () => { active = false; stopImpersonating() }
  }, [slug, impersonate, stopImpersonating])

  // Just back from Stripe Checkout: the webhook may lag a second or two before it
  // flips status to 'active'. Poll until it does, then clear the query param.
  const justPaid = params.get('checkout') === 'success'
  useEffect(() => {
    if (slug || !justPaid) return
    if (ownMerchant?.status === 'active') {
      setParams({}, { replace: true })
      return
    }
    const id = setTimeout(() => { refreshMerchant() }, 2000)
    return () => clearTimeout(id)
  }, [slug, justPaid, ownMerchant?.status, refreshMerchant, setParams])

  if (slug) {
    if (role !== 'superadmin') return <Navigate to="/" replace />
    const ready = resolved.slug === slug
    if (!ready || !merchant) return <PageSkeleton />
    if (resolved.notFound) return <div className="form-wrap"><h2>{t('Shop not found', '找不到店铺')}</h2></div>
    return <Dashboard />
  }

  if (!ownMerchant) return <Navigate to="/merchant/signup" replace />
  if (justPaid && ownMerchant.status !== 'active') {
    return <div className="form-wrap">{t('Setting up your subscription…', '正在设置您的订阅…')}</div>
  }
  if (ownMerchant.status === 'pending') return <PendingScreen />
  if (ownMerchant.status === 'suspended') return <SuspendedScreen />
  return <Dashboard />
}
