import { useState, useEffect } from 'react'
import { fetchPlatformPricing, type PlatformPricing } from './store'

// Last-resort pricing so the marketing/signup pages always render a sensible RM
// price if the backend is slow or unavailable. Real amounts come from Stripe.
export const FALLBACK_PRICING: PlatformPricing = {
  currency: 'MYR',
  prices: {
    basic: { monthly: 9.9, yearly: 99 },
    pro: { monthly: 39.9, yearly: 399 },
  },
  estimate: null,
}

/**
 * Fetch platform pricing (always MYR) once. Forwards a `?country=` URL param
 * (local dev / QA override) to the backend for the local-currency estimate.
 * Falls back to FALLBACK_PRICING on any error so the caller can render
 * unconditionally; `loading` covers the initial fetch.
 */
export function usePlatformPricing() {
  const [pricing, setPricing] = useState<PlatformPricing>(FALLBACK_PRICING)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const country = new URLSearchParams(window.location.search).get('country') || undefined
    fetchPlatformPricing(country)
      .then((p) => { if (active) setPricing(p) })
      .catch(() => { /* keep FALLBACK_PRICING */ })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  return { pricing, loading }
}
