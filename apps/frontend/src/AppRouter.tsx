import { lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'motion/react'
import { PageTransition } from './motion'
import { SessionProvider } from './SessionContext'
import { Toaster } from './components/ui/sonner'
import { MerchantProvider, useMerchant } from './MerchantContext'
import RequireRole from './RequireRole'
import { Spinner } from './components/Loaders'

// Route-level code splitting: each surface ships its own chunk, so a storefront
// customer never downloads merchant/admin/signup code (signup pulls in the heavy
// pinyin-pro dictionary — kept out of the customer path).
const AdminHome = lazy(() => import('./admin/AdminHome'))
const Landing = lazy(() => import('./marketing/Landing'))
const SignupScreen = lazy(() => import('./merchant/SignupScreen'))
const LoginScreen = lazy(() => import('./merchant/LoginScreen'))
const MerchantHome = lazy(() => import('./merchant/MerchantHome'))
const Storefront = lazy(() => import('./store/Storefront'))

function RouteFallback() {
  return (
    <div className="w-full min-h-[50vh] flex items-center justify-center">
      <Spinner label="Loading…" />
    </div>
  )
}

function StorefrontShell() {
  const { merchant, loading, notFound } = useMerchant()

  if (loading) return (
    <div className="w-full min-h-[50vh] flex items-center justify-center">
      <Spinner label="Loading shop…" />
    </div>
  )

  if (notFound) return (
    <div className="form-wrap text-center pt-8 pb-12">
      <div className="text-center mb-10">
        <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">BiteTime</h1>
        <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">Shop not found</p>
      </div>
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border text-left">
        <p className="text-rose-muted text-[14px] leading-[1.6] mt-1.5">
          This shop doesn't exist or may have moved.
        </p>
      </div>
    </div>
  )

  if (!merchant) return null

  if (merchant.status !== 'active') return (
    <div className="form-wrap text-center pt-8 pb-12">
      <div className="text-center mb-10">
        <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">BiteTime</h1>
        <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">{merchant.name}</p>
      </div>
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border text-left">
        <p className="text-rose-muted text-[14px] leading-[1.6] mt-1.5">
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
      <AnimatedRoutes />
      <Toaster position="bottom-center" />
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
            <Route path="/admin/merchants" element={<RequireRole role="superadmin"><AdminHome /></RequireRole>} />
            <Route path="/admin" element={<RequireRole role="superadmin"><AdminHome /></RequireRole>} />
          </Routes>
        </PageTransition>
      </AnimatePresence>
    </Suspense>
  )
}
