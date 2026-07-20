import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { fetchMerchantBySlug, lookupMerchantBySlug } from './store'
import type { MerchantState } from './types'

const MerchantContext = createContext<MerchantState>({ merchant: null, loading: true, notFound: false, refresh: async () => {} })

// The fetched half of MerchantState, minus `refresh` — `refresh` is a function of the
// Provider's `slug` closure, not a stored value, so it is added once at the bottom rather than
// carried through every `setState`.
type FetchedState = Omit<MerchantState, 'refresh'>

export function MerchantProvider({ children }: { children: ReactNode }) {
  const { slug } = useParams()
  const [state, setState] = useState<FetchedState>({ slug: null, merchant: null, loading: true, notFound: false })
  useEffect(() => {
    let on = true
    fetchMerchantBySlug(slug).then((m) => {
      if (on) setState({ slug, merchant: m, loading: false, notFound: !m })
    })
    return () => { on = false }
  }, [slug])

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
    if (found.ok && found.merchant) {
      setState(s => (s.slug === slug ? { ...s, merchant: found.merchant, notFound: false } : s))
    }
  }, [slug])

  // Show loading until the fetch for the *current* slug resolves (avoids a
  // synchronous setState reset in the effect body).
  const current = state.slug === slug ? state : { merchant: null, loading: true, notFound: false }
  return <MerchantContext.Provider value={{ ...current, refresh }}>{children}</MerchantContext.Provider>
}

// Hook colocated with its provider by design; fast-refresh limitation only affects
// HMR of this file, not runtime.
// eslint-disable-next-line react-refresh/only-export-components
export const useMerchant = () => useContext(MerchantContext)
