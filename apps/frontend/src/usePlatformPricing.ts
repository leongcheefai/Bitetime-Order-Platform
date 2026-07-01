import { useState, useEffect } from 'react'
import { fetchPlatformPricing, type PlatformPricing } from './store'

// Last-resort pricing so the marketing/signup pages always render a sensible
// price if the backend is slow or unavailable. Mirrors the USD default tier.
export const FALLBACK_PRICING: PlatformPricing = {
  region: 'US',
  currency: 'USD',
  prices: {
    basic: { monthly: 9.99, yearly: 99.9 },
    pro: { monthly: 39.99, yearly: 399.9 },
  },
}

/**
 * Fetch region-resolved platform pricing once. Forwards a `?country=` URL param
 * (local dev / QA override) to the backend. Falls back to USD on any error so the
 * caller can render unconditionally; `loading` covers the initial fetch.
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
