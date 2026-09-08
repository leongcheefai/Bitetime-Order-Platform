import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import type { User } from '@supabase/auth-js'
import { onAuthChange, fetchProfileByUserId, lookupMyMerchant, lookupMerchantBySlug, getCurrentUser } from './store'
import { ensureCjkFont } from './cjkFont'
import type { Lang, Merchant, Profile, Role, SessionValue } from './types'

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<User | null | undefined>(undefined)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [ownMerchant, setOwnMerchant] = useState<Merchant | null>(null)
  const [merchantLoaded, setMerchantLoaded] = useState(false)
  // True when the last shop lookup never landed (backend down, CORS, 5xx). Distinct from
  // `ownMerchant === null`, which is the real answer "this user owns no shop". Consumers that
  // would otherwise TURN A USER AWAY on that null must check this first — see RequireRole.
  const [merchantUnknown, setMerchantUnknown] = useState(false)
  // Superadmin "view as shop": when set, the dashboard subtree reads this merchant
  // instead of the signed-in user's own. RLS already grants is_superadmin() full access.
  const [impersonatedMerchant, setImpersonatedMerchant] = useState<Merchant | null>(null)
  const [lang, setLang] = useState<Lang>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('lang') : null
    return stored === 'zh' || stored === 'en' ? stored : 'en'
  })
  useEffect(() => { try { localStorage.setItem('lang', lang) } catch { /* storage unavailable */ } }, [lang])
  // The two things outside React that have to agree with `lang`. `<html lang>` is what a screen
  // reader picks a voice from and what a crawler reads the page as; it is baked `en` in index.html
  // and would otherwise stay `en` on a fully Chinese page. The CJK webfont is fetched here rather
  // than from index.html so an English visitor never pays for it — see cjkFont.ts.
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh' : 'en'
    ensureCjkFont(lang)
  }, [lang])

  // `profileLoaded` is not bookkeeping: `role` reads app_role off this row, so until it lands a
  // superadmin is indistinguishable from a customer. It must gate `loading` alongside the shop
  // lookup — on a hard refresh the (usually faster) shop lookup would otherwise end the loading
  // state on its own, and RequireRole would bounce a superadmin off /admin to the landing page.
  const loadProfile = useCallback(async (user: User | null) => {
    if (!user) { setProfile(null); setProfileLoaded(true); return }
    const r = await fetchProfileByUserId(user.id)
    setProfile(r.ok ? r.data : null)
    setProfileLoaded(true)
  }, [])

  // The one seam that reads the signed-in user's own shop. A lookup that never landed leaves
  // `ownMerchant` null AND raises `merchantUnknown` — never silently reads as "owns no shop".
  const loadOwnMerchant = useCallback(async (userId: string | null | undefined) => {
    if (!userId) { setOwnMerchant(null); setMerchantUnknown(false); setMerchantLoaded(true); return }
    const found = await lookupMyMerchant(userId)
    setOwnMerchant(found.ok ? found.data : null)
    setMerchantUnknown(!found.ok)
    setMerchantLoaded(true)
  }, [])

  useEffect(() => {
    const unsubscribe = onAuthChange((user) => {
      setAccount(user ?? null)
      loadProfile(user)
      loadOwnMerchant(user?.id)
    })
    return unsubscribe
  }, [loadProfile, loadOwnMerchant])

  // The DB role alone — see the note on isSuperadmin in the backend's mw.ts. This side only
  // decides what to RENDER; the backend gate is what actually protects the data, and the two
  // are kept identical so the console never offers a screen its own requests will 403.
  const isSuper = profile?.app_role === 'superadmin'
  const role: Role = isSuper ? 'superadmin' : (ownMerchant ? 'merchant' : 'customer')

  // The active merchant the dashboard operates on: an impersonated shop wins over own.
  const merchant = impersonatedMerchant ?? ownMerchant

  const impersonate = useCallback(async (slug: string) => {
    const r = await lookupMerchantBySlug(slug)
    const m = r.ok ? r.data : null
    setImpersonatedMerchant(m)
    return m
  }, [])
  const stopImpersonating = useCallback(() => setImpersonatedMerchant(null), [])

  // Stable identities, and the value memoised over them: this provider sits above every
  // screen, and a fresh `value` object per render re-rendered every `useSession()` consumer
  // on any state change — while a fresh `t` closure defeated every `memo()` it was passed to
  // (the landing hero's animated preview re-rendered on each tick for exactly that reason).
  const t = useCallback((en: string, zh?: string) => (lang === 'zh' ? (zh ?? en) : en), [lang])
  const refreshProfile = useCallback(() => loadProfile(account ?? null), [loadProfile, account])
  // Resolve the user freshly rather than closing over `account`, which is stale
  // immediately after signup/login (the just-signed-in user isn't in this render yet).
  const refreshMerchant = useCallback(async () => {
    // While impersonating, refresh the viewed shop — never clobber it with own merchant, and
    // never blank it on a could-not-ask (a dropped packet keeps the current shop).
    if (impersonatedMerchant) {
      const r = await lookupMerchantBySlug(impersonatedMerchant.slug)
      if (r.ok) setImpersonatedMerchant(r.data)
      return
    }
    const user = await getCurrentUser()
    await loadOwnMerchant(user?.id)
  }, [impersonatedMerchant, loadOwnMerchant])

  const loading = account === undefined || !profileLoaded || !merchantLoaded
  const impersonating = !!impersonatedMerchant
  const value: SessionValue = useMemo(
    () => ({ account, profile, role, merchant, ownMerchant, merchantUnknown, impersonating, impersonate, stopImpersonating, loading, lang, setLang, t, refreshProfile, refreshMerchant }),
    [account, profile, role, merchant, ownMerchant, merchantUnknown, impersonating, impersonate, stopImpersonating, loading, lang, t, refreshProfile, refreshMerchant],
  )
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
