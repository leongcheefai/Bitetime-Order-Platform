import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { fetchMerchantBySlug } from './store'
import type { MerchantState } from './types'

const MerchantContext = createContext<MerchantState>({ merchant: null, loading: true, notFound: false })

export function MerchantProvider({ children }: { children: ReactNode }) {
  const { slug } = useParams()
  const [state, setState] = useState<MerchantState>({ slug: null, merchant: null, loading: true, notFound: false })
  useEffect(() => {
    let on = true
    fetchMerchantBySlug(slug).then((m) => {
      if (on) setState({ slug, merchant: m, loading: false, notFound: !m })
    })
    return () => { on = false }
  }, [slug])
  // Show loading until the fetch for the *current* slug resolves (avoids a
  // synchronous setState reset in the effect body).
  const current = state.slug === slug ? state : { merchant: null, loading: true, notFound: false }
  return <MerchantContext.Provider value={current}>{children}</MerchantContext.Provider>
}

// Hook colocated with its provider by design; fast-refresh limitation only affects
// HMR of this file, not runtime.
// eslint-disable-next-line react-refresh/only-export-components
export const useMerchant = () => useContext(MerchantContext)
