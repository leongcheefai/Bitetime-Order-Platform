import { useCallback, useState } from 'react'

// Persist the active dashboard section in the URL hash so a page refresh keeps
// the current section instead of resetting to the default. Not a router change —
// the hash is validated against the known section keys, falling back to `fallback`
// for an empty or unknown hash. Shared by the merchant and admin dashboards.
export function useDashboardSection(keys: string[], fallback: string): [string, (key: string) => void] {
  const [section, setSectionState] = useState<string>(() => {
    const hash = window.location.hash.slice(1)
    return keys.includes(hash) ? hash : fallback
  })

  const setSection = useCallback((key: string) => {
    setSectionState(key)
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${key}`)
  }, [])

  return [section, setSection]
}
