import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from './SessionContext'
import type { Role } from './types'
import { Spinner } from './components/Loaders'

export default function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { role: current, loading } = useSession()
  if (loading) return <div style={{ padding: 24 }}><Spinner label="Loading…" /></div>
  if (current === 'superadmin') return children
  if (current !== role) return <Navigate to="/" replace />
  return children
}
