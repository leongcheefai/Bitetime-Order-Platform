import { Routes, Route, useParams } from 'react-router-dom'
import { SessionProvider } from './SessionContext'
import { MerchantProvider, useMerchant } from './MerchantContext'
import RequireRole from './RequireRole'
import AdminMerchants from './admin/AdminMerchants'
import App from './App.jsx'
import SignupScreen from './merchant/SignupScreen'
import LoginScreen from './merchant/LoginScreen'
import MerchantHome from './merchant/MerchantHome'

function StorefrontShell() {
  const { merchant, loading, notFound } = useMerchant()
  if (loading) return <div style={{ padding: 24 }}>Loading shop…</div>
  if (notFound) return <div style={{ padding: 24 }}>Shop not found.</div>
  return <div style={{ padding: 24 }}>Storefront for <b>{merchant.name}</b> (coming in P5)</div>
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
