import { useCallback, useState } from 'react'
import { dashboardHash, parseDashboardHash } from './dashboardHash'

// Both hooks own one URL, so they write it the same way — the section hook clearing any
// sub-tab, the sub-tab hook preserving its section.
function writeHash(section: string, sub?: string) {
  window.history.replaceState(
    null, '', `${window.location.pathname}${window.location.search}${dashboardHash(section, sub)}`,
  )
}

// Persist the active dashboard section in the URL hash so a page refresh keeps
// the current section instead of resetting to the default. Not a router change —
// the hash is validated against the known section keys, falling back to `fallback`
// for an empty or unknown hash. Shared by the merchant and admin dashboards.
//
// The hash carries a second, optional segment for a section's sub-tab
// (`#settings/subscription`) — see useDashboardSubsection. This hook reads and writes only the
// FIRST segment; without that split, `#settings/subscription` would fail the `keys.includes`
// check here and drop the merchant on Overview.
export function useDashboardSection(
  keys: string[],
  fallback: string,
): [string, (key: string, sub?: string) => void] {
  const [section, setSectionState] = useState<string>(() => {
    const { section } = parseDashboardHash(window.location.hash)
    return keys.includes(section) ? section : fallback
  })

  // `sub` is for callers that know where inside the section they are going — the Pro upgrade
  // CTA aiming at `#settings/subscription`. Omitted, any existing sub-tab is dropped: switching
  // section makes the old section's sub-tab meaningless, and carrying it over would write
  // `#orders/shipping`.
  const setSection = useCallback((key: string, sub?: string) => {
    setSectionState(key)
    writeHash(key, sub)
  }, [])

  return [section, setSection]
}

/**
 * The same trick one level down: a section's sub-tab, in the hash's second segment.
 *
 * Added so the Pro upgrade CTA can link at a specific settings tab (#112), but it also fixes an
 * older annoyance — before this, every settings sub-tab reset to Shipping on refresh, silently,
 * mid-edit.
 *
 * The caller decides WHEN a change is allowed: `ShopSettings` routes tab switches through
 * NavGuard, so a dirty form still blocks navigation. This hook only remembers.
 */
export function useDashboardSubsection<K extends string>(
  section: string,
  keys: readonly K[],
  fallback: K,
): [K, (key: K) => void] {
  const [sub, setSubState] = useState<K>(() => {
    const parsed = parseDashboardHash(window.location.hash)
    const found = keys.find(k => k === parsed.sub)
    return parsed.section === section && found ? found : fallback
  })

  const setSub = useCallback((key: K) => {
    setSubState(key)
    writeHash(section, key)
  }, [section])

  return [sub, setSub]
}
