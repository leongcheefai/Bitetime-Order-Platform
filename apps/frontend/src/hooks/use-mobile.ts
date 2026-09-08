import { useSyncExternalStore } from "react"

// shadcn's own breakpoint for the sidebar: below it the rail becomes a sheet.
const MOBILE_BREAKPOINT = 768

const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(query)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

const getSnapshot = () => window.matchMedia(query).matches
// The prerender (`scripts/prerender.tsx`) renders these screens with no window; a rail is the
// desktop answer there, as it is for the first client frame before the media query is read.
const getServerSnapshot = () => false

/**
 * Whether the viewport is under shadcn's mobile breakpoint. Read as an external store rather
 * than mirrored into state from an effect — the generated hook did the latter and set state
 * synchronously inside the effect, which the react-hooks lint refuses.
 */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
