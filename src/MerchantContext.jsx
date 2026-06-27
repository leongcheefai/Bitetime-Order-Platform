import { createContext, useContext, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchMerchantBySlug } from './store'

const MerchantContext = createContext({ merchant: null, loading: true, notFound: false })

export function MerchantProvider({ children }) {
  const { slug } = useParams()
  const [state, setState] = useState({ merchant: null, loading: true, notFound: false })
  useEffect(() => {
    let on = true
    setState({ merchant: null, loading: true, notFound: false })
    fetchMerchantBySlug(slug).then((m) => {
      if (on) setState({ merchant: m, loading: false, notFound: !m })
    })
    return () => { on = false }
  }, [slug])
  return <MerchantContext.Provider value={state}>{children}</MerchantContext.Provider>
}

export const useMerchant = () => useContext(MerchantContext)
