import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { onAuthChange, fetchProfileByUserId, fetchMyMerchant, fetchMerchantBySlug, getCurrentUser } from './store'
import type { Lang, Merchant, Profile, Role, SessionValue } from './types'

// TODO(P3): remove this transitional fallback once superadmin role is seeded in DB.
const USER_EMAIL = 'bitetime@praxor.dev'

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<User | null | undefined>(undefined)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [ownMerchant, setOwnMerchant] = useState<Merchant | null>(null)
  const [merchantLoaded, setMerchantLoaded] = useState(false)
  // Superadmin "view as shop": when set, the dashboard subtree reads this merchant
  // instead of the signed-in user's own. RLS already grants is_superadmin() full access.
  const [impersonatedMerchant, setImpersonatedMerchant] = useState<Merchant | null>(null)
  const [lang, setLang] = useState<Lang>('en')

  const loadProfile = useCallback(async (user: User | null) => {
    if (!user) { setProfile(null); return }
    try { setProfile(await fetchProfileByUserId(user.id)) }
    catch { setProfile(null) }
  }, [])

  useEffect(() => {
    const unsubscribe = onAuthChange((user) => {
      setAccount(user ?? null)
      loadProfile(user)
      if (user) fetchMyMerchant(user.id).then(m => { setOwnMerchant(m); setMerchantLoaded(true) })
      else { setOwnMerchant(null); setMerchantLoaded(true) }
    })
    return unsubscribe
  }, [loadProfile])

  const isSuper = profile?.app_role === 'superadmin' || account?.email === USER_EMAIL // TODO(P3): drop email fallback
  const role: Role = isSuper ? 'superadmin' : (ownMerchant ? 'merchant' : 'customer')

  // The active merchant the dashboard operates on: an impersonated shop wins over own.
  const merchant = impersonatedMerchant ?? ownMerchant

  const impersonate = useCallback(async (slug: string) => {
    const m = await fetchMerchantBySlug(slug)
    setImpersonatedMerchant(m)
    return m
  }, [])
  const stopImpersonating = useCallback(() => setImpersonatedMerchant(null), [])

  const t = (en: string, zh?: string) => (lang === 'zh' ? (zh ?? en) : en)
  const refreshProfile = () => loadProfile(account ?? null)
  // Resolve the user freshly rather than closing over `account`, which is stale
  // immediately after signup/login (the just-signed-in user isn't in this render yet).
  const refreshMerchant = async () => {
    // While impersonating, refresh the viewed shop — never clobber it with own merchant.
    if (impersonatedMerchant) {
      setImpersonatedMerchant(await fetchMerchantBySlug(impersonatedMerchant.slug))
      return
    }
    const user = await getCurrentUser()
    if (!user) { setOwnMerchant(null); setMerchantLoaded(true); return }
    const m = await fetchMyMerchant(user.id)
    setOwnMerchant(m); setMerchantLoaded(true)
  }

  const value: SessionValue = { account, profile, role, merchant, ownMerchant, impersonating: !!impersonatedMerchant, impersonate, stopImpersonating, loading: account === undefined || !merchantLoaded, lang, setLang, t, refreshProfile, refreshMerchant }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

// Hook colocated with its provider by design; fast-refresh limitation only affects
// HMR of this file, not runtime.
// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
