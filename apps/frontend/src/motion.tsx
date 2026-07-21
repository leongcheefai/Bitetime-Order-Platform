/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'

// ── The rule this file exists to enforce ──────────────────────────────────────
//
// Motion schedules every animation on requestAnimationFrame, and a browser pauses rAF while
// a tab is hidden or its window is fully occluded. Nothing in the app may therefore depend on
// an animation running, because in a background tab none of them do. Two corollaries:
//
//   1. Nothing may WAIT for an animation to finish. `AnimatePresence mode="wait"` holds the
//      outgoing child mounted until its exit animation completes — so a route change in a
//      backgrounded tab moved the URL and left the previous screen frozen on display, and
//      stayed that way for every later navigation too. A merchant who submitted the login
//      form and switched away came back to a login form that never became a dashboard.
//      That is why no content swap in this app is wrapped in AnimatePresence, and why the
//      page variants below have no `exit` half: the outgoing view is simply replaced.
//
//   2. Nothing may DEPEND on an animation to become visible. An entry that starts at
//      opacity 0 stays at 0 for as long as the tab is hidden — a blank page, which is what a
//      storefront link opened in a background tab would have rendered. `useEnterTransition`
//      below is the seam for that: hidden at mount means no entry animation at all.
//
// Exit animations remain fine for things whose ABSENCE is the point (a toast, an overlay):
// worst case the element lingers in a tab nobody is looking at. They are never fine as a
// gate on what the app shows next.

// Subtle motion tokens — match the existing CSS feel (0.15s, cubic-bezier(0.4,0,0.2,1)).
export const DUR = { fast: 0.15, base: 0.22, slow: 0.28 } as const
export const EASE = [0.4, 0, 0.2, 1] as const

// True when motion is allowed; false under prefers-reduced-motion.
export function useMotionSafe(): boolean {
  return !useReducedMotion()
}

// Page/route/section transition: fade + small upward slide in. Distance is 0 when reduced.
// Enter only, by the rule above — pair it with `useEnterTransition`, never with an
// AnimatePresence exit.
export function usePageVariants(): Variants {
  const safe = useMotionSafe()
  const d = safe ? 8 : 0
  return {
    initial: { opacity: 0, y: d },
    animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE } },
  }
}

// Motion props for a keyed view that fades in as it mounts. Spread onto the `motion.div` that
// carries the key the swap is driven by (route path, dashboard section, storefront view).
//
// Hidden at mount means `initial: false` — motion renders the `animate` values straight away
// and animates nothing, so the content is on screen whether or not a frame ever arrives.
// Decided once, at mount, because that is the moment the choice has to be made; a tab shown
// later simply gets no entry animation, which is the right trade against a blank page.
export function useEnterTransition(variants: Variants) {
  const [animateIn] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  )
  return { variants, initial: animateIn ? 'initial' : false, animate: 'animate' } as const
}

// Backdrop / overlay: opacity only.
export function useOverlayVariants(): Variants {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: DUR.fast, ease: EASE } },
    exit: { opacity: 0, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// Floating panel / dropdown: small y + opacity.
export function usePanelVariants(): Variants {
  const safe = useMotionSafe()
  const d = safe ? 6 : 0
  return {
    initial: { opacity: 0, y: -d },
    animate: { opacity: 1, y: 0, transition: { duration: DUR.fast, ease: EASE } },
    exit: { opacity: 0, y: -d, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// List item (toasts, future list enter/exit).
export function useListItemVariants(): Variants {
  const safe = useMotionSafe()
  const d = safe ? 10 : 0
  return {
    initial: { opacity: 0, y: d },
    animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE } },
    exit: { opacity: 0, y: d, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// Wraps a route element so it fades/slides in on mount. Give it the route path as its `key`.
export function PageTransition({ children }: { children: ReactNode }) {
  const enter = useEnterTransition(usePageVariants())
  return <motion.div {...enter}>{children}</motion.div>
}
