import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { lookupMerchantBySlug } from './store'
import type { MerchantState } from './types'

const MerchantContext = createContext<MerchantState>({ merchant: null, loading: true, notFound: false, refresh: async () => {} })

// The fetched half of MerchantState, minus `refresh` — `refresh` is a function of the
// Provider's `slug` closure, not a stored value, so it is added once at the bottom rather than
// carried through every `setState`.
type FetchedState = Omit<MerchantState, 'refresh'>

export function MerchantProvider({ children }: { children: ReactNode }) {
  const { slug } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<FetchedState>({ slug: null, merchant: null, loading: true, notFound: false })
  useEffect(() => {
    let on = true
    lookupMerchantBySlug(slug).then((r) => {
      // Initial load: collapse could-not-ask to "not found" here (parity with the old
      // fetchMerchantBySlug). The recovery path below is the one that must NOT collapse.
      const m = r.ok ? r.data : null
      // A retired slug answers { moved_to } (#253). Full-page loads are 301'd by the edge
      // function before React ever boots; this branch covers the paths that skip it — local
      // dev, and a stale in-app link. The answer is a pointer, not a merchant row: adopting it
      // would hand Storefront an object with no name to render.
      if (m?.moved_to) {
        if (on) navigate(`/s/${m.moved_to}`, { replace: true })
        return
      }
      if (on) setState({ slug, merchant: m, loading: false, notFound: !m })
    })
    return () => { on = false }
  }, [slug, navigate])

  // Re-read the CURRENT slug's merchant row without touching `loading`/`notFound` — the recovery
  // path for a `price_changed` refusal, called alongside the products/voucher/clock refresh in
  // Storefront's `refreshQuoteSources`. Tax, shipping and config all live on this row, and none
  // of them were being refreshed before this existed, so a merchant who changed any of them
  // while a customer had the page open produced the exact same refusal loop `refreshQuoteSources`
  // exists to close for the voucher and the clock.
  //
  // Same rule as every other fetch in that recovery path: an answer we could not get changes
  // NOTHING. `lookupMerchantBySlug` distinguishes "could not ask" (`{ok:false}` — network/CORS/
  // 5xx) from a real answer, and only a real, non-null merchant is adopted here. A dropped
  // packet must never blank an already-loaded storefront — every consumer of `merchant` reads
  // `merchant.name`/`merchant.config`/etc. unconditionally (see the `NonNullable` cast in
  // Storefront), so setting it to `null` mid-session would crash the render, not just show stale
  // data. `slug` is read fresh from the closure on each call, and the state update is guarded by
  // slug so a refresh that resolves after the customer has navigated to a different shop cannot
  // clobber it.
  const refresh = useCallback(async () => {
    const found = await lookupMerchantBySlug(slug)
    // `moved_to` (#253) is excluded for the same reason as null: it is not a merchant row, and
    // adopting it mid-session would crash every consumer that reads merchant.name.
    if (found.ok && found.data && !found.data.moved_to) {
      setState(s => (s.slug === slug ? { ...s, merchant: found.data, notFound: false } : s))
    }
  }, [slug])

  // Show loading until the fetch for the *current* slug resolves (avoids a
  // synchronous setState reset in the effect body).
  // Memoised: a spread literal per render is a new object per render, which re-rendered every
  // `useMerchant()` consumer on the storefront each time this provider did.
  const value = useMemo<MerchantState>(() => {
    const current = state.slug === slug ? state : { merchant: null, loading: true, notFound: false }
    return { ...current, refresh }
  }, [state, slug, refresh])
  return <MerchantContext.Provider value={value}>{children}</MerchantContext.Provider>
}

// Hook colocated with its provider by design; fast-refresh limitation only affects
// HMR of this file, not runtime.
// eslint-disable-next-line react-refresh/only-export-components
export const useMerchant = () => useContext(MerchantContext)
