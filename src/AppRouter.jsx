import { Routes, Route, useParams } from 'react-router-dom'
import { SessionProvider } from './SessionContext'
import { MerchantProvider, useMerchant } from './MerchantContext'
import RequireRole from './RequireRole'
import App from './App.jsx'

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
        <Route path="/merchant/*" element={<RequireRole role="merchant"><div style={{ padding: 24 }}>Merchant dashboard (P2/P4)</div></RequireRole>} />
        <Route path="/admin/*" element={<RequireRole role="superadmin"><div style={{ padding: 24 }}>Admin (P3)</div></RequireRole>} />
      </Routes>
    </SessionProvider>
  )
}
