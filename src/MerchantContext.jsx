import { createContext, useContext, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchMerchantBySlug } from './store'

const MerchantContext = createContext({ merchant: null, loading: true, notFound: false })

export function MerchantProvider({ children }) {
  const { slug } = useParams()
  const [state, setState] = useState({ slug: null, merchant: null, loading: true, notFound: false })
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

export const useMerchant = () => useContext(MerchantContext)
