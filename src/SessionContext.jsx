import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { onAuthChange, fetchProfileByUserId } from './store'

// TODO(P3): remove this transitional fallback once superadmin role is seeded in DB.
const USER_EMAIL = 'bitetimeandco@gmail.com'

const SessionContext = createContext(null)

export function SessionProvider({ children }) {
  const [account, setAccount] = useState(undefined)
  const [profile, setProfile] = useState(null)
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
    })
    return unsubscribe
  }, [loadProfile])

  const role = profile?.app_role
    ?? (account?.email === USER_EMAIL ? 'superadmin' : 'customer')

  const t = (en, zh) => (lang === 'zh' ? zh : en)
  const refreshProfile = () => loadProfile(account)

  const value = { account, profile, role, loading: account === undefined, lang, setLang, t, refreshProfile }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
