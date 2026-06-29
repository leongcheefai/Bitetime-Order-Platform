import { lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'motion/react'
import { PageTransition } from './motion'
import { SessionProvider } from './SessionContext'
import { ToastProvider } from './ToastContext'
import Toaster from './components/Toaster'
import { MerchantProvider, useMerchant } from './MerchantContext'
import RequireRole from './RequireRole'
import { Spinner } from './components/Loaders'

// Route-level code splitting: each surface ships its own chunk, so a storefront
// customer never downloads merchant/admin/signup code (signup pulls in the heavy
// pinyin-pro dictionary — kept out of the customer path).
const AdminMerchants = lazy(() => import('./admin/AdminMerchants'))
const Landing = lazy(() => import('./marketing/Landing'))
const SignupScreen = lazy(() => import('./merchant/SignupScreen'))
const LoginScreen = lazy(() => import('./merchant/LoginScreen'))
const MerchantHome = lazy(() => import('./merchant/MerchantHome'))
const Storefront = lazy(() => import('./store/Storefront'))

function RouteFallback() {
  return (
    <div className="form-wrap mm-storefront-state">
      <div className="brand"><h1>BiteTime</h1></div>
      <Spinner label="Loading…" />
    </div>
  )
}

function StorefrontShell() {
  const { merchant, loading, notFound } = useMerchant()

  if (loading) return (
    <div className="form-wrap mm-storefront-state">
      <div className="brand">
        <h1>BiteTime</h1>
      </div>
      <Spinner label="Loading shop…" />
    </div>
  )

  if (notFound) return (
    <div className="form-wrap mm-storefront-state">
      <div className="brand">
        <h1>BiteTime</h1>
        <p className="tagline">Shop not found</p>
      </div>
      <div className="admin-panel" style={{ textAlign: 'left' }}>
        <p style={{ color: 'var(--color-rose-muted)', fontSize: 14 }}>
          This shop doesn't exist or may have moved.
        </p>
      </div>
    </div>
  )

  if (!merchant) return null

  if (merchant.status !== 'active') return (
    <div className="form-wrap mm-storefront-state">
      <div className="brand">
        <h1>BiteTime</h1>
        <p className="tagline">{merchant.name}</p>
      </div>
      <div className="admin-panel" style={{ textAlign: 'left' }}>
        <p style={{ color: 'var(--color-rose-muted)', fontSize: 14 }}>
          This shop isn't available right now.
        </p>
      </div>
    </div>
  )

  return <Storefront />
}

export default function AppRouter() {
  return (
    <SessionProvider>
      <ToastProvider>
        <AnimatedRoutes />
        <Toaster />
      </ToastProvider>
    </SessionProvider>
  )
}

function AnimatedRoutes() {
  const location = useLocation()
  return (
    <Suspense fallback={<RouteFallback />}>
      <AnimatePresence mode="wait" initial={false}>
        <PageTransition key={location.pathname}>
          <Routes location={location}>
            <Route path="/" element={<Landing />} />
            <Route path="/s/:slug/*" element={<MerchantProvider><StorefrontShell /></MerchantProvider>} />
            <Route path="/merchant/signup" element={<SignupScreen />} />
            <Route path="/merchant/login" element={<LoginScreen />} />
            <Route path="/merchant" element={<RequireRole role="merchant"><MerchantHome /></RequireRole>} />
            <Route path="/merchant/:slug" element={<RequireRole role="superadmin"><MerchantHome /></RequireRole>} />
            <Route path="/admin/merchants" element={<RequireRole role="superadmin"><AdminMerchants /></RequireRole>} />
            <Route path="/admin" element={<RequireRole role="superadmin"><AdminMerchants /></RequireRole>} />
          </Routes>
        </PageTransition>
      </AnimatePresence>
    </Suspense>
  )
}
