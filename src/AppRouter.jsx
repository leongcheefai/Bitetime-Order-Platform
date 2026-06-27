import { Routes, Route, useParams } from 'react-router-dom'
import { SessionProvider } from './SessionContext'
import { MerchantProvider, useMerchant } from './MerchantContext'
import RequireRole from './RequireRole'
import AdminMerchants from './admin/AdminMerchants'
import App from './App.jsx'
import SignupScreen from './merchant/SignupScreen'
import LoginScreen from './merchant/LoginScreen'
import MerchantHome from './merchant/MerchantHome'
import Storefront from './store/Storefront'

function StorefrontShell() {
  const { merchant, loading, notFound } = useMerchant()

  if (loading) return (
    <div className="form-wrap mm-storefront-state">
      <div className="brand">
        <h1>BiteTime</h1>
      </div>
      <p>Loading shop…</p>
    </div>
  )

  if (notFound) return (
    <div className="form-wrap mm-storefront-state">
      <div className="brand">
        <h1>BiteTime</h1>
        <p className="tagline">Shop not found</p>
      </div>
      <div className="admin-panel" style={{ textAlign: 'left' }}>
        <p style={{ color: '#7A4F55', fontSize: 14 }}>
          This shop doesn't exist or may have moved.
        </p>
      </div>
    </div>
  )

  if (merchant.status !== 'active') return (
    <div className="form-wrap mm-storefront-state">
      <div className="brand">
        <h1>BiteTime</h1>
        <p className="tagline">{merchant.name}</p>
      </div>
      <div className="admin-panel" style={{ textAlign: 'left' }}>
        <p style={{ color: '#7A4F55', fontSize: 14 }}>
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
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/s/:slug/*" element={<MerchantProvider><StorefrontShell /></MerchantProvider>} />
        <Route path="/merchant/signup" element={<SignupScreen />} />
        <Route path="/merchant/login" element={<LoginScreen />} />
        <Route path="/merchant" element={<RequireRole role="merchant"><MerchantHome /></RequireRole>} />
        <Route path="/admin/merchants" element={<RequireRole role="superadmin"><AdminMerchants /></RequireRole>} />
        <Route path="/admin" element={<RequireRole role="superadmin"><AdminMerchants /></RequireRole>} />
      </Routes>
    </SessionProvider>
  )
}
