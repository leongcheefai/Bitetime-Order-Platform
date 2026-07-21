/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useReducedMotion } from 'motion/react'
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
//   2. Nothing may DEPEND on an animation to become visible — which is why the route/section
//      entry is not a Motion animation at all. It is the `.page-enter` CSS keyframe in
//      `index.css`, attached by `useEnterTransition` below.
//      A JS `initial: { opacity: 0 }` is a STYLE the element keeps until an animation arrives
//      to clear it, so every way an animation can fail to arrive is a blank page. A paused rAF
//      is only the most obvious one: React hides a tree that suspends AFTER mount with
//      `display: none !important` and destroys its layout effects, and on reveal Motion
//      re-applied `initial` and never re-animated, because the `animate` target had not
//      changed. That stranded the storefront at `opacity: 0` with its whole DOM built —
//      every time the lazy route chunk landed after the shell had swapped in its content,
//      which on a cold cache is every time.
//      A CSS keyframe inverts the failure: the resting style IS the final state and the
//      keyframe only borrows it on the way in, so an animation that never runs — or gets torn
//      down halfway — leaves the content on screen.
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

// Props for a keyed view that fades and slides in as it mounts: put them on the plain `div`
// that carries the key the swap is driven by (route path, dashboard section, storefront view),
// merging `className` if the element already has one. A changed key replaces the element, which
// is what restarts the keyframe.
//
// Hidden at mount means no class at all. Not because a blank page is possible any more — the
// keyframe's resting state is the final one — but because a fade nobody can see is a fade worth
// skipping, and the element should not be mid-animation when the tab is first looked at.
// Decided once, at mount: a tab shown later simply gets no entry animation.
export function useEnterTransition() {
  const [animateIn] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  )
  return { className: animateIn ? 'page-enter' : undefined } as const
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
  return <div {...useEnterTransition()}>{children}</div>
}
