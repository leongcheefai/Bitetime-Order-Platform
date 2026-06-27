import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { onAuthChange, fetchProfileByUserId, fetchMyMerchant } from './store'

// TODO(P3): remove this transitional fallback once superadmin role is seeded in DB.
const USER_EMAIL = 'bitetimeandco@gmail.com'

const SessionContext = createContext(null)

export function SessionProvider({ children }) {
  const [account, setAccount] = useState(undefined)
  const [profile, setProfile] = useState(null)
  const [merchant, setMerchant] = useState(null)
  const [merchantLoaded, setMerchantLoaded] = useState(false)
  const [lang, setLang] = useState('en')

  const loadProfile = useCallback(async (user) => {
    if (!user) { setProfile(null); return }
    try { setProfile(await fetchProfileByUserId(user.id)) }
    catch { setProfile(null) }
  }, [])

  useEffect(() => {
    const unsubscribe = onAuthChange((user) => {
      setAccount(user ?? null)
      loadProfile(user)
      if (user) fetchMyMerchant(user.id).then(m => { setMerchant(m); setMerchantLoaded(true) })
      else { setMerchant(null); setMerchantLoaded(true) }
    })
    return unsubscribe
  }, [loadProfile])

  const isSuper = profile?.app_role === 'superadmin' || account?.email === USER_EMAIL // TODO(P3): drop email fallback
  const role = isSuper ? 'superadmin' : (merchant ? 'merchant' : 'customer')

  const t = (en, zh) => (lang === 'zh' ? zh : en)
  const refreshProfile = () => loadProfile(account)
  const refreshMerchant = () => account && fetchMyMerchant(account.id).then(setMerchant)

  const value = { account, profile, role, merchant, loading: account === undefined || !merchantLoaded, lang, setLang, t, refreshProfile, refreshMerchant }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
